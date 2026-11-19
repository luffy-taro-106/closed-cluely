'use strict';
// Runs on the audio thread. The AudioContext is created at 16 kHz, so Chromium
// resamples the device input; this processor only mixes to mono and batches
// 100 ms frames for the main process.
class FrameBatcher extends AudioWorkletProcessor {
  constructor() { super(); this.frame = new Float32Array(1600); this.length = 0; }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channels = input.length, samples = input[0].length;
    for (let i = 0; i < samples; i++) {
      let value = 0;
      for (let channel = 0; channel < channels; channel++) value += input[channel][i];
      this.frame[this.length++] = value / channels;
      if (this.length === this.frame.length) { this.port.postMessage(this.frame, [this.frame.buffer]); this.frame = new Float32Array(1600); this.length = 0; }
    }
    return true;
  }
}
registerProcessor('frame-batcher', FrameBatcher);
