'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Listener, transcriptText, cleanText } = require('../overlay/listener');

const RATE = 16000;
const silence = seconds => new Float32Array(Math.round(seconds * RATE));
const voice = seconds => Float32Array.from({ length: Math.round(seconds * RATE) }, (_v, i) => Math.sin(i / 6) * 0.3);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
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
  await listener.idle(); await tick();
  assert.equal(events.entries.length, 1); assert.equal(events.entries[0].source, 'them');
  assert.deepEqual(events.turns.map(turn => turn.source), ['them']);
  feed(listener, 'me', voice(1)); feed(listener, 'me', silence(1)); // the microphone never triggers an answer
  feed(listener, 'me', voice(1)); // still speaking when stopped
  await listener.stop(); await listener.idle(); await tick();
  assert.equal(events.entries.length, 3); assert.equal(events.entries[1].source, 'me');
  assert.deepEqual(events.turns.map(turn => turn.source), ['them']);
  assert.match(listener.text(), /^Them: them said 1.*\nMe: me said 2/);
  assert.equal(listener.publicState().listening, false);
});

test('the answer pause is cancelled when the other side keeps talking', async () => {
  const { listener, events } = make({ turnDelayMs: () => 80 });
  listener.start({ mode: 'auto', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(0.7));
  feed(listener, 'them', voice(0.6)); // resumes inside the pause
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events.turns.length, 0, 'no answer while they are still speaking');
  feed(listener, 'them', silence(0.8));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(events.turns.length, 1);
  await listener.stop(); await listener.idle();
});

test('the other side is transcribed before queued microphone audio', async () => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { listener } = make({ transcribe: async source => { order.push(source); if (order.length === 1) await gate; return `${source} words here`; } });
  listener.start({ mode: 'auto', sources: ['me', 'them'] });
  feed(listener, 'me', voice(1)); feed(listener, 'me', silence(1));
  feed(listener, 'me', voice(1)); feed(listener, 'me', silence(1));
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  assert.deepEqual(listener.publicState().pendingBy, { me: 2, them: 1 });
  release(); await listener.idle();
  assert.deepEqual(order, ['me', 'them', 'me']);
  await listener.stop();
});

test('microphone echo of the other side is dropped, real replies are kept', async () => {
  const texts = { them: 'Can you walk me through the caching layer you built', me: ['the caching layer you built can you walk me through', 'Sure, we used Redis in front of Postgres'] };
  let mine = 0;
  const { listener } = make({ transcribe: async source => source === 'them' ? texts.them : texts.me[mine++] });
  listener.start({ mode: 'auto', sources: ['me', 'them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  await listener.idle();
  feed(listener, 'me', voice(1)); feed(listener, 'me', silence(1));
  feed(listener, 'me', voice(1)); feed(listener, 'me', silence(1));
  await listener.idle();
  assert.deepEqual(listener.entries.map(entry => `${entry.source}: ${entry.text}`), [`them: ${texts.them}`, `me: ${texts.me[1]}`]);
  assert.equal(listener.publicState().echoes, 1);
  await listener.stop();
});

test('live listening keeps running with failed audio and retries it while listening', async () => {
  let calls = 0;
  const { listener } = make({ transcribe: async () => (++calls === 1 ? Promise.reject(new Error('offline')) : 'recovered words') });
  listener.start({ mode: 'auto', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  await listener.idle();
  assert.equal(listener.failed.length, 1);
  await listener.retry();
  assert.equal(listener.failed.length, 0); assert.equal(listener.entries[0].text, 'recovered words');
  assert.equal(listener.listening, true);
  await listener.stop();
});

test('manual recording transcribes completed speech before Stop and keeps order', async () => {
  const { listener, events } = make();
  listener.start({ mode: 'manual', sources: ['them'] });
  feed(listener, 'them', voice(1.2)); feed(listener, 'them', silence(0.8)); feed(listener, 'them', voice(1.4));
  feed(listener, 'me', voice(2)); // not an enabled source
  await listener.idle();
  assert.equal(events.entries.length, 1, 'finished speech is transcribed while recording');
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
  assert.equal(events.errors.length, 1); assert.match(events.errors[0], /network down.*Retry transcription/);
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

test('non-speech markers are filtered but legitimate short replies survive', () => {
  assert.equal(cleanText('Thank you.', 1), 'Thank you.');
  assert.equal(cleanText('Okay.', 0.4), 'Okay.');
  assert.equal(cleanText(' [BLANK_AUDIO] ', 1), '');
  assert.equal(cleanText('Thank you.', 4), 'Thank you.');
  assert.equal(cleanText('What is the  budget?', 1), 'What is the budget?');
});

test('transcript text keeps the most recent lines within the budget', () => {
  const entries = Array.from({ length: 50 }, (_v, i) => ({ id: String(i), source: i % 2 ? 'me' : 'them', text: `line ${i}` }));
  const text = transcriptText(entries, 60);
  assert.ok(text.length <= 60); assert.match(text, /line 49$/); assert.doesNotMatch(text, /line 1\b/);
});

test('a single-input transcript has no speaker labels', () => {
  assert.equal(transcriptText([{ id: '1', source: 'them', text: 'Hello' }, { id: '2', source: 'them', text: 'How are you?' }]), 'Hello\nHow are you?');
});

test('failed audio can be retried in chronological order without duplicating successful segments', async () => {
  let fail = true, calls = 0;
  const { listener } = make({ transcribe: async () => { calls++; if (fail && calls === 1) throw new Error('offline'); return calls === 2 ? 'second sentence' : 'first sentence'; } });
  listener.start({ mode: 'manual', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1));
  feed(listener, 'them', voice(1));
  await listener.stop(); await listener.idle();
  assert.equal(listener.failed.length, 1);
  assert.throws(() => listener.start({ mode: 'manual', sources: ['them'] }), /retry/);
  fail = false; await listener.retry();
  assert.deepEqual(listener.entries.map(entry => entry.text), ['first sentence', 'second sentence']);
  assert.equal(new Set(listener.entries.map(entry => entry.id)).size, 2);
  assert.equal(listener.failed.length, 0);
  assert.equal(listener.publicState().backlogSeconds, 0);
});
test('clearing skips queued stale audio instead of sending it to the provider', async () => {
  let release, calls = 0;
  const { listener } = make({ transcribe: async () => { calls++; await new Promise(resolve => { release = resolve; }); return 'old words'; } });
  listener.start({ mode: 'manual', sources: ['them'] });
  feed(listener, 'them', voice(1)); feed(listener, 'them', silence(1)); feed(listener, 'them', voice(1));
  await listener.stop(); await new Promise(resolve => setImmediate(resolve));
  listener.clear(); release(); await listener.idle();
  assert.equal(calls, 1); assert.equal(listener.entries.length, 0); assert.equal(listener.pending, 0);
});
test('last transcript entry larger than the budget retains its newest words', () => {
  assert.equal(transcriptText([{ source: 'them', text: '1234567890 final words' }], 11), 'final words');
});
test('restoring a recording preserves its identity and order for Respond', () => {
  const { listener } = make();
  listener.restore([{ id: '1', source: 'them', text: 'first', order: 20, recordingId: 'recording' }, { id: '2', source: 'them', text: 'second', order: 21, recordingId: 'recording' }]);
  assert.equal(listener.recordingId, 'recording'); assert.equal(listener.sequence, 21);
});
