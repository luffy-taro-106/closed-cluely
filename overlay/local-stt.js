'use strict';

// On-device transcription through sherpa-onnx (ONNX Runtime). Models are
// downloaded on request from the official k2-fsa/sherpa-onnx release, kept in
// the app profile, and never bundled. Nothing leaves the computer once a model
// is installed.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const LOCAL_MODELS = [
  { id: 'parakeet-tdt-v2', name: 'NVIDIA Parakeet TDT 0.6B v2 · English · best local accuracy', archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', kind: 'parakeet', sizeMB: 482, languages: 'en' },
  { id: 'parakeet-tdt-v3', name: 'NVIDIA Parakeet TDT 0.6B v3 · 25 European languages', archive: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', kind: 'parakeet', sizeMB: 487, languages: 'multi' },
  { id: 'whisper-turbo', name: 'OpenAI Whisper large-v3 turbo · multilingual', archive: 'sherpa-onnx-whisper-turbo', kind: 'whisper', sizeMB: 564, languages: 'multi' },
  { id: 'whisper-small.en', name: 'OpenAI Whisper small · English', archive: 'sherpa-onnx-whisper-small.en', kind: 'whisper', sizeMB: 636, languages: 'en' },
  { id: 'whisper-base.en', name: 'OpenAI Whisper base · English · light', archive: 'sherpa-onnx-whisper-base.en', kind: 'whisper', sizeMB: 209, languages: 'en' },
  { id: 'whisper-tiny.en', name: 'OpenAI Whisper tiny · English · fastest', archive: 'sherpa-onnx-whisper-tiny.en', kind: 'whisper', sizeMB: 118, languages: 'en' },
  { id: 'moonshine-base-en', name: 'Moonshine base · English · low latency on CPU', archive: 'sherpa-onnx-moonshine-base-en-int8', kind: 'moonshine', sizeMB: 251, languages: 'en' },
  { id: 'moonshine-tiny-en', name: 'Moonshine tiny · English · smallest', archive: 'sherpa-onnx-moonshine-tiny-en-int8', kind: 'moonshine', sizeMB: 108, languages: 'en' }
];
const TEN_VAD = { url: `${RELEASE}/ten-vad.onnx`, file: 'ten-vad.onnx' };

function loadSherpa() {
  try { return require('sherpa-onnx-node'); }
  catch { return null; }
}

// Prefer int8 weights; they are faster on CPU with negligible accuracy loss.
function pick(files, pattern) {
  const matches = files.filter(file => pattern.test(path.basename(file)));
  return matches.find(file => /int8/.test(file)) || matches[0] || '';
}
function listFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full)); else out.push(full);
  }
  return out;
}
function recognizerConfig(model, directory, { language = '', threads = 2 } = {}) {
  const files = listFiles(directory).filter(file => !/test_wavs/.test(file));
  const tokens = pick(files, /tokens\.txt$/);
  const common = { tokens, numThreads: threads, provider: 'cpu', debug: 0 };
  let modelConfig;
  if (model.kind === 'whisper') {
    const multilingual = model.languages !== 'en';
    modelConfig = { whisper: { encoder: pick(files, /encoder.*\.onnx$/), decoder: pick(files, /decoder.*\.onnx$/), language: multilingual ? language : '', task: 'transcribe', tailPaddings: -1 }, ...common };
  } else if (model.kind === 'parakeet') {
    modelConfig = { transducer: { encoder: pick(files, /^encoder.*\.onnx$/), decoder: pick(files, /^decoder.*\.onnx$/), joiner: pick(files, /^joiner.*\.onnx$/) }, modelType: 'nemo_transducer', ...common };
  } else {
    modelConfig = { moonshine: { preprocessor: pick(files, /^preprocess.*\.onnx$/), encoder: pick(files, /^encode.*\.onnx$/), uncachedDecoder: pick(files, /^uncached.*\.onnx$/), cachedDecoder: pick(files, /^cached.*\.onnx$/) }, ...common };
  }
  const needed = model.kind === 'whisper' ? [modelConfig.whisper.encoder, modelConfig.whisper.decoder] : model.kind === 'parakeet' ? Object.values(modelConfig.transducer) : Object.values(modelConfig.moonshine);
  if (!tokens || needed.some(file => !file)) throw new Error('The downloaded model is incomplete. Delete it in Listening settings and download it again.');
  return { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig };
}

class LocalStt {
  constructor({ directory, onChange = () => {}, fetchImpl = fetch, sherpa = loadSherpa() }) {
    this.directory = directory; this.onChange = onChange; this.fetchImpl = fetchImpl; this.sherpa = sherpa;
    this.downloads = new Map(); this.recognizers = new Map();
  }
  available() { return !!this.sherpa; }
  modelDirectory(id) { return path.join(this.directory, id); }
  installed(id) { return fs.existsSync(path.join(this.modelDirectory(id), '.complete')); }
  tenVadPath() { const file = path.join(this.directory, TEN_VAD.file); return fs.existsSync(file) ? file : ''; }
  publicState() {
    return {
      runtime: this.available(),
      models: LOCAL_MODELS.map(model => ({ id: model.id, name: model.name, sizeMB: model.sizeMB, languages: model.languages, installed: this.installed(model.id),
        download: this.downloads.get(model.id) ? { received: this.downloads.get(model.id).received, total: this.downloads.get(model.id).total, phase: this.downloads.get(model.id).phase } : null })),
      tenVad: !!this.tenVadPath(), tenVadDownloading: this.downloads.has('ten-vad')
    };
  }
  async downloadTenVad() {
    if (this.tenVadPath() || this.downloads.has('ten-vad')) return;
    const task = { received: 0, total: 0, phase: 'downloading', controller: new AbortController() };
    this.downloads.set('ten-vad', task); this.onChange();
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const response = await this.fetchImpl(TEN_VAD.url, { signal: task.controller.signal });
      if (!response.ok) throw new Error(`TEN VAD download failed (${response.status}).`);
      const temporary = path.join(this.directory, `${TEN_VAD.file}.part`);
      fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
      fs.renameSync(temporary, path.join(this.directory, TEN_VAD.file));
    } finally { this.downloads.delete('ten-vad'); this.onChange(); }
  }
  async download(id) {
    const model = LOCAL_MODELS.find(item => item.id === id);
    if (!model) throw new Error('Choose a listed local model.');
    if (this.installed(id)) return;
    if (this.downloads.has(id)) throw new Error('This model is already downloading.');
    const task = { received: 0, total: model.sizeMB * 1e6, phase: 'downloading', controller: new AbortController() };
    this.downloads.set(id, task); this.onChange();
    const target = this.modelDirectory(id), staging = `${target}.part`, archive = `${target}.tar.bz2`;
    let progressTimer = setInterval(() => this.onChange(), 750);
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true });
      const response = await this.fetchImpl(`${RELEASE}/${model.archive}.tar.bz2`, { signal: task.controller.signal, redirect: 'follow' });
      if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}). Check your connection and try again.`);
      task.total = Number(response.headers.get('content-length')) || task.total;
      const counter = new (require('node:stream').Transform)({ transform(chunk, _encoding, done) { task.received += chunk.length; done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(archive), { signal: task.controller.signal });
      task.phase = 'extracting'; this.onChange();
      fs.mkdirSync(staging, { recursive: true });
      // bsdtar ships with macOS and Windows 10+, and reads bzip2 archives.
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xjf', archive, '-C', staging], { stdio: 'ignore', windowsHide: true });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error('The model archive could not be extracted.')));
      });
      fs.rmSync(archive, { force: true });
      recognizerConfig(model, staging); // Validate that every required file exists.
      fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString());
      fs.renameSync(staging, target);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true }); fs.rmSync(archive, { force: true });
      throw task.controller.signal.aborted ? new Error('Model download cancelled.') : error;
    } finally { clearInterval(progressTimer); this.downloads.delete(id); this.onChange(); }
  }
  cancelDownload(id) { this.downloads.get(id)?.controller.abort(); }
  remove(id) {
    if (!LOCAL_MODELS.some(item => item.id === id)) throw new Error('Choose a listed local model.');
    if (this.downloads.has(id)) throw new Error('Cancel the download first.');
    // Recognizers are cached per language; release every one for this model.
    for (const key of [...this.recognizers.keys()]) if (key.startsWith(`${id}/`)) this.recognizers.delete(key);
    fs.rmSync(this.modelDirectory(id), { recursive: true, force: true });
    this.onChange();
  }
  async recognizer(id, language) {
    if (!this.sherpa) throw new Error('Local transcription is unavailable: the speech runtime could not load on this computer. Choose a cloud provider instead.');
    const model = LOCAL_MODELS.find(item => item.id === id);
    if (!model) throw new Error('Choose a local model in Listening settings.');
    if (!this.installed(id)) throw new Error(`Download ${model.name.split(' · ')[0]} in Listening settings first.`);
    const key = `${id}/${model.kind === 'whisper' ? language : ''}`;
    if (!this.recognizers.has(key)) {
      const config = recognizerConfig(model, this.modelDirectory(id), { language });
      this.recognizers.set(key, this.sherpa.OfflineRecognizer.createAsync(config).catch(error => { this.recognizers.delete(key); throw error; }));
    }
    return this.recognizers.get(key);
  }
  async transcribe({ model, samples, language = '' }) {
    const recognizer = await this.recognizer(model, language);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    const result = await recognizer.decodeAsync(stream);
    return String(result?.text || '').trim();
  }
}

module.exports = { LOCAL_MODELS, LocalStt, recognizerConfig, loadSherpa };
