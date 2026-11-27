'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RecordingSegmenter } = require('../overlay/recording-segmenter');
const { SAMPLE_RATE } = require('../overlay/segmenter');
const tone = seconds => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => Math.sin(i / 7) * 0.2);
const silence = seconds => new Float32Array(Math.round(seconds * SAMPLE_RATE));
function join(parts) { const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function split(audio, frameSize = 1600) {
  const splitter = new RecordingSegmenter({ engine: 'energy', endSilenceMs: 700 });
  const segments = [];
  for (let i = 0; i < audio.length; i += frameSize) segments.push(...splitter.accept(audio.slice(i, i + frameSize)));
  return { segments: [...segments, ...splitter.flush()], splitter };
}
test('recording boundaries preserve every sample including short replies and the final partial frame', () => {
  const audio = join([tone(1.3), silence(1), tone(0.15), silence(0.15), tone(1.211)]);
  for (const size of [128, 1600, 16000]) {
    const { segments } = split(audio, size);
    assert.ok(segments.length >= 2);
    assert.deepEqual(join(segments.map(segment => segment.samples)), audio);
  }
});
test('continuous speech is bounded and loses no audio when a long segment is split', () => {
  const audio = tone(56.123);
  const { segments, splitter } = split(audio);
  assert.ok(segments.length >= 3);
  assert.ok(segments.every(segment => segment.samples.length <= 25.1 * SAMPLE_RATE));
  assert.deepEqual(join(segments.map(segment => segment.samples)), audio);
  assert.equal(splitter.length, 0);
});
test('silence has bounded buffering and sends no transcription requests', () => {
  const { segments, splitter } = split(silence(80));
  assert.equal(segments.length, 0);
  assert.equal(splitter.length, 0);
});
test('a brief reply missed by VAD is still transcribed on Stop', () => {
  const audio = tone(0.15);
  assert.deepEqual(join(split(audio).segments.map(segment => segment.samples)), audio);
});
