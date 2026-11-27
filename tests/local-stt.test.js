'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalStt, localThreadCount } = require('../overlay/local-stt');
function fixture(t, sherpa) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-cluely-local-stt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const id of ['parakeet-tdt-v2', 'parakeet-tdt-v3']) {
    const target = path.join(directory, id); fs.mkdirSync(target);
    for (const file of ['.complete', 'tokens.txt', 'encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx']) fs.writeFileSync(path.join(target, file), 'fixture');
  }
  return new LocalStt({ directory, sherpa });
}
test('warmup and first transcription share one asynchronous model load', async t => {
  let release, loads = 0;
  const recognizer = { createStream: () => ({ acceptWaveform() {} }), decodeAsync: async () => ({ text: ' exact words ' }) };
  const stt = fixture(t, { OfflineRecognizer: { createAsync: config => {
    loads++; assert.equal(config.modelConfig.numThreads, localThreadCount({ kind: 'parakeet' }));
    return new Promise(resolve => { release = () => resolve(recognizer); });
  } } });
  const warming = stt.warmup('parakeet-tdt-v2');
  const answer = stt.transcribe({ model: 'parakeet-tdt-v2', samples: new Float32Array(1600) });
  assert.equal(loads, 1); release(); await warming;
  assert.equal(await answer, 'exact words');
  assert.equal(loads, 1);
});
test('switching models releases the old cached recognizer and failed loads can retry', async t => {
  let fail = true, loads = 0;
  const stt = fixture(t, { OfflineRecognizer: { createAsync: async () => { loads++; if (fail) throw new Error('load failed'); return {}; } } });
  await assert.rejects(stt.warmup('parakeet-tdt-v2'), /load failed/);
  fail = false; await stt.warmup('parakeet-tdt-v2'); await stt.warmup('parakeet-tdt-v3');
  assert.equal(loads, 3); assert.equal(stt.recognizers.size, 1);
  assert.ok([...stt.recognizers.keys()][0].startsWith('parakeet-tdt-v3/'));
});

test('thread tuning is limited to the measured model/platform and available CPUs', () => {
  assert.equal(localThreadCount({ kind: 'parakeet' }, { platform: 'darwin', arch: 'arm64', cores: 8 }), 4);
  assert.equal(localThreadCount({ kind: 'parakeet' }, { platform: 'darwin', arch: 'arm64', cores: 2 }), 2);
  assert.equal(localThreadCount({ kind: 'whisper' }, { platform: 'darwin', arch: 'arm64', cores: 8 }), 2);
  assert.equal(localThreadCount({ kind: 'parakeet' }, { platform: 'win32', arch: 'x64', cores: 8 }), 2);
});
