'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ClaudeAccount, ACCOUNT_MODELS, childEnvironment, answerArgs, questionMessage } = require('../overlay/claude-account');
const { PROVIDERS, PROVIDER_NAMES, modelDetails } = require('../overlay/models');
const { validateSettings, DEFAULTS } = require('../overlay/core');

// Each spawned client command is a fake process. `script(child, args, stdin)` plays its part.
function fixture(t, script, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencluely-claude-unit-'));
  const spawns = [];
  const client = new ClaudeAccount({ directory: home, resolveBinary: () => 'fixture-claude', timeoutMs: 200, loginTimeoutMs: 500, answerTimeoutMs: 1000,
    spawnImpl: (_exe, args, spawnOptions) => {
      const child = new EventEmitter();
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.killed = false;
      child.kill = () => { if (!child.killed) { child.killed = true; queueMicrotask(() => child.emit('close', 143)); } return true; };
      const record = { args, options: spawnOptions, child, input: '' };
      child.stdin.on('data', data => { record.input += data; });
      spawns.push(record);
      queueMicrotask(() => script(child, args, record));
      return child;
    }, ...options });
  t.after(() => client.stop());
  return { client, spawns, home };
}
const line = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');
const status = (account) => (child, args) => {
  if (args[0] === 'auth' && args[1] === 'status') { child.stdout.write(JSON.stringify(account)); child.emit('close', account.loggedIn ? 0 : 1); return true; }
};
const delta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const signedIn = { loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', subscriptionType: 'pro' };

test('Claude account is its own provider and leaves the API-key provider alone', () => {
  assert.ok(PROVIDERS.includes('claude') && PROVIDERS.includes('anthropic'));
  assert.equal(PROVIDER_NAMES.claude, 'Claude account');
  assert.equal(validateSettings({ provider: 'claude' }).provider, 'claude');
  assert.equal(validateSettings({ provider: 'anthropic' }).provider, 'anthropic');
  assert.equal(DEFAULTS.models.anthropic, 'claude-sonnet-5-5');
  assert.equal(modelDetails('claude', 'claude-sonnet-5-5').vision, true);
  assert.ok(ACCOUNT_MODELS.every(model => modelDetails('claude', model.id).reasoningEfforts.length));
});
test('the client sees only this app\'s credential namespace, never inherited keys or sessions', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'x', CLAUDE_CONFIG_DIR: '/other', CLAUDE_CODE_SESSION_ID: 'x', HOME: '/home/fixture' });
  try {
    const env = childEnvironment('/own-profile');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/own-profile');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SESSION_ID']) assert.equal(env[key], undefined, key);
    assert.equal(env.HOME, '/home/fixture');
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
test('answers run with every tool, server, skill, setting source and saved session disabled', () => {
  const args = answerArgs({ model: 'claude-sonnet-5-5', reasoningEffort: 'high' });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(!answerArgs({ model: 'claude-sonnet-5-5' }).includes('--effort'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});
test('question message carries quoted context and every image in order', () => {
  const image = (data) => ({ mime: 'image/jpeg', data });
  const value = questionMessage([
    { role: 'user', text: 'first', images: [image('AAA')] }, { role: 'assistant', text: 'reply' },
    { role: 'user', text: 'second', images: [image('BBB'), image('CCC')] }]);
  assert.equal(value.type, 'user');
  const content = value.message.content;
  assert.match(content[0].text, /Previous user message/);
  assert.deepEqual(content.filter(part => part.type === 'image').map(part => part.source.data), ['AAA', 'BBB', 'CCC']);
  assert.equal(content.find(part => part.text === 'second').type, 'text');
  assert.equal(content.at(-3).type, 'text');
});
test('account state reads the official client status without handling credentials', async t => {
  const { client, spawns } = fixture(t, status(signedIn));
  const state = await client.readAccount();
  assert.deepEqual([state.connected, state.email, state.planType, state.installed], [true, 'user@example.com', 'pro', true]);
  assert.deepEqual(spawns[0].args, ['auth', 'status']);
  assert.equal(spawns[0].options.env.CLAUDE_CONFIG_DIR, client.directory);
  const out = fixture(t, status({ loggedIn: false }));
  assert.equal((await out.client.readAccount()).connected, false);
  const missing = fixture(t, () => {}, { resolveBinary: () => { throw Object.assign(new Error('x'), { code: 'claude_not_installed' }); } });
  const absent = await missing.client.readAccount();
  assert.equal(absent.installed, false); assert.match(absent.error, /not installed/);
});
test('answers stream in order, send one stdin message, and finish on the result', async t => {
  const { client, spawns } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(signedIn)(child, args);
    setTimeout(() => {
      line(child, { type: 'system', subtype: 'init' });
      line(child, delta('Hel')); line(child, delta('lo'));
      line(child, { type: 'result', subtype: 'success', is_error: false, result: 'Hello' });
    }, 5);
  });
  await client.readAccount();
  const seen = [], statuses = [];
  const answer = await client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'hi', images: [] }], signal: new AbortController().signal,
    onDelta: text => seen.push(text), onStatus: text => statuses.push(text) });
  assert.deepEqual(seen, ['Hel', 'lo']); assert.equal(answer.text, 'Hello');
  assert.equal(statuses.length, 2);
  const run = spawns.at(-1);
  assert.equal(JSON.parse(run.input.trim()).message.content[0].text, 'hi');
});
test('a result without streamed chunks still delivers the answer once', async t => {
  const { client } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(signedIn)(child, args);
    setTimeout(() => line(child, { type: 'result', is_error: false, result: 'Whole answer' }), 5);
  });
  await client.readAccount();
  const seen = [];
  const answer = await client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: new AbortController().signal, onDelta: text => seen.push(text) });
  assert.deepEqual(seen, ['Whole answer']); assert.equal(answer.text, 'Whole answer');
});
test('separate text blocks are joined with a blank line', async t => {
  const { client } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(signedIn)(child, args);
    setTimeout(() => {
      line(child, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      line(child, delta('One'));
      line(child, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
      line(child, delta('Two'));
      line(child, { type: 'result', is_error: false, result: 'One\n\nTwo' });
    }, 5);
  });
  await client.readAccount();
  const answer = await client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: new AbortController().signal, onDelta() {} });
  assert.equal(answer.text, 'One\n\nTwo');
});
test('a rejected login fails at once with a sign-in message and disconnects the account', async t => {
  const { client } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(signedIn)(child, args);
    setTimeout(() => line(child, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 401, error: 'authentication_failed' }), 5);
  });
  await client.readAccount(); assert.equal(client.publicState().connected, true);
  const started = Date.now();
  await assert.rejects(client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: new AbortController().signal, onDelta() {} }),
    error => error.code === 'claude_auth' && /Sign in again/.test(error.message));
  assert.ok(Date.now() - started < 500);
  assert.equal(client.publicState().connected, false);
});
test('client errors become stable messages that never echo provider text', async t => {
  const failure = result => fixture(t, (child, args) => {
    if (args[1] === 'status') return status(signedIn)(child, args);
    setTimeout(() => line(child, { type: 'result', is_error: true, result }), 5);
  });
  for (const [result, code] of [['Claude usage limit reached for sk-secret-prompt', 'claude_limit'], ['Not logged in · Please run /login', 'claude_auth'], ['something prompt-specific broke', 'claude_request_failed']]) {
    const { client } = failure(result);
    await client.readAccount();
    await assert.rejects(client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: new AbortController().signal, onDelta() {} }),
      error => error.code === code && !/sk-secret|prompt-specific/.test(error.message));
  }
});
test('Stop ends the client process and reports a stopped answer', async t => {
  const { client, spawns } = fixture(t, (child, args) => { if (args[1] === 'status') return status(signedIn)(child, args); });
  await client.readAccount();
  const controller = new AbortController();
  const pending = client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: controller.signal, onDelta() {} });
  await delay(20); controller.abort();
  await assert.rejects(pending, /stopped/);
  assert.equal(spawns.at(-1).child.killed, true);
  assert.equal(client.activeTurn, null);
});
test('an answer needs a connected account and only one runs at a time', async t => {
  const { client } = fixture(t, (child, args) => { if (args[1] === 'status') return status(signedIn)(child, args); });
  await assert.rejects(client.answer({ model: 'm', messages: [], signal: new AbortController().signal, onDelta() {} }), error => error.code === 'claude_auth');
  await client.readAccount();
  const controller = new AbortController();
  const first = client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: controller.signal, onDelta() {} });
  await delay(10);
  await assert.rejects(client.answer({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', text: 'q' }], signal: new AbortController().signal, onDelta() {} }), /already running/);
  controller.abort(); await assert.rejects(first, /stopped/);
});
test('sign-in uses the official browser flow for a Claude subscription and then reads the account', async t => {
  let loggedIn = false;
  const { client, spawns } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(loggedIn ? signedIn : { loggedIn: false })(child, args);
    if (args[1] === 'login') setTimeout(() => { loggedIn = true; child.emit('close', 0); }, 10);
  });
  const changes = [];
  client.onChange = value => changes.push(value.signingIn);
  const state = await client.signIn();
  assert.deepEqual(spawns[0].args, ['auth', 'login', '--claudeai']);
  assert.equal(state.connected, true); assert.equal(state.signingIn, false);
  assert.ok(changes.includes(true));
});
test('sign-in can be canceled, fails cleanly, and times out', async t => {
  const hold = fixture(t, (child, args) => { if (args[1] === 'status') return status({ loggedIn: false })(child, args); });
  const pending = hold.client.signIn(); pending.catch(() => {});
  await delay(10); assert.equal(hold.client.publicState().signingIn, true);
  await hold.client.cancelSignIn();
  await assert.rejects(pending, error => error.code === 'claude_canceled');
  assert.equal(hold.spawns[0].child.killed, true);
  const failed = fixture(t, (child, args) => { if (args[1] === 'login') setTimeout(() => child.emit('close', 1), 5); });
  await assert.rejects(failed.client.signIn(), error => error.code === 'claude_login_failed');
  const slow = fixture(t, () => {}, { loginTimeoutMs: 40 });
  await assert.rejects(slow.client.signIn(), error => error.code === 'claude_timeout');
});
test('sign-out logs the app profile out and confirms it', async t => {
  let loggedIn = true;
  const { client, spawns } = fixture(t, (child, args) => {
    if (args[1] === 'status') return status(loggedIn ? signedIn : { loggedIn: false })(child, args);
    if (args[1] === 'logout') { loggedIn = false; child.emit('close', 0); }
  });
  await client.readAccount();
  const state = await client.signOut();
  assert.equal(state.connected, false);
  assert.ok(spawns.some(spawn => spawn.args[1] === 'logout'));
});
test('the model list is available only while signed in', async t => {
  const { client } = fixture(t, status(signedIn));
  const list = await client.listModels();
  assert.deepEqual(list.models.map(model => model.id), ACCOUNT_MODELS.map(model => model.id));
  const out = fixture(t, status({ loggedIn: false }));
  await assert.rejects(out.client.listModels(), /Sign in/);
});
