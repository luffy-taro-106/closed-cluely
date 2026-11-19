'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeWav, transcribeCloud, validateSttKey, STT_PROVIDERS, STT_MODELS, STT_DEFAULT_MODELS } = require('../overlay/stt');

const samples = Float32Array.from({ length: 1600 }, (_v, i) => Math.sin(i / 8) * 0.5);
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options, calls.length); };
  fn.calls = calls; return fn;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('WAV encoding is 16-bit mono PCM at 16 kHz', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 2]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48), wav.readInt16LE(50)], [0, 32767, -32768, 32767], 'Clipped to range');
});

test('every cloud provider has a default model in its list', () => {
  for (const provider of STT_PROVIDERS.filter(id => id !== 'local')) assert.ok(STT_MODELS[provider].some(model => model.id === STT_DEFAULT_MODELS[provider]), provider);
});

test('OpenAI and Groq use the transcription endpoint with bearer auth and multipart audio', async () => {
  for (const [provider, url] of [['openai', 'https://api.openai.com/v1/audio/transcriptions'], ['groq', 'https://api.groq.com/openai/v1/audio/transcriptions']]) {
    const fetchImpl = fakeFetch(() => json({ text: '  Hello there.  ' }));
    const text = await transcribeCloud({ provider, model: provider === 'openai' ? 'gpt-4o-transcribe' : 'whisper-large-v3-turbo', apiKey: 'sk-test-key-123', samples, language: 'en', prompt: 'Earlier: quarterly plan', fetchImpl });
    assert.equal(text, 'Hello there.');
    const { url: called, options } = fetchImpl.calls[0];
    assert.equal(called, url); assert.equal(options.headers.Authorization, 'Bearer sk-test-key-123');
    const form = options.body; assert.ok(form instanceof FormData);
    assert.equal(form.get('language'), 'en'); assert.equal(form.get('prompt'), 'Earlier: quarterly plan');
    assert.equal((await form.get('file').arrayBuffer()).byteLength, 44 + samples.length * 2);
  }
});

test('gpt-transcribe omits the legacy language field', async () => {
  const fetchImpl = fakeFetch(() => json({ text: 'ok' }));
  await transcribeCloud({ provider: 'openai', model: 'gpt-transcribe', apiKey: 'sk-test-key-123', samples, language: 'en', fetchImpl });
  assert.equal(fetchImpl.calls[0].options.body.get('language'), null);
});

test('Deepgram sends raw WAV and reads the first alternative', async () => {
  const fetchImpl = fakeFetch(() => json({ results: { channels: [{ alternatives: [{ transcript: 'Deepgram words' }] }] } }));
  assert.equal(await transcribeCloud({ provider: 'deepgram', model: 'nova-3', apiKey: 'dg-test-key-123', samples, fetchImpl }), 'Deepgram words');
  const { url, options } = fetchImpl.calls[0];
  assert.match(url, /^https:\/\/api\.deepgram\.com\/v1\/listen\?/); assert.match(url, /model=nova-3/); assert.match(url, /detect_language=true/);
  assert.equal(options.headers.Authorization, 'Token dg-test-key-123'); assert.equal(options.headers['Content-Type'], 'audio/wav');
  assert.ok(Buffer.isBuffer(options.body));
});

test('ElevenLabs uses xi-api-key and model_id', async () => {
  const fetchImpl = fakeFetch(() => json({ text: 'Scribe words' }));
  assert.equal(await transcribeCloud({ provider: 'elevenlabs', model: 'scribe_v2', apiKey: 'el-test-key-123', samples, fetchImpl }), 'Scribe words');
  assert.equal(fetchImpl.calls[0].options.headers['xi-api-key'], 'el-test-key-123');
  assert.equal(fetchImpl.calls[0].options.body.get('model_id'), 'scribe_v2');
});

test('AssemblyAI uploads, submits and polls until complete', async () => {
  const fetchImpl = fakeFetch((url, _options, call) => {
    if (url.endsWith('/v2/upload')) return json({ upload_url: 'https://cdn.example/audio' });
    if (url.endsWith('/v2/transcript')) return json({ id: 'abc', status: 'queued' });
    return json(call < 5 ? { status: 'processing' } : { status: 'completed', text: 'Assembly words' });
  });
  assert.equal(await transcribeCloud({ provider: 'assemblyai', model: 'universal-3-pro', apiKey: 'aai-test-key-123', samples, fetchImpl, pollMs: 1 }), 'Assembly words');
  const submitted = JSON.parse(fetchImpl.calls[1].options.body);
  assert.deepEqual(submitted.speech_models, ['universal-3-pro', 'universal-2']); assert.equal(submitted.audio_url, 'https://cdn.example/audio');
  assert.equal(fetchImpl.calls[0].options.headers.authorization, 'aai-test-key-123');
});

test('provider errors explain the fix without leaking the key', async () => {
  const fetchImpl = fakeFetch(() => json({ error: { message: 'Incorrect API key provided' } }, 401));
  const error = await transcribeCloud({ provider: 'openai', model: 'whisper-1', apiKey: 'sk-secret-value-999', samples, fetchImpl }).catch(value => value);
  assert.match(error.message, /Check the speech-to-text API key/); assert.doesNotMatch(error.message, /sk-secret-value-999/);
  await assert.rejects(transcribeCloud({ provider: 'groq', model: 'x', apiKey: '', samples, fetchImpl }), /Add your Groq/);
});

test('key validation uses a non-billing request per provider', async () => {
  for (const provider of ['openai', 'groq', 'deepgram', 'elevenlabs', 'assemblyai']) {
    const fetchImpl = fakeFetch(() => json({}));
    assert.equal(await validateSttKey(provider, 'test-key-123456', { fetchImpl }), true);
    assert.doesNotMatch(fetchImpl.calls[0].url, /transcri(be|ptions)|listen\?|speech-to-text|upload/);
  }
  await assert.rejects(validateSttKey('deepgram', 'bad-key-123456', { fetchImpl: fakeFetch(() => json({}, 403)) }), /Check the speech-to-text API key/);
});
