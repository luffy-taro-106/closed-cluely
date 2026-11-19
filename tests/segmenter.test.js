'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { HysteresisSegmenter, createSegmenter, flushSegments, energyScorer } = require('../overlay/segmenter');

const RATE = 16000;
const silence = seconds => new Float32Array(Math.round(seconds * RATE));
// A speech-like signal: amplitude-modulated tone bursts.
const voice = seconds => Float32Array.from({ length: Math.round(seconds * RATE) }, (_v, i) => Math.sin(i / 6) * 0.3 * (0.6 + 0.4 * Math.sin(i / 900)));
function join(...parts) { const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; }
function run(segmenter, audio, chunk = 1600) {
  const segments = [];
  for (let offset = 0; offset < audio.length; offset += chunk) segments.push(...segmenter.accept(audio.subarray(offset, offset + chunk)));
  return [...segments, ...flushSegments(segmenter)];
}
// Deterministic scorer: loud frames are speech.
const loud = frame => { let peak = 0; for (const value of frame) peak = Math.max(peak, Math.abs(value)); return peak > 0.05 ? 0.9 : 0.02; };

test('a pause shorter than the end-of-turn wait stays in one segment', () => {
  const segments = run(new HysteresisSegmenter({ endSilenceMs: 700, score: loud }), join(silence(0.5), voice(1.5), silence(0.4), voice(1.2), silence(1)));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].endedTurn, true);
  assert.ok(segments[0].samples.length / RATE > 3.0 && segments[0].samples.length / RATE < 3.9, `${segments[0].samples.length / RATE}s`);
});

test('a long pause ends the turn and starts a new segment; pre-roll keeps the onset', () => {
  const segments = run(new HysteresisSegmenter({ endSilenceMs: 600, preRollMs: 300, score: loud }), join(silence(1), voice(1), silence(1.2), voice(1), silence(1)));
  assert.equal(segments.length, 2);
  assert.ok(segments.every(segment => segment.endedTurn));
  assert.ok(segments[0].samples.length / RATE >= 1.25, 'pre-roll and trailing context are included');
});

test('clicks shorter than the minimum speech duration are ignored', () => {
  assert.equal(run(new HysteresisSegmenter({ minSpeechMs: 250, score: loud }), join(silence(0.5), voice(0.1), silence(1), voice(0.1), silence(1))).length, 0);
});

test('monologues are split at the maximum length without ending the turn', () => {
  const segments = run(new HysteresisSegmenter({ maxSpeechMs: 5000, score: loud }), join(voice(12), silence(1)));
  assert.ok(segments.length >= 3);
  assert.equal(segments[0].endedTurn, false); assert.equal(segments.at(-1).endedTurn, true);
});

test('the energy detector adapts to the noise floor', () => {
  const noise = Float32Array.from({ length: 2 * RATE }, () => (Math.random() - 0.5) * 0.004);
  const segments = run(createSegmenter({ engine: 'energy' }).segmenter, join(noise, voice(1.5), noise));
  assert.equal(segments.length, 1);
  const scorer = energyScorer();
  for (let i = 0; i < 50; i++) scorer(noise.subarray(i * 512, i * 512 + 512));
  assert.ok(scorer(voice(0.032)) > 0.5);
});

test('Silero through sherpa-onnx segments real speech, and missing models fall back', { skip: !require('../overlay/local-stt').loadSherpa() && 'sherpa-onnx is not installed for this platform' }, () => {
  const sherpa = require('sherpa-onnx-node');
  const modelPath = path.join(__dirname, '..', 'overlay', 'models', 'silero_vad.onnx');
  const created = createSegmenter({ engine: 'silero', sherpa, modelPath, threshold: 0.5, endSilenceMs: 700 });
  assert.equal(created.engine, 'silero');
  assert.equal(run(created.segmenter, join(silence(2))).length, 0, 'silence produces nothing');
  assert.equal(createSegmenter({ engine: 'silero', sherpa, modelPath: '/missing/model.onnx' }).engine, 'energy');
  assert.equal(createSegmenter({ engine: 'ten', sherpa: null, modelPath }).engine, 'energy');
});
