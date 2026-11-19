'use strict';

// Speech-to-text providers. Every provider receives one finished speech
// segment (16 kHz mono float samples) and returns plain text. Segments come
// from voice activity detection, so batch endpoints stay fast enough for live
// meetings: a typical utterance is 2–15 seconds of audio.

const SAMPLE_RATE = 16000;

const STT_PROVIDERS = ['local', 'openai', 'groq', 'deepgram', 'elevenlabs', 'assemblyai'];
const STT_NAMES = {
  local: 'On this device (local models)',
  openai: 'OpenAI (Whisper / GPT transcribe)',
  groq: 'Groq (Whisper large-v3)',
  deepgram: 'Deepgram',
  elevenlabs: 'ElevenLabs Scribe',
  assemblyai: 'AssemblyAI'
};
// Checked against each provider's documentation in November 2026. Any other
// model ID can be entered as a custom model.
const STT_MODELS = {
  openai: [
    { id: 'gpt-transcribe', name: 'GPT Transcribe (recommended)' },
    { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe' },
    { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe' },
    { id: 'whisper-1', name: 'Whisper (whisper-1)' }
  ],
  groq: [
    { id: 'whisper-large-v3-turbo', name: 'Whisper large-v3 turbo (fastest)' },
    { id: 'whisper-large-v3', name: 'Whisper large-v3 (most accurate)' }
  ],
  deepgram: [
    { id: 'nova-3', name: 'Nova-3' },
    { id: 'nova-3-general', name: 'Nova-3 general' },
    { id: 'nova-2-meeting', name: 'Nova-2 meeting' }
  ],
  elevenlabs: [
    { id: 'scribe_v2', name: 'Scribe v2' },
    { id: 'scribe_v3', name: 'Scribe v3' }
  ],
  assemblyai: [
    { id: 'universal-3-pro', name: 'Universal-3 Pro' },
    { id: 'universal-3-5-pro', name: 'Universal-3.5 Pro (preview)' },
    { id: 'universal-2', name: 'Universal-2' }
  ]
};
const STT_DEFAULT_MODELS = { local: 'parakeet-tdt-v2', openai: 'gpt-transcribe', groq: 'whisper-large-v3-turbo', deepgram: 'nova-3', elevenlabs: 'scribe_v2', assemblyai: 'universal-3-pro' };

class SttError extends Error {}

function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  if (!(samples instanceof Float32Array)) throw new SttError('Audio must be a Float32Array.');
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii'); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii'); buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0));
    buffer.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + i * 2);
  }
  return buffer;
}

async function failure(name, response) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.detail?.message || (typeof body?.detail === 'string' ? body.detail : '') || body?.err_msg || body?.error || body?.message || '';
  } catch { /* Bodies are optional. */ }
  if (typeof detail !== 'string') detail = '';
  const hint = response.status === 401 || response.status === 403 ? 'Check the speech-to-text API key in Listening settings.'
    : response.status === 429 ? 'The provider rate limit or quota was reached. Wait a moment or check your plan.'
      : response.status === 404 ? 'The selected transcription model is not available to this key.' : `Request failed (${response.status}).`;
  return new SttError(`${name}: ${hint}${detail ? ` ${detail.slice(0, 240)}` : ''}`);
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function audioForm(wav, fields) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== '') form.append(key, String(value));
  return form;
}

// `prompt` carries recent transcript and meeting vocabulary when the provider
// supports it, which improves names and jargon.
async function transcribeCloud({ provider, model, apiKey, samples, language = '', prompt = '', signal, fetchImpl = fetch, timeoutMs = 60000, pollMs = 700 }) {
  if (!apiKey) throw new SttError(`Add your ${STT_NAMES[provider]} key in Listening settings.`);
  const wav = encodeWav(samples);
  const options = extra => ({ ...extra, signal: timeoutSignal(signal, timeoutMs) });
  if (provider === 'openai' || provider === 'groq') {
    const url = provider === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.groq.com/openai/v1/audio/transcriptions';
    // gpt-transcribe takes `languages`; earlier models take `language`.
    const languageField = provider === 'openai' && model === 'gpt-transcribe' ? {} : { language };
    const promptField = model === 'gpt-4o-transcribe-diarize' ? {} : { prompt: model === 'whisper-1' ? prompt.slice(-800) : prompt.slice(-2000) };
    const response = await fetchImpl(url, options({ method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: audioForm(wav, { model, response_format: 'json', ...languageField, ...promptField }) }));
    if (!response.ok) throw await failure(STT_NAMES[provider], response);
    return String((await response.json()).text || '').trim();
  }
  if (provider === 'deepgram') {
    const query = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true', ...(language ? { language } : { detect_language: 'true' }) });
    const response = await fetchImpl(`https://api.deepgram.com/v1/listen?${query}`, options({ method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/wav' }, body: wav }));
    if (!response.ok) throw await failure('Deepgram', response);
    const body = await response.json();
    return String(body?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
  }
  if (provider === 'elevenlabs') {
    const response = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', options({ method: 'POST', headers: { 'xi-api-key': apiKey }, body: audioForm(wav, { model_id: model, language_code: language, tag_audio_events: 'false' }) }));
    if (!response.ok) throw await failure('ElevenLabs', response);
    return String((await response.json()).text || '').trim();
  }
  if (provider === 'assemblyai') {
    const headers = { authorization: apiKey };
    const upload = await fetchImpl('https://api.assemblyai.com/v2/upload', options({ method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: wav }));
    if (!upload.ok) throw await failure('AssemblyAI', upload);
    const { upload_url: audioUrl } = await upload.json();
    const submit = await fetchImpl('https://api.assemblyai.com/v2/transcript', options({ method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: audioUrl, speech_models: [model, ...(model === 'universal-2' ? [] : ['universal-2'])], ...(language ? { language_code: language } : { language_detection: true }) }) }));
    if (!submit.ok) throw await failure('AssemblyAI', submit);
    const { id } = await submit.json();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      signal?.throwIfAborted();
      const poll = await fetchImpl(`https://api.assemblyai.com/v2/transcript/${encodeURIComponent(id)}`, options({ headers }));
      if (!poll.ok) throw await failure('AssemblyAI', poll);
      const body = await poll.json();
      if (body.status === 'completed') return String(body.text || '').trim();
      if (body.status === 'error') throw new SttError(`AssemblyAI: ${String(body.error || 'Transcription failed.').slice(0, 240)}`);
    }
    throw new SttError('AssemblyAI: Transcription timed out.');
  }
  throw new SttError('Choose a speech-to-text provider.');
}

// A cheap authenticated request that does not transcribe or bill audio.
async function validateSttKey(provider, apiKey, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const checks = {
    openai: ['https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` }],
    groq: ['https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${apiKey}` }],
    deepgram: ['https://api.deepgram.com/v1/projects', { Authorization: `Token ${apiKey}` }],
    elevenlabs: ['https://api.elevenlabs.io/v1/models', { 'xi-api-key': apiKey }],
    assemblyai: ['https://api.assemblyai.com/v2/transcript?limit=1', { authorization: apiKey }]
  };
  if (!checks[provider]) throw new SttError('This provider does not use an API key.');
  const [url, headers] = checks[provider];
  let response;
  try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new SttError(`${STT_NAMES[provider]}: The key could not be checked. Check your connection and try again.`); }
  if (!response.ok) throw await failure(STT_NAMES[provider], response);
  return true;
}

module.exports = { SAMPLE_RATE, STT_PROVIDERS, STT_NAMES, STT_MODELS, STT_DEFAULT_MODELS, SttError, encodeWav, transcribeCloud, validateSttKey };
