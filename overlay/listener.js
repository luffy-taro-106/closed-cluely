'use strict';

const { randomUUID } = require('node:crypto');
const { SAMPLE_RATE, createSegmenter, flushSegments, rms } = require('./segmenter');

const { RecordingSegmenter } = require('./recording-segmenter');

// Two sources: "them" is what the laptop plays (the other side of the call,
// through BlackHole or Windows system audio) and "me" is the microphone.
const SOURCES = ['me', 'them'];
const MAX_MANUAL_SECONDS = 30 * 60;
const MIN_SEGMENT_SECONDS = 0.1;
const MAX_TRANSCRIPT_ENTRIES = 2000;
const MAX_TRANSCRIPT_CHARS = 200000;
const MAX_BACKLOG_SECONDS = 120;
const ECHO_WINDOW_MS = 15000;
// Remove explicit non-speech markers, never legitimate short replies such as "Thank you".
const HALLUCINATIONS = /^(\[?(blank_audio|silence|music|inaudible|no speech)\]?|\(.*\)|\.+)$/i;

function cleanText(text, seconds) {
  const value = String(text || '').replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (seconds < 2.5 && HALLUCINATIONS.test(value)) return '';
  return value;
}

const words = text => String(text || '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

// Laptop speakers leak the other side into the microphone. A "me" line whose
// words mostly repeat what "them" said moments earlier is that echo.
function isEcho(text, at, entries) {
  const mine = words(text);
  if (mine.length < 3) return false;
  const time = Date.parse(at);
  const heard = new Set();
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - 30; i--) {
    const entry = entries[i];
    if (entry.source !== 'them') continue;
    const when = Date.parse(entry.at);
    if (Number.isFinite(time) && Number.isFinite(when) && Math.abs(time - when) > ECHO_WINDOW_MS) continue;
    for (const word of words(entry.text)) heard.add(word);
  }
  if (!heard.size) return false;
  return mine.filter(word => heard.has(word)).length / mine.length >= 0.7;
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
  constructor({ settings, segmenterOptions, transcribe, turnDelayMs = () => 0, onChange = () => {}, onEntry = () => {}, onTurn = () => {}, onError = () => {}, onStop = () => {} }) {
    this.settings = settings; this.segmenterOptions = segmenterOptions; this.transcribeFn = transcribe; this.turnDelayMs = turnDelayMs;
    this.onChange = onChange; this.onEntry = onEntry; this.onTurn = onTurn; this.onError = onError; this.onStop = onStop;
    this.listening = false; this.mode = 'manual'; this.engine = '';
    this.sources = {}; this.entries = []; this.jobs = []; this.working = false; this.waiters = []; this.epoch = 0;
    this.pending = 0; this.pendingBy = { me: 0, them: 0 }; this.echoes = 0;
    this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false }; this.turnTimer = null;
    this.levelTimer = null; this.failed = []; this.sequence = 0; this.recordingId = null; this.queuedSamples = 0;
  }
  publicState() {
    return { listening: this.listening, mode: this.mode, engine: this.engine, pending: this.pending, pendingBy: { ...this.pendingBy },
      levels: this.levels, speaking: this.speaking, failed: this.failed.length, echoes: this.echoes,
      backlogSeconds: Math.round(this.queuedSamples / SAMPLE_RATE), recordingId: this.recordingId,
      sources: Object.fromEntries(SOURCES.map(source => [source, !!this.sources[source]])),
      manualSeconds: this.listening && this.mode === 'manual' ? Math.round(Math.max(...SOURCES.map(source => this.sources[source]?.manualLength || 0)) / SAMPLE_RATE) : 0 };
  }
  restore(entries) {
    this.entries = Array.isArray(entries) ? entries.filter(entry => entry && SOURCES.includes(entry.source) && typeof entry.text === 'string' && typeof entry.id === 'string')
      .slice(-MAX_TRANSCRIPT_ENTRIES).map(({ id, source, text, at, order, recordingId }) => ({ id, source, text: text.slice(0, 4000), at: typeof at === 'string' ? at : '',
        ...(Number.isSafeInteger(order) && order > 0 ? { order } : {}), ...(typeof recordingId === 'string' ? { recordingId } : {}) })) : [];
    this.sequence = Math.max(this.sequence, 0, ...this.entries.map(entry => entry.order || 0));
    if (!this.listening) this.recordingId = this.entries.at(-1)?.recordingId || null;
  }
  clear() { this.entries = []; this.failed = []; this.epoch++; this.cancelTurn(); if (!this.listening) this.recordingId = null; this.onChange(); }
  text(maxChars) { return transcriptText(this.entries, maxChars); }
  start({ mode, sources }) {
    if (this.listening) throw new Error('Listening has already started.');
    if (!['manual', 'auto'].includes(mode)) throw new Error('Choose manual or automatic listening.');
    // Live listening keeps running; only a manual recording must finish first.
    if (mode === 'manual' && (this.pending || this.failed.length)) throw new Error('Finish or retry the previous transcription, or clear the transcript before recording again.');
    const enabled = SOURCES.filter(source => Array.isArray(sources) && sources.includes(source));
    if (!enabled.length) throw new Error('Choose at least one audio source in Listening settings.');
    this.mode = mode; this.sources = {}; this.recordingId = randomUUID();
    for (const source of enabled) {
      const recording = mode === 'manual' ? new RecordingSegmenter(this.segmenterOptions(source)) : null;
      const created = recording ? { segmenter: recording, engine: recording.engine } : createSegmenter(this.segmenterOptions(source));
      this.engine = created.engine || this.engine;
      this.sources[source] = { segmenter: created.segmenter, manualLength: 0 };
    }
    this.listening = true; this.levels = { me: 0, them: 0 }; this.speaking = { me: false, them: false };
    clearInterval(this.levelTimer);
    this.levelTimer = setInterval(() => this.onChange(), 250); this.levelTimer.unref?.();
    this.onChange();
  }
  cancelTurn() { clearTimeout(this.turnTimer); this.turnTimer = null; }
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
    // End of their turn: the segmenter already waited endSilenceMs; wait the rest
    // of the answer pause while transcription runs, and cancel if they go on.
    if (this.mode === 'auto' && source === 'them') {
      if (this.speaking.them) this.cancelTurn();
      else if (segments.some(segment => segment.endedTurn)) {
        this.cancelTurn();
        this.turnTimer = setTimeout(() => { this.turnTimer = null; if (this.listening && !this.speaking.them) this.onTurn('them'); }, Math.max(0, this.turnDelayMs()));
        this.turnTimer.unref?.();
      }
    }
    this.limitBacklog();
  }
  limitBacklog() {
    const failedSamples = this.failed.reduce((sum, job) => sum + job.segment.samples.length, 0);
    if (this.queuedSamples + failedSamples <= MAX_BACKLOG_SECONDS * SAMPLE_RATE) return;
    // Keep the other side's words: drop queued microphone audio first.
    const dropped = this.jobs.filter(job => job.source === 'me');
    if (dropped.length) {
      this.jobs = this.jobs.filter(job => job.source !== 'me');
      for (const job of dropped) this.settle(job);
      this.onError('Transcription is falling behind, so some of your microphone audio was skipped.');
      this.onChange();
      if (this.queuedSamples + failedSamples <= MAX_BACKLOG_SECONDS * SAMPLE_RATE) return;
    }
    void this.stop(); this.onError('Listening stopped because transcription is falling behind. Your captured audio is still queued; wait for it to finish.');
  }
  async stop() {
    if (!this.listening) return;
    this.listening = false; clearInterval(this.levelTimer); this.levelTimer = null; this.cancelTurn();
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
    job ||= { source, segment, id: randomUUID(), order: ++this.sequence, recordingId: this.recordingId, at: new Date().toISOString() };
    job.epoch = this.epoch;
    this.jobs.push(job);
    this.pending++; this.pendingBy[source]++; this.queuedSamples += segment.samples.length; this.onChange();
    void this.work();
  }
  settle(job) { this.pending--; this.pendingBy[job.source]--; this.queuedSamples -= job.segment.samples.length; }
  // One transcription at a time (local models share one recognizer). The other
  // side goes first so their end of turn is never stuck behind microphone audio.
  next() {
    let index = this.jobs.findIndex(job => job.source === 'them');
    if (index < 0) index = 0;
    return this.jobs.splice(index, 1)[0];
  }
  async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.jobs.length) {
        const job = this.next();
        try { await this.run(job); }
        finally { this.settle(job); this.onChange(); }
      }
    } finally {
      this.working = false;
      const waiters = this.waiters; this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }
  async run(job) {
    const { source, segment } = job;
    const seconds = segment.samples.length / SAMPLE_RATE;
    if (job.epoch !== this.epoch) return;
    try {
      const previous = this.entries.filter(entry => !entry.order || entry.order < job.order);
      let text = cleanText(await this.transcribeFn(source, segment.samples, transcriptText(previous, 600)), seconds);
      if (job.epoch !== this.epoch) return;
      if (text && source === 'me' && isEcho(text, job.at, this.entries)) { text = ''; this.echoes++; }
      if (!text) return;
      const entry = { id: job.id, source, text, at: job.at, order: job.order, recordingId: job.recordingId };
      this.entries.push(entry);
      this.entries.sort((a, b) => (a.order || 0) - (b.order || 0));
      let size = this.entries.reduce((sum, item) => sum + item.text.length, 0);
      while (this.entries.length > MAX_TRANSCRIPT_ENTRIES || size > MAX_TRANSCRIPT_CHARS) size -= this.entries.shift().text.length;
      this.onEntry(entry);
    } catch (error) {
      if (job.epoch === this.epoch) { this.failed.push(job); this.onError(`${error.message || 'Transcription failed.'} The audio is kept in memory; use Retry transcription.`); }
    }
  }
  retry() {
    if (this.mode === 'manual' && (this.listening || this.pending)) throw new Error('Stop recording and wait for transcription before retrying.');
    const failed = this.failed.sort((a, b) => a.order - b.order); this.failed = [];
    for (const job of failed) this.enqueue(job.source, job.segment, job);
    this.onChange(); return this.idle();
  }
  idle() { return this.working || this.jobs.length ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve(); }
}

module.exports = { SOURCES, Listener, transcriptText, cleanText, isEcho };
