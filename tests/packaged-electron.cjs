'use strict';

const { app, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bundle = path.resolve(process.argv[2] || path.join(root, 'dist', `mac-${process.arch}`, 'Closed Cluely.app'));
const resources = path.join(bundle, 'Contents', 'Resources');
const archive = path.join(resources, 'app.asar');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'closedcluely-package-test-'));
app.setPath('userData', profile);
let client;
const results = [];
const watchdog = setTimeout(() => app.exit(1), 45000);

app.whenReady().then(async () => {
  const packaged = require(path.join(archive, 'package.json'));
  assert.equal(packaged.version, require('../package.json').version);
  const frameworkVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', path.join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(frameworkVersion, require('../package.json').devDependencies.electron);
  assert.equal(process.versions.electron, frameworkVersion);
  let count = 0;
  function compare(directory) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'bin') compare(relative); }
      else if (/\.(?:js|css|html|swift|mm)$/.test(entry.name)) {
        assert.deepEqual(fs.readFileSync(path.join(archive, relative)), fs.readFileSync(path.join(root, relative)), relative);
        count++;
      }
    }
  }
  compare('overlay');
  results.push(`Packaged version, Electron runtime and ${count} source files match`);

  const native = path.join(resources, 'app.asar.unpacked', 'overlay', 'native', 'bin');
  assert.equal(fs.existsSync(path.join(native, `recovery-helper-${process.arch}`)), false, 'No reopen helper ships');
  assert.equal(typeof require(path.join(native, `macos-panel-${process.arch}.node`)).configure, 'function');
  assert.ok(fs.existsSync(path.join(resources, 'app.asar.unpacked', 'overlay', 'models', 'silero_vad.onnx')));
  const sherpa = require(path.join(resources, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node'));
  const vad = new sherpa.Vad({ sileroVad: { model: path.join(resources, 'app.asar.unpacked', 'overlay', 'models', 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 30);
  vad.acceptWaveform(new Float32Array(512));
  results.push('Packaged Mac panel addon, Silero VAD model and on-device speech runtime load; no reopen helper ships');

  // The app's own modules, loaded from inside app.asar, must reach the unpacked
  // native runtime and the ESM PDF reader.
  assert.ok(require(path.join(archive, 'overlay', 'local-stt.js')).loadSherpa(), 'sherpa-onnx loads through the app module path');
  const stream = 'BT /F1 18 Tf 72 720 Td (Packaged agenda text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdfFile = path.join(profile, 'agenda.pdf'); fs.writeFileSync(pdfFile, pdf, 'latin1');
  assert.match(await require(path.join(archive, 'overlay', 'context.js')).extractText(pdfFile), /Packaged agenda text/);
  results.push('Packaged app modules load the speech runtime and extract PDF text from inside the archive');

  const { Store } = require(path.join(archive, 'overlay', 'storage.js'));
  const store = new Store(path.join(profile, 'encrypted'), safeStorage);
  assert.equal(store.available(), true);
  store.write('fixture.enc', { value: 'package-encryption-fixture' }, true);
  assert.equal(fs.readFileSync(store.file('fixture.enc')).includes(Buffer.from('package-encryption-fixture')), false);
  assert.equal(store.read('fixture.enc', null, true).value, 'package-encryption-fixture');
  const { ChatGPTAuth } = require(path.join(archive, 'overlay', 'chatgpt-auth.js'));
  const auth = new ChatGPTAuth({ store, openExternal: () => { throw Error('No browser consent in package tests'); } });
  assert.equal(auth.publicState().connected, false);
  results.push('Packaged ChatGPT module initializes and Keychain encryption round-trips');

  const { CodexConnection, binaryPath } = require(path.join(archive, 'overlay', 'codex.js'));
  assert.ok(binaryPath().startsWith(path.join(resources, 'app.asar.unpacked')));
  let opened;
  client = new CodexConnection({ directory: path.join(profile, 'codex'), openExternal: url => { opened = new URL(url); }, timeoutMs: 15000 });
  assert.equal((await client.readAccount()).connected, false);
  const login = client.signIn();
  const rejected = assert.rejects(login, /canceled/);
  const deadline = Date.now() + 15000;
  while (!opened && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(opened && ['auth.openai.com', 'chatgpt.com'].includes(opened.hostname));
  await client.cancelSignIn(); await rejected;
  assert.equal((await client.readAccount()).connected, false);
  results.push('Packaged Codex binary starts, creates an official login URL and cancels cleanly');

  for (const result of results) console.log(`PASS ${result}`);
  fs.writeFileSync(path.join(root, '.test-output', 'packaged-test-results.json'), JSON.stringify({ version: packaged.version, electron: process.versions.electron, results }, null, 2));
  return 0;
}).catch(error => { console.error(error); return 1; }).then(code => {
  clearTimeout(watchdog); client?.stop();
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
});
