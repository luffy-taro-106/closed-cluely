'use strict';

const { randomUUID } = require('node:crypto');
const { SAMPLE_RATE, createSegmenter, flushSegments, rms } = require('./segmenter');

const SOURCES = ['me', 'them'];
const MAX_MANUAL_SECONDS = 30 * 60;
const MIN_SEGMENT_SECONDS = 0.35;
const MAX_TRANSCRIPT_ENTRIES = 2000;
const MAX_TRANSCRIPT_CHARS = 200000;
// Phrases Whisper-family models produce from silence or noise.
const HALLUCINATIONS = /^(\[?(blank_audio|silence|music|inaudible|no speech)\]?|\(.*\)|thank you\.?|thanks for watching!?|thank you for watching\.?|you\.?|bye\.?|\.+|okay\.?)$/i;

function cleanText(text, seconds) {
  const value = String(text || '').replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (seconds < 2.5 && HALLUCINATIONS.test(value)) return '';
  return value;
}

function transcriptText(entries, maxChars = 16000) {
  const lines = [];
  let length = 0;
  // Speaker labels only matter when both sides were recorded.
  const labelled = entries.some(entry => entry.source === 'me');
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = labelled ? `${entries[i].source === 'me' ? 'Me' : 'Them'}: ${entries[i].text}` : entries[i].text;
    if (length + line.length > maxChars) break;
    lines.unshift(line); length += line.length + 1;
  }
  return lines.join('\n');
}

class Listener {
  constructor({ settings, segmenterOptions, transcribe, onChange = () => {}, onEntry = () => {}, onTurn = () => {}, onError = () => {} }) {
    this.settings = settings; this.segmenterOptions = segmenterOptions; this.transcribeFn = transcribe;
    this.onChange = onChange; this.onEntry = onEntry; this.onTurn = onTurn; this.onError = onError;
    this.listening = false; this.mode = 'manual'; this.engine = '';
    this.sources = {}; this.entries = []; this.queue = Promise.resolve(); this.pending = 0; this.epoch = 0;
    this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    this.levelTimer = null;
  }
  publicState() {
    return { listening: this.listening, mode: this.mode, engine: this.engine, pending: this.pending,
      levels: this.levels, speaking: this.speaking,
      sources: Object.fromEntries(SOURCES.map(source => [source, !!this.sources[source]])),
      manualSeconds: this.listening && this.mode === 'manual' ? Math.round(Math.max(...SOURCES.map(source => this.sources[source]?.manualLength || 0)) / SAMPLE_RATE) : 0 };
  }
  restore(entries) {
    this.entries = Array.isArray(entries) ? entries.filter(entry => entry && SOURCES.includes(entry.source) && typeof entry.text === 'string' && typeof entry.id === 'string')
      .slice(-MAX_TRANSCRIPT_ENTRIES).map(({ id, source, text, at }) => ({ id, source, text: text.slice(0, 4000), at: typeof at === 'string' ? at : '' })) : [];
  }
  clear() { this.entries = []; this.epoch++; this.onChange(); }
  text(maxChars) { return transcriptText(this.entries, maxChars); }
  start({ mode, sources }) {
    if (this.listening) throw new Error('Listening has already started.');
    if (!['manual', 'auto'].includes(mode)) throw new Error('Choose manual or automatic listening.');
    const enabled = SOURCES.filter(source => sources.includes(source));
    if (!enabled.length) throw new Error('Choose at least one audio source in Listening settings.');
    this.mode = mode; this.sources = {};
    for (const source of enabled) {
      const created = mode === 'auto' ? createSegmenter(this.segmenterOptions()) : { segmenter: null, engine: '' };
      this.engine = created.engine || this.engine;
      this.sources[source] = { segmenter: created.segmenter, manual: [], manualLength: 0 };
    }
    if (mode === 'manual') this.engine = '';
    this.listening = true; this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => this.onChange(), 250);
    this.onChange();
  }
  feed(source, samples) {
    const state = this.sources[source];
    if (!this.listening || !state || !(samples instanceof Float32Array) || !samples.length) return;
    this.levels[source] = Math.min(1, rms(samples, 0, samples.length) * 6);
    if (this.mode === 'manual') {
      if (state.manualLength + samples.length > MAX_MANUAL_SECONDS * SAMPLE_RATE) { void this.stop(); this.onError('Manual recording reached 30 minutes and was stopped. Its audio is being transcribed.'); return; }
      state.manual.push(samples); state.manualLength += samples.length;
      return;
    }
    let segments;
    try { segments = state.segmenter.accept(samples); }
    catch { this.onError('Voice detection failed. Listening stopped.'); void this.stop(); return; }
    this.speaking[source] = !!state.segmenter.active;
    for (const segment of segments) this.enqueue(source, segment);
  }
  async stop() {
    if (!this.listening) return;
    this.listening = false; clearInterval(this.levelTimer); this.levelTimer = null;
    const sources = this.sources; this.sources = {};
    for (const [source, state] of Object.entries(sources)) {
      if (this.mode === 'auto') { for (const segment of flushSegments(state.segmenter)) this.enqueue(source, segment); continue; }
      // Manual mode: split the recording at pauses so each piece stays within
      // provider limits and local model windows.
      const audio = new Float32Array(state.manualLength);
      let at = 0; for (const chunk of state.manual) { audio.set(chunk, at); at += chunk.length; }
      state.manual = [];
      const { segmenter } = createSegmenter({ ...this.segmenterOptions(), endSilenceMs: 500, maxSpeechMs: 25000 });
      const segments = [];
      for (let offset = 0; offset < audio.length; offset += SAMPLE_RATE) segments.push(...segmenter.accept(audio.subarray(offset, Math.min(audio.length, offset + SAMPLE_RATE))));
      segments.push(...flushSegments(segmenter));
      // Quiet speech the detector rejected is still worth a transcription attempt.
      if (!segments.length && audio.length >= SAMPLE_RATE && rms(audio, 0, audio.length) > 0.002) {
        for (let offset = 0; offset < audio.length; offset += 25 * SAMPLE_RATE) segments.push({ samples: audio.slice(offset, Math.min(audio.length, offset + 25 * SAMPLE_RATE)), endedTurn: false });
      }
      segments.forEach((segment, index) => this.enqueue(source, { ...segment, endedTurn: index === segments.length - 1 }));
    }
    this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    this.onChange();
  }
  enqueue(source, segment) {
    const seconds = segment.samples.length / SAMPLE_RATE;
    if (seconds < MIN_SEGMENT_SECONDS) { if (segment.endedTurn && source === 'them') this.onTurn(source); return; }
    const epoch = this.epoch, at = new Date().toISOString();
    this.pending++; this.onChange();
    this.queue = this.queue.then(async () => {
      try {
        const text = cleanText(await this.transcribeFn(source, segment.samples, transcriptText(this.entries, 600)), seconds);
        if (epoch !== this.epoch) return;
        if (text) {
          const entry = { id: randomUUID(), source, text, at };
          this.entries.push(entry);
          while (this.entries.length > MAX_TRANSCRIPT_ENTRIES || this.entries.reduce((sum, item) => sum + item.text.length, 0) > MAX_TRANSCRIPT_CHARS) this.entries.shift();
          this.onEntry(entry);
        }
        if (segment.endedTurn && epoch === this.epoch) this.onTurn(source, text);
      } catch (error) { this.onError(error.message || 'Transcription failed.'); }
      finally { this.pending--; this.onChange(); }
    });
  }
  idle() { return this.queue; }
}

module.exports = { SOURCES, Listener, transcriptText, cleanText };
