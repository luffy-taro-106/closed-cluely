'use strict';
// Replays a public/test WAV; never opens a microphone or sends audio to a cloud.
// node scripts/benchmark-speech.js MODEL_DIRECTORY WAV_FILE [THREADS=2]
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { recognizerConfig, LOCAL_MODELS, loadSherpa } = require('../overlay/local-stt');
const { createSegmenter, flushSegments } = require('../overlay/segmenter');
const { RecordingSegmenter } = require('../overlay/recording-segmenter');
const path = require('node:path');
async function main() {
  const [directory, wavFile, count = '2'] = process.argv.slice(2);
  if (!directory || !wavFile) throw new Error('Usage: node scripts/benchmark-speech.js MODEL_DIRECTORY WAV_FILE [THREADS=2]');
  const sherpa = loadSherpa(), threads = Number(count);
  const wave = sherpa.readWave(wavFile);
  if (wave.sampleRate !== 16000) throw new Error('Use a 16 kHz mono WAV fixture.');
  const model = LOCAL_MODELS.find(item => directory.includes(item.archive) || directory.endsWith(item.id));
  if (!model) throw new Error('Use one of the supported local model directories.');
  const begin = performance.now();
  const recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(model, directory, { threads }));
  const loadMs = performance.now() - begin;
  const decode = async samples => {
    const start = performance.now();
    const stream = recognizer.createStream(); stream.acceptWaveform({ samples, sampleRate: 16000 });
    const result = await recognizer.decodeAsync(stream);
    return { text: result.text.trim(), milliseconds: performance.now() - start, audioSeconds: samples.length / 16000 };
  };
  const cold = await decode(wave.samples), warm = await decode(wave.samples);
  const audio = new Float32Array(wave.samples.length * 3 + 16000 * 2);
  for (let i = 0; i < 3; i++) audio.set(wave.samples, i * (wave.samples.length + 16000));
  const options = { engine: 'silero', sherpa, modelPath: path.join(__dirname, '../overlay/models/silero_vad.onnx'), threshold: 0.5, endSilenceMs: 700 };
  const baseline = createSegmenter({ ...options, endSilenceMs: 500, maxSpeechMs: 25000 }).segmenter;
  let segments = [], oldStart = performance.now();
  for (let i = 0; i < audio.length; i += 16000) segments.push(...baseline.accept(audio.subarray(i, i + 16000)));
  segments.push(...flushSegments(baseline));
  const before = [];
  for (const segment of segments) before.push(await decode(segment.samples));
  const baselineStopMs = performance.now() - oldStart;
  const recording = new RecordingSegmenter(options), after = [];
  let queue = Promise.resolve(), finishedBeforeStop = 0;
  const schedule = segments => { for (const segment of segments) queue = queue.then(async () => { after.push(await decode(segment.samples)); }); };
  const replayStart = performance.now();
  for (let i = 0; i < audio.length; i += 1600) {
    schedule(recording.accept(audio.subarray(i, i + 1600)));
    const remaining = replayStart + Math.min(audio.length, i + 1600) / 16 - performance.now();
    if (remaining > 0) await delay(remaining);
  }
  const stop = performance.now(); finishedBeforeStop = after.length;
  schedule(recording.flush()); await queue;
  const stopMs = performance.now() - stop;
  const normalize = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  console.log(JSON.stringify({ model: model.id, threads, fixtureSeconds: wave.samples.length / 16000, recordingSeconds: audio.length / 16000,
    loadMs, cold, warm, baselineStopMs, stopMs, finishedBeforeStop,
    sameWords: normalize(before.map(item => item.text).join(' ')) === normalize(after.map(item => item.text).join(' ')), before, after }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
