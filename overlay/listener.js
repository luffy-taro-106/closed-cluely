'use strict';

const { randomUUID } = require('node:crypto');
const { SAMPLE_RATE, createSegmenter, flushSegments, rms } = require('./segmenter');

const { RecordingSegmenter } = require('./recording-segmenter');

const SOURCES = ['me', 'them'];
const MAX_MANUAL_SECONDS = 30 * 60;
const MIN_SEGMENT_SECONDS = 0.1;
const MAX_TRANSCRIPT_ENTRIES = 2000;
const MAX_TRANSCRIPT_CHARS = 200000;
// Remove explicit non-speech markers, never legitimate short replies such as "Thank you".
const HALLUCINATIONS = /^(\[?(blank_audio|silence|music|inaudible|no speech)\]?|\(.*\)|\.+)$/i;

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
    const remaining = maxChars - length - (lines.length ? 1 : 0);
    if (remaining <= 0) break;
    const included = line.length > remaining ? line.slice(-remaining) : line;
    lines.unshift(included); length += included.length + (lines.length > 1 ? 1 : 0);
    if (included.length < line.length) break;
  }
  return lines.join('\n');
}

class Listener {
  constructor({ settings, segmenterOptions, transcribe, onChange = () => {}, onEntry = () => {}, onTurn = () => {}, onError = () => {}, onStop = () => {} }) {
    this.settings = settings; this.segmenterOptions = segmenterOptions; this.transcribeFn = transcribe;
    this.onChange = onChange; this.onEntry = onEntry; this.onTurn = onTurn; this.onError = onError; this.onStop = onStop;
    this.listening = false; this.mode = 'manual'; this.engine = '';
    this.sources = {}; this.entries = []; this.queue = Promise.resolve(); this.pending = 0; this.epoch = 0;
    this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    this.levelTimer = null; this.failed = []; this.sequence = 0; this.recordingId = null; this.queuedSamples = 0;
  }
  publicState() {
    return { listening: this.listening, mode: this.mode, engine: this.engine, pending: this.pending,
      levels: this.levels, speaking: this.speaking, failed: this.failed.length,
      backlogSeconds: Math.round(this.queuedSamples / SAMPLE_RATE), recordingId: this.recordingId,
      sources: Object.fromEntries(SOURCES.map(source => [source, !!this.sources[source]])),
      manualSeconds: this.listening && this.mode === 'manual' ? Math.round(Math.max(...SOURCES.map(source => this.sources[source]?.manualLength || 0)) / SAMPLE_RATE) : 0 };
  }
  restore(entries) {
    this.entries = Array.isArray(entries) ? entries.filter(entry => entry && SOURCES.includes(entry.source) && typeof entry.text === 'string' && typeof entry.id === 'string')
      .slice(-MAX_TRANSCRIPT_ENTRIES).map(({ id, source, text, at, order, recordingId }) => ({ id, source, text: text.slice(0, 4000), at: typeof at === 'string' ? at : '',
        ...(Number.isSafeInteger(order) && order > 0 ? { order } : {}), ...(typeof recordingId === 'string' ? { recordingId } : {}) })) : [];
    this.sequence = Math.max(0, ...this.entries.map(entry => entry.order || 0));
    this.recordingId = this.entries.at(-1)?.recordingId || null;
  }
  clear() { this.entries = []; this.failed = []; this.epoch++; this.recordingId = null; this.onChange(); }
  text(maxChars) { return transcriptText(this.entries, maxChars); }
  start({ mode, sources }) {
    if (this.listening) throw new Error('Listening has already started.');
    if (this.pending || this.failed.length) throw new Error('Finish or retry the previous transcription, or clear the transcript before recording again.');
    if (!['manual', 'auto'].includes(mode)) throw new Error('Choose manual or automatic listening.');
    const enabled = SOURCES.filter(source => Array.isArray(sources) && sources.includes(source));
    if (!enabled.length) throw new Error('Choose at least one audio source in Listening settings.');
    this.mode = mode; this.sources = {}; this.recordingId = randomUUID();
    for (const source of enabled) {
      const recording = mode === 'manual' ? new RecordingSegmenter(this.segmenterOptions()) : null;
      const created = recording ? { segmenter: recording, engine: recording.engine } : createSegmenter(this.segmenterOptions());
      this.engine = created.engine || this.engine;
      this.sources[source] = { segmenter: created.segmenter, manualLength: 0 };
    }
    this.listening = true; this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => this.onChange(), 250); this.levelTimer.unref?.();
    this.onChange();
  }
  feed(source, samples) {
    const state = this.sources[source];
    if (!this.listening || !state || !(samples instanceof Float32Array) || !samples.length) return;
    this.levels[source] = Math.min(1, rms(samples, 0, samples.length) * 6);
    if (this.mode === 'manual') {
      if (state.manualLength + samples.length > MAX_MANUAL_SECONDS * SAMPLE_RATE) { void this.stop(); this.onError('Manual recording reached 30 minutes and was stopped. Its audio is being transcribed.'); return; }
      state.manualLength += samples.length;
    }
    let segments;
    try { segments = state.segmenter.accept(samples); }
    catch { this.onError('Voice detection failed. Listening stopped.'); void this.stop(); return; }
    this.speaking[source] = !!state.segmenter.active;
    for (const segment of segments) this.enqueue(source, segment);
    if (this.queuedSamples + this.failed.reduce((sum, job) => sum + job.segment.samples.length, 0) > 120 * SAMPLE_RATE) { void this.stop(); this.onError('Recording stopped because transcription is falling behind. Your captured audio is still queued; wait for it to finish.'); }
  }
  async stop() {
    if (!this.listening) return;
    this.listening = false; clearInterval(this.levelTimer); this.levelTimer = null;
    const sources = this.sources; this.sources = {};
    for (const [source, state] of Object.entries(sources)) {
      for (const segment of flushSegments(state.segmenter)) this.enqueue(source, segment);
    }
    this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    this.onChange(); this.onStop();
  }
  enqueue(source, segment, job = null) {
    const seconds = segment.samples.length / SAMPLE_RATE;
    if (!segment.samples.length || (this.mode !== 'manual' && seconds < MIN_SEGMENT_SECONDS)) return;
    const epoch = this.epoch;
    job ||= { source, segment, id: randomUUID(), order: ++this.sequence, recordingId: this.recordingId, at: new Date().toISOString() };
    this.pending++; this.queuedSamples += segment.samples.length; this.onChange();
    this.queue = this.queue.then(async () => {
      try {
        if (epoch !== this.epoch) return;
        const previous = this.entries.filter(entry => !entry.order || entry.order < job.order);
        const text = cleanText(await this.transcribeFn(source, segment.samples, transcriptText(previous, 600)), seconds);
        if (epoch !== this.epoch) return;
        if (text) {
          const entry = { id: job.id, source, text, at: job.at, order: job.order, recordingId: job.recordingId };
          this.entries.push(entry);
          this.entries.sort((a, b) => (a.order || 0) - (b.order || 0));
          let size = this.entries.reduce((sum, item) => sum + item.text.length, 0);
          while (this.entries.length > MAX_TRANSCRIPT_ENTRIES || size > MAX_TRANSCRIPT_CHARS) size -= this.entries.shift().text.length;
          this.onEntry(entry);
        }
        if (segment.endedTurn && epoch === this.epoch) this.onTurn(source, text);
      } catch (error) {
        if (epoch === this.epoch) { this.failed.push(job); this.onError(`${error.message || 'Transcription failed.'} The audio is kept in memory; use Retry transcription.`); }
      } finally { this.pending--; this.queuedSamples -= segment.samples.length; this.onChange(); }
    });
  }
  retry() {
    if (this.listening || this.pending) throw new Error('Stop recording and wait for transcription before retrying.');
    const failed = this.failed.sort((a, b) => a.order - b.order); this.failed = [];
    for (const job of failed) this.enqueue(job.source, job.segment, job);
    this.onChange(); return this.idle();
  }
  idle() { return this.queue; }
}

module.exports = { SOURCES, Listener, transcriptText, cleanText };
