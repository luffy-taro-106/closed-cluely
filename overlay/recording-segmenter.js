'use strict';
const { SAMPLE_RATE, createSegmenter, flushSegments, rms } = require('./segmenter');

// VAD chooses boundaries, not which words survive: retain the original samples
// between boundaries, including quiet speech, short words and the final syllable.
class RecordingSegmenter {
  constructor(options = {}) {
    const created = createSegmenter({ ...options, maxSpeechMs: 25000 });
    this.detector = created.segmenter; this.engine = created.engine;
    this.chunks = []; this.length = 0; this.offset = 0;
    this.maxSamples = 25 * SAMPLE_RATE;
  }
  get active() { return this.detector.active; }
  take(count, detected = false) {
    count = Math.min(count, this.length);
    if (count <= 0) return null;
    const samples = new Float32Array(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[0], size = Math.min(chunk.length, count - written);
      samples.set(chunk.subarray(0, size), written); written += size;
      if (size === chunk.length) this.chunks.shift(); else this.chunks[0] = chunk.subarray(size);
    }
    this.length -= count; this.offset += count;
    // Keep short replies. Reject only a quiet range with no detected speech.
    return detected || rms(samples, 0, count) > 0.002 ? { samples, endedTurn: false } : null;
  }
  drain(segments) {
    const out = [];
    for (const segment of segments) {
      const end = segment.start + segment.samples.length;
      if (!Number.isFinite(end)) continue;
      const next = this.take(end - this.offset, true);
      if (next) out.push({ ...next, endedTurn: segment.endedTurn });
    }
    return out;
  }
  accept(samples) {
    this.chunks.push(samples); this.length += samples.length;
    const out = this.drain(this.detector.accept(samples));
    while (this.length >= this.maxSamples) {
      const next = this.take(this.maxSamples);
      if (next) out.push(next);
    }
    return out;
  }
  flush() {
    const out = this.drain(flushSegments(this.detector));
    const tail = this.take(this.length);
    if (tail) out.push(tail);
    if (out.length) out[out.length - 1].endedTurn = true;
    return out;
  }
}
module.exports = { RecordingSegmenter };
