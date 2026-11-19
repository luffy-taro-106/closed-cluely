'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SYSTEM } = require('./providers');

const safeError = (code = 'claude_unavailable') => Object.assign(new Error({
  claude_unavailable: 'The Claude connection stopped. Check Settings and try again.',
  claude_not_installed: 'Claude Code is not installed. Install it from claude.com/claude-code, then reopen Settings.',
  claude_timeout: 'Claude did not respond in time. Check your connection and try again.',
  claude_login_failed: 'Claude sign-in was not completed. Try again in Settings.',
  claude_canceled: 'Claude sign-in was canceled.',
  claude_auth: 'The Claude account is signed out or its session expired. Sign in again in Settings.',
  claude_limit: 'Your Claude plan usage limit was reached. Try again later or choose another connection.',
  claude_request_failed: 'Claude could not complete this request. Check account access, usage and the selected model in Settings.'
}[code] || 'Claude could not complete this operation.'), { code });

// Models offered for the account connection. The official client accepts any ID
// the account can use, so Settings also offers a custom model ID.
const ACCOUNT_MODELS = Object.freeze([
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 · balanced' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 · advanced' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5 · fast' },
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1 · deep reasoning' }
]);

function binaryPath(env = process.env) {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const home = os.homedir();
  // A packaged GUI app does not inherit the shell's PATH, so check the usual install locations first.
  const candidates = [path.join(home, '.local', 'bin', name), path.join(home, '.claude', 'local', name),
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude', ...String(env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch { /* Try the next location. */ }
  }
  throw safeError('claude_not_installed');
}
function childEnvironment(profile) {
  // This app's own credential namespace. Never inherit another session's
  // ANTHROPIC_* keys, base URLs, bearer/OAuth tokens or CLAUDE_CODE_* settings.
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'userprofile', 'home', 'path', 'pathext', 'user', 'logname', 'shell',
    'appdata', 'localappdata', 'programdata', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'https_proxy', 'http_proxy', 'no_proxy',
    'ssl_cert_file', 'node_extra_ca_certs']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))),
    CLAUDE_CONFIG_DIR: profile, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}
function answerArgs({ model, reasoningEffort = 'auto' }) {
  // Print mode with every tool, skill, MCP server, hook source and saved session switched off.
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence',
    '--system-prompt', `${SYSTEM} Answer directly using only the supplied question, images and quoted context. Do not run tools, read local files, or change anything on the computer.`,
    '--model', model, ...(reasoningEffort === 'auto' || reasoningEffort === 'none' || reasoningEffort === 'minimal' ? [] : ['--effort', reasoningEffort])];
}
function questionMessage(messages) {
  const content = [];
  messages.forEach((message, index) => {
    content.push({ type: 'text', text: index === messages.length - 1 ? message.text || 'Please answer the attached image question.'
      : `Previous ${message.role} message (quoted conversation context):\n${message.text || ''}` });
    if (message.role === 'user') for (const image of message.images || (message.image ? [message.image] : []))
      content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } });
  });
  return { type: 'user', message: { role: 'user', content } };
}
const authFailure = text => /not logged in|please run \/login|log ?in|authenticat|invalid.*(token|credential)|\b401\b/i.test(text || '');
const limitFailure = text => /usage limit|rate.?limit|limit reached|\b429\b|overloaded_error/i.test(text || '');

// The official Claude Code client owns browser sign-in, credential storage and
// refresh inside this app's CLAUDE_CONFIG_DIR. No credential ever enters this module.
class ClaudeAccount extends EventEmitter {
  constructor({ directory, onChange = () => {}, spawnImpl = spawn, resolveBinary = binaryPath, timeoutMs = 20000, loginTimeoutMs = 300000, answerTimeoutMs = 10 * 60 * 1000 }) {
    super();
    this.directory = directory; this.workspace = path.join(directory, 'questions');
    this.onChange = onChange; this.spawn = spawnImpl; this.resolveBinary = resolveBinary;
    this.timeoutMs = timeoutMs; this.loginTimeoutMs = loginTimeoutMs; this.answerTimeoutMs = answerTimeoutMs;
    this.account = null; this.login = null; this.operation = false; this.error = null; this.activeTurn = null; this.children = new Set();
  }
  installed() { try { this.resolveBinary(); return true; } catch { return false; } }
  publicState() {
    return { installed: this.installed(), connected: !!this.account, email: this.account?.email || '', planType: this.account?.planType || '',
      busy: !!this.login || this.operation, signingIn: !!this.login, error: this.error };
  }
  notify() { try { this.onChange(this.publicState()); } catch { /* An observer cannot break the client. */ } }
  launch(args) {
    fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    const child = this.spawn(this.resolveBinary(), args, { cwd: this.workspace, env: childEnvironment(this.directory), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    child.stdin.on('error', () => {});
    // stderr may contain account or request information. Drain without logging.
    child.stderr.on('data', () => {});
    return child;
  }
  // Run a short client command and collect bounded stdout.
  run(args, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      let child, out = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); try { child?.kill(); } catch { /* Already gone. */ } error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(safeError('claude_timeout')), timeoutMs);
      try { child = this.launch(args); } catch (error) { finish(error.code ? error : safeError()); return; }
      child.stdin.end();
      child.stdout.on('data', data => { out += data; if (out.length > 1024 * 1024) finish(safeError()); });
      child.once('error', () => finish(safeError()));
      child.once('close', code => finish(code === 0 || args[1] === 'status' ? null : safeError('claude_unavailable'), out));
    });
  }
  async readAccount() {
    if (!this.installed()) { this.account = null; this.error = safeError('claude_not_installed').message; this.notify(); return this.publicState(); }
    try {
      const status = JSON.parse(await this.run(['auth', 'status']));
      this.account = status?.loggedIn === true ? { email: typeof status.email === 'string' ? status.email.slice(0, 320) : '',
        planType: typeof status.subscriptionType === 'string' ? status.subscriptionType.slice(0, 80) : '' } : null;
      this.error = null;
    } catch { this.account = null; }
    this.notify(); return this.publicState();
  }
  async signIn() {
    if (this.login || this.operation) throw new Error('Finish or cancel the current Claude account operation first.');
    if (!this.installed()) throw safeError('claude_not_installed');
    let resolve, reject, child;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    done.catch(() => {});
    const login = { finish: error => {
      if (this.login !== login) return;
      clearTimeout(login.timer); this.login = null; this.error = error?.message || null;
      try { child?.kill(); } catch { /* Already gone. */ }
      this.notify();
      if (error) reject(error); else resolve(this.publicState());
    } };
    this.login = login; this.error = null; this.notify();
    login.timer = setTimeout(() => login.finish(safeError('claude_timeout')), this.loginTimeoutMs);
    try {
      // The official client opens the system browser and receives the result itself.
      child = this.launch(['auth', 'login', '--claudeai']);
      child.stdout.on('data', () => {});
      child.stdin.end();
      child.once('error', () => login.finish(safeError('claude_login_failed')));
      child.once('close', code => {
        if (this.login !== login) return;
        if (code !== 0) { login.finish(safeError('claude_login_failed')); return; }
        this.readAccount().then(() => login.finish(this.account ? undefined : safeError('claude_login_failed')), () => login.finish(safeError('claude_login_failed')));
      });
    } catch (error) { login.finish(error.code ? error : safeError('claude_login_failed')); }
    return done;
  }
  async cancelSignIn() { this.login?.finish(safeError('claude_canceled')); }
  async signOut() {
    await this.cancelSignIn();
    if (this.operation) throw new Error('Wait for the current Claude operation.');
    this.operation = true; this.notify();
    try {
      await this.run(['auth', 'logout']);
      await this.readAccount();
      if (this.account) throw safeError();
      this.error = null; return this.publicState();
    } catch { this.error = 'Claude sign-out could not be confirmed. Try again before closing the app.'; throw new Error(this.error); }
    finally { this.operation = false; this.notify(); }
  }
  async listModels() {
    await this.readAccount();
    if (!this.account) throw new Error('Sign in to the Claude account connection in Settings first.');
    return { models: ACCOUNT_MODELS.map(model => ({ ...model })), total: ACCOUNT_MODELS.length, checkedAt: new Date().toISOString() };
  }
  async answer({ model, messages, reasoningEffort = 'auto', signal, onDelta, onStatus = () => {} }) {
    if (this.activeTurn) throw new Error('A Claude answer is already running.');
    signal.throwIfAborted();
    if (!this.account) throw safeError('claude_auth');
    let text = '', deltas = 0, separate = false, child, finished = false;
    let settle;
    const done = new Promise((resolve, reject) => { settle = error => { if (finished) return; finished = true; error ? reject(error) : resolve({ text, truncated: false }); }; });
    done.catch(() => {});
    const abort = () => { try { child?.kill(); } catch { /* Already gone. */ } settle(new Error('Answer stopped.')); };
    const append = delta => {
      const chunk = (separate && text ? '\n\n' : '') + delta; separate = false;
      text += chunk;
      if (text.length > 80000) { abort(); return; }
      onDelta(chunk); deltas++;
    };
    const event = value => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'system' && value.subtype === 'api_retry') {
        // A rejected login retries many times; surface it at once.
        if ([401, 403].includes(value.error_status)) { try { child?.kill(); } catch { /* Already gone. */ } this.account = null; this.notify(); settle(safeError('claude_auth')); }
        else if (value.error_status === 429) { try { child?.kill(); } catch { /* Already gone. */ } settle(safeError('claude_limit')); }
      } else if (value.type === 'stream_event') {
        const inner = value.event;
        if (inner?.type === 'content_block_start' && inner.content_block?.type === 'text') separate = deltas > 0;
        else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') append(inner.delta.text);
      } else if (value.type === 'result') {
        const result = typeof value.result === 'string' ? value.result : '';
        if (value.is_error) {
          if (authFailure(result)) { this.account = null; this.notify(); settle(safeError('claude_auth')); }
          else settle(safeError(limitFailure(result) ? 'claude_limit' : 'claude_request_failed'));
          return;
        }
        if (!deltas && result) append(result);
        if (!text.trim()) settle(safeError('claude_request_failed')); else settle();
      }
    };
    this.activeTurn = { abort };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => settle(safeError('claude_timeout')), this.answerTimeoutMs);
    try {
      onStatus('Connecting to Claude…');
      child = this.launch(answerArgs({ model, reasoningEffort }));
      let buffer = ''; const decoder = new StringDecoder('utf8');
      child.stdout.on('data', data => {
        buffer += decoder.write(data);
        if (buffer.length > 16 * 1024 * 1024) { try { child.kill(); } catch { /* Already gone. */ } settle(safeError()); return; }
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try { event(JSON.parse(line)); } catch { /* Ignore a malformed progress line. */ }
        }
      });
      child.once('error', () => settle(safeError()));
      child.once('close', () => settle(safeError('claude_request_failed')));
      child.stdin.end(JSON.stringify(questionMessage(messages)) + '\n');
      onStatus('Claude is answering…');
      return await done;
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort); this.activeTurn = null;
      try { child?.kill(); } catch { /* Already gone. */ }
    }
  }
  stop() {
    for (const child of this.children) { try { child.kill(); } catch { /* Already gone. */ } }
    this.children.clear(); this.login?.finish(safeError());
  }
}

module.exports = { ClaudeAccount, ACCOUNT_MODELS, binaryPath, childEnvironment, answerArgs, questionMessage };
