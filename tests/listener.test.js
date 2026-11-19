'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Listener, transcriptText, cleanText } = require('../overlay/listener');

const RATE = 16000;
const silence = seconds => new Float32Array(Math.round(seconds * RATE));
const voice = seconds => Float32Array.from({ length: Math.round(seconds * RATE) }, (_v, i) => Math.sin(i / 6) * 0.3);
function feed(listener, source, audio) { for (let offset = 0; offset < audio.length; offset += 1600) listener.feed(source, audio.slice(offset, offset + 1600)); }
function make(overrides = {}) {
  const events = { entries: [], turns: [], errors: [] };
  let n = 0;
  const listener = new Listener({
    segmenterOptions: () => ({ engine: 'energy', endSilenceMs: 600 }),
    transcribe: async (source, samples) => `${source} said ${++n} (${(samples.length / RATE).toFixed(1)}s)`,
    onEntry: entry => events.entries.push(entry), onTurn: (source, text) => events.turns.push({ source, text }), onError: text => events.errors.push(text),
    ...overrides
  });
  return { listener, events };
}

test('automatic mode transcribes each turn as the speaker stops', async () => {
  const { listener, events } = make();
  listener.start({ mode: 'auto', sources: ['me', 'them'] });
  assert.equal(listener.publicState().engine, 'energy');
  feed(listener, 'them', [silence(0.5), voice(1.5), silence(1)].reduce((a, b) => { const c = new Float32Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }));
  await listener.idle();
  assert.equal(events.entries.length, 1); assert.equal(events.entries[0].source, 'them');
  assert.deepEqual(events.turns.map(turn => turn.source), ['them']);
  feed(listener, 'me', voice(1)); // still speaking when stopped
  await listener.stop(); await listener.idle();
  assert.equal(events.entries.length, 2); assert.equal(events.entries[1].source, 'me');
  assert.match(listener.text(), /^Them: them said 1.*\nMe: me said 2/);
  assert.equal(listener.publicState().listening, false);
});

test('manual mode buffers until Stop, then transcribes in order', async () => {
  const { listener, events } = make();
  listener.start({ mode: 'manual', sources: ['them'] });
  feed(listener, 'them', voice(1.2)); feed(listener, 'them', silence(0.8)); feed(listener, 'them', voice(1.4));
  feed(listener, 'me', voice(2)); // not an enabled source
  assert.equal(events.entries.length, 0, 'nothing is sent before Stop');
  assert.equal(listener.publicState().manualSeconds, 3);
  await listener.stop(); await listener.idle();
  assert.ok(events.entries.length >= 1);
  assert.ok(events.entries.every(entry => entry.source === 'them'));
});

test('transcription failures are reported and later segments still run', async () => {
  let calls = 0;
  const { listener, events } = make({ transcribe: async () => { calls++; if (calls === 1) throw new Error('network down'); return 'second works'; } });
  listener.start({ mode: 'auto', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1)); feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  await listener.idle();
  assert.deepEqual(events.errors, ['network down']);
  assert.equal(events.entries.at(-1).text, 'second works');
  await listener.stop();
});

test('clearing the transcript discards transcriptions still in flight', async () => {
  let release;
  const { listener, events } = make({ transcribe: () => new Promise(resolve => { release = resolve; }) });
  listener.start({ mode: 'auto', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  await new Promise(resolve => setTimeout(resolve, 5));
  listener.clear(); release('stale words');
  await listener.idle(); await listener.stop();
  assert.equal(events.entries.length, 0); assert.equal(listener.entries.length, 0);
});

test('start validates mode and sources; restore keeps only valid entries', () => {
  const { listener } = make();
  assert.throws(() => listener.start({ mode: 'always', sources: ['me'] }), /manual or automatic/);
  assert.throws(() => listener.start({ mode: 'auto', sources: [] }), /audio source/);
  listener.restore([{ id: 'a', source: 'them', text: 'hello' }, { id: 'b', source: 'robot', text: 'x' }, null]);
  assert.equal(listener.entries.length, 1);
});

test('Whisper silence hallucinations are dropped only for short segments', () => {
  assert.equal(cleanText('Thank you.', 1), '');
  assert.equal(cleanText(' [BLANK_AUDIO] ', 1), '');
  assert.equal(cleanText('Thank you.', 4), 'Thank you.');
  assert.equal(cleanText('What is the  budget?', 1), 'What is the budget?');
});

test('transcript text keeps the most recent lines within the budget', () => {
  const entries = Array.from({ length: 50 }, (_v, i) => ({ id: String(i), source: i % 2 ? 'me' : 'them', text: `line ${i}` }));
  const text = transcriptText(entries, 60);
  assert.ok(text.length <= 60); assert.match(text, /line 49$/); assert.doesNotMatch(text, /line 1\b/);
});
