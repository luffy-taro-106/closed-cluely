'use strict';

const fs = require('node:fs');

// Turns a live 16 kHz sample stream into finished speech segments.
//
// Engines:
// - silero (default): Silero VAD v5 through sherpa-onnx. It is the most widely
//   used open model and handled real meeting audio best in public reports.
// - ten: TEN VAD through sherpa-onnx. It reacts faster at speech end, but its
//   accuracy advantage is disputed; offered as an alternative.
// - energy: a dependency-free fallback used when the native runtime cannot load.
//
// All engines use the same end-of-turn rule: speech starts after `minSpeechMs`
// of voice, and a segment ends after `endSilenceMs` of silence. Short pauses
// inside a sentence therefore stay in one segment. A pre-roll keeps the first
// syllable, and `maxSpeechMs` forces long monologues into transcribable pieces.

const SAMPLE_RATE = 16000;
const FRAME = 512; // 32 ms, the Silero / TEN window at 16 kHz.

function rms(samples, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

// Hysteresis segmenter driven by a per-frame speech score in [0, 1].
class HysteresisSegmenter {
  constructor({ threshold = 0.5, endSilenceMs = 700, minSpeechMs = 250, maxSpeechMs = 20000, preRollMs = 300, score } = {}) {
    this.start = threshold; this.stop = Math.max(0.05, threshold - 0.15);
    this.endFrames = Math.max(1, Math.round(endSilenceMs * SAMPLE_RATE / 1000 / FRAME));
    this.minFrames = Math.max(1, Math.round(minSpeechMs * SAMPLE_RATE / 1000 / FRAME));
    this.maxSamples = Math.round(maxSpeechMs * SAMPLE_RATE / 1000);
    this.preRoll = Math.round(preRollMs * SAMPLE_RATE / 1000);
    this.score = score;
    this.position = 0; this.pending = new Float32Array(0); this.history = []; this.historyLength = 0;
    this.reset();
  }
  reset() { this.speaking = false; this.voiced = 0; this.silent = 0; this.chunks = []; this.length = 0; this.candidate = []; }
  get active() { return this.speaking; }
  accept(samples) {
    const out = [];
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending); joined.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + FRAME <= joined.length; offset += FRAME) {
      const frame = joined.slice(offset, offset + FRAME);
      this.position += FRAME;
      const segment = this.frame(frame, this.score(frame));
      if (segment) out.push(segment);
    }
    this.pending = joined.slice(offset);
    return out;
  }
  remember(frame) {
    this.history.push(frame); this.historyLength += frame.length;
    while (this.historyLength - this.history[0].length >= this.preRoll) this.historyLength -= this.history.shift().length;
  }
  frame(frame, probability) {
    if (!this.speaking) {
      if (probability >= this.start) {
        this.candidate.push(frame);
        if (this.candidate.length >= this.minFrames) {
          this.speaking = true; this.silent = 0;
          this.chunks = [...this.history, ...this.candidate];
          this.length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          this.startSample = this.position - this.length;
          this.history = []; this.historyLength = 0; this.candidate = [];
        }
      } else {
        for (const pending of this.candidate) this.remember(pending);
        this.candidate = []; this.remember(frame);
      }
      return null;
    }
    this.chunks.push(frame); this.length += frame.length;
    this.silent = probability < this.stop ? this.silent + 1 : 0;
    if (this.silent >= this.endFrames || this.length >= this.maxSamples) return this.finish(this.silent >= this.endFrames);
    return null;
  }
  finish(trimSilence = false) {
    if (!this.speaking) { this.reset(); return null; }
    // Keep ~200 ms of trailing silence; drop the rest of the end-of-turn wait.
    const keep = trimSilence ? Math.max(0, this.chunks.length - this.silent + Math.round(0.2 * SAMPLE_RATE / FRAME)) : this.chunks.length;
    const chunks = this.chunks.slice(0, keep);
    const audio = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0; for (const chunk of chunks) { audio.set(chunk, at); at += chunk.length; }
    const endedTurn = trimSilence;
    this.reset();
    return { samples: audio, endedTurn, start: this.startSample };
  }
  flush() { if (this.speaking && this.pending.length) { this.chunks.push(this.pending); this.length += this.pending.length; } const segment = this.finish(false); this.pending = new Float32Array(0); this.history = []; this.historyLength = 0; return segment ? { ...segment, endedTurn: true } : null; }
}

// Energy score: adapts to the noise floor so it works for a quiet BlackHole
// feed as well as a noisy microphone.
function energyScorer() {
  let floor = 0.003;
  return frame => {
    const level = rms(frame, 0, frame.length);
    floor = level < floor ? floor * 0.9 + level * 0.1 : floor * 0.999 + level * 0.001;
    const ratio = level / Math.max(0.0015, floor);
    return Math.max(0, Math.min(1, (ratio - 2) / 4));
  };
}

// Silero and TEN through sherpa-onnx emit finished segments themselves. The
// wrapper keeps the same interface and reports whether a segment ended a turn.
class SherpaSegmenter {
  constructor(sherpa, { engine, modelPath, threshold, endSilenceMs, minSpeechMs = 250, maxSpeechMs = 20000 }) {
    const key = engine === 'ten' ? 'tenVad' : 'sileroVad';
    this.config = { [key]: { model: modelPath, threshold, minSilenceDuration: endSilenceMs / 1000, minSpeechDuration: minSpeechMs / 1000, maxSpeechDuration: maxSpeechMs / 1000, windowSize: engine === 'ten' ? 256 : FRAME }, sampleRate: SAMPLE_RATE, numThreads: 1, provider: 'cpu', debug: 0 };
    this.vad = new sherpa.Vad(this.config, 60);
    this.window = this.config[key].windowSize;
    this.pending = new Float32Array(0);
  }
  get active() { return this.vad.isDetected(); }
  drain(endedTurn) {
    const out = [];
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false);
      out.push({ samples: Float32Array.from(segment.samples), endedTurn, start: segment.start });
      this.vad.pop();
    }
    return out;
  }
  accept(samples) {
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending); joined.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + this.window <= joined.length; offset += this.window) this.vad.acceptWaveform(joined.subarray(offset, offset + this.window));
    this.pending = joined.slice(offset);
    // A segment that reached maxSpeechDuration while speech continues is not a turn end.
    return this.drain(!this.vad.isDetected());
  }
  flush() { if (this.pending.length) { const tail = new Float32Array(this.window); tail.set(this.pending); this.vad.acceptWaveform(tail); } this.vad.flush(); this.pending = new Float32Array(0); const out = this.drain(true); this.vad.reset(); return out.length ? out : null; }
}

function createSegmenter(options = {}) {
  const { engine = 'silero', sherpa = null, modelPath = '' } = options;
  // sherpa-onnx logs instead of throwing on a missing model, so check first.
  if ((engine === 'silero' || engine === 'ten') && sherpa && modelPath && fs.existsSync(modelPath)) {
    try { return { segmenter: new SherpaSegmenter(sherpa, options), engine }; }
    catch { /* Fall through to the energy detector. */ }
  }
  return { segmenter: new HysteresisSegmenter({ ...options, score: energyScorer() }), engine: 'energy' };
}

// Normalise flush() output from both segmenter types.
function flushSegments(segmenter) {
  const result = segmenter.flush();
  return !result ? [] : Array.isArray(result) ? result : [result];
}

module.exports = { SAMPLE_RATE, FRAME, HysteresisSegmenter, SherpaSegmenter, energyScorer, createSegmenter, flushSegments, rms };
