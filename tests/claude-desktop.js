'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

exports.run = async ({ runtime, js, until, test, imageBytes }) => {
  const initial = structuredClone(runtime.currentState().settings);
  const credentials = fs.readFileSync(path.join(runtime.store.directory, 'credentials.enc'));
  let connected = false, loginPending = null, loginStarted = false, calls = [], defer = false, slow = false;
  const catalog = [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · balanced' }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 · fast' }];
  const fake = {
    publicState: () => ({ installed: true, connected, email: connected ? 'claude-owner@example.test' : '', planType: 'pro', busy: loginStarted, signingIn: loginStarted, error: '' }),
    async signIn() {
      loginStarted = true;
      try { if (defer) await new Promise((_resolve, reject) => { loginPending = reject; }); connected = true; }
      finally { loginStarted = false; loginPending = null; }
    },
    async cancelSignIn() { loginPending?.(new Error('Claude sign-in was canceled.')); },
    async signOut() { connected = false; },
    async listModels() { assert.ok(connected); return { models: structuredClone(catalog), total: 2, checkedAt: new Date().toISOString() }; },
    async answer(options) {
      calls.push(options); options.onDelta('Claude fixture answer');
      if (slow) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
      return { text: 'Claude fixture answer', truncated: false };
    },
    stop() {}
  };
  const previous = runtime.setClaudeController(fake);
  try {
    await test('Claude account sign-in fills only its own catalog and keeps the Claude API key separate', async () => {
      await js('document.getElementById("settingsButton").click();document.getElementById("settingsProvider").value="claude";document.getElementById("settingsProvider").dispatchEvent(new Event("change"))');
      assert.deepEqual(await js('[document.getElementById("claudeConnection").hidden,document.getElementById("codexConnection").hidden,document.getElementById("chatgptConnection").hidden,document.getElementById("apiKeyLabel").hidden]'), [false, true, true, true]);
      await js('document.getElementById("claudeSignIn").click()');
      await until(() => runtime.currentState().settings.provider === 'claude' && runtime.currentState().modelStatus.claude?.checkedAt);
      await until(async () => await js('!document.getElementById("claudeSignIn").disabled'));
      assert.deepEqual(runtime.currentState().modelCatalog.claude.map(item => item.id), catalog.map(item => item.id));
      assert.equal(runtime.currentState().keyStatus.claude, true);
      await assert.rejects(runtime.saveSettings({ provider: 'claude', apiKey: 'fixture-api-key-1234' }), /account sign-in/);
      await assert.rejects(runtime.saveSettings({ models: { claude: 'unavailable-model' } }), /available/);
      await js('document.getElementById("closeSettings").click()');
    });
    await test('Claude account text and image questions go only through the Claude connection', async () => {
      await runtime.ask({ text: 'Claude text question' }); await until(() => !runtime.currentState().busy);
      const image = runtime.importImage({ name: 'claude-question.png', data: imageBytes.toString('base64') });
      await runtime.ask({ text: 'Claude image question', imageId: image.id }); await until(() => !runtime.currentState().busy);
      assert.equal(calls.length, 2); assert.equal(calls[1].messages.at(-1).images.length, 1);
      assert.equal(calls[1].apiKey, undefined); assert.equal(calls[1].model, 'claude-sonnet-5-5');
      assert.equal(runtime.getHistory().at(-1).provider, 'claude');
      await until(async () => await js('document.querySelector(".message:last-child .message-header").textContent.includes("CLAUDE ACCOUNT")'));
    });
    await test('Claude sign-out cancels its answer and preserves other connections and API keys', async () => {
      slow = true; await runtime.ask({ text: 'Cancelable Claude question' });
      await until(() => runtime.currentState().busy);
      await js('document.getElementById("settingsButton").click();document.getElementById("claudeSignOut").click();document.getElementById("confirmClaudeSignOut").click()');
      await until(() => !runtime.currentState().claude.connected && !runtime.currentState().busy);
      await until(async () => await js('!document.getElementById("claudeSignIn").disabled'));
      assert.equal(calls.at(-1).signal.aborted, true); assert.deepEqual(runtime.currentState().modelCatalog.claude, []);
      assert.deepEqual(fs.readFileSync(path.join(runtime.store.directory, 'credentials.enc')), credentials);
    });
    await test('Claude canceled sign-in restores controls and leaves other accounts alone', async () => {
      const before = { chatgpt: structuredClone(runtime.currentState().chatgpt), codex: structuredClone(runtime.currentState().codex) };
      defer = true;
      await js('document.getElementById("claudeSignIn").click()');
      await until(() => loginPending);
      runtime.setClaudeController(fake);
      await until(async () => await js('!document.getElementById("claudeCancelSignIn").hidden'));
      await js('document.getElementById("claudeCancelSignIn").click()');
      await until(() => !loginStarted);
      await until(async () => await js('!document.getElementById("claudeSignIn").disabled'));
      assert.deepEqual(runtime.currentState().chatgpt, before.chatgpt); assert.deepEqual(runtime.currentState().codex, before.codex);
      assert.equal(runtime.currentState().claude.connected, false);
      await js('document.getElementById("closeSettings").click()');
    });
  } finally {
    await fake.cancelSignIn(); runtime.cancel(); await until(() => !runtime.currentState().busy);
    await js('for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close()');
    runtime.setClaudeController(previous); await runtime.saveSettings(initial);
    runtime.clear();
  }
};
