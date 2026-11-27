'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('Stop flushes the last partial audio frame exactly once and stops new samples', () => {
  let Processor;
  const frames = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: value => frames.push(value) }; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../overlay/ui/audio-worklet.js'), 'utf8'), {
    AudioWorkletProcessor, Float32Array, registerProcessor: (_name, implementation) => { Processor = implementation; }
  });
  const processor = new Processor();
  const audio = Float32Array.from({ length: 1737 }, (_, i) => i / 2000);
  processor.process([[audio]]);
  assert.equal(frames.length, 1);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.deepEqual([...frames[0], ...frames[1]], [...audio]);
  assert.equal(frames[2].type, 'flushed');
  processor.process([[audio]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.equal(frames.filter(value => value instanceof Float32Array).length, 2);
});
