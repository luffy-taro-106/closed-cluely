'use strict';

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, desktopCapturer, clipboard, ClipboardItem, nativeImage, dialog, safeStorage, session, powerMonitor, systemPreferences, shell, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { DEFAULTS, MAX_IMAGE_BYTES, MAX_IMAGES, imageIds, imageNames, validateSettings, validateQuestion, inspectImage, clampBounds, boundedContext, diskHistory, validateHistory } = require('./core');
const { streamAnswer, validateApiKey, listProviderModels } = require('./providers');
const { Store } = require('./storage');
const { ChatGPTAuth } = require('./chatgpt-auth');
const { CodexConnection } = require('./codex');
const { ClaudeAccount } = require('./claude-account');
const { InterruptedWork } = require('./interrupted-work');
const { STT_PROVIDERS, STT_NAMES, STT_MODELS, transcribeCloud, validateSttKey } = require('./stt');
const { LocalStt, loadSherpa } = require('./local-stt');
const { Listener } = require('./listener');
const { CONTEXT_EXTENSIONS, MAX_FILES, MAX_NOTES_CHARS, extractText, validateContext, contextSize, publicContext, meetingPreamble, MAX_CONTEXT_CHARS } = require('./context');
const { MODEL_CATALOG, PROVIDERS, PROVIDER_NAMES, EFFORTS, validModelId, modelDetails } = require('./models');
const { platformInfo, shortcutLabel, loginOptions, startHidden, startupAvailable } = require('./platform');
const platform = platformInfo();

const interruptionTestMode = !app.isPackaged && process.argv.includes('--interruption-smoke-test');
const testMode = !app.isPackaged && (process.argv.includes('--smoke-test') || interruptionTestMode);
if (interruptionTestMode) {
  const profile = path.resolve(process.argv.at(-1));
  const info = fs.lstatSync(profile);
  if (path.dirname(profile) !== fs.realpathSync(os.tmpdir()) || !path.basename(profile).startsWith('closedcluely-interruption-test-') ||
    !info.isDirectory() || info.isSymbolicLink()) throw new Error('Interruption tests require a disposable profile.');
  app.setPath('userData', profile);
} else if (testMode) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'closedcluely-test-')));
app.setName('Closed Cluely');
if (process.platform === 'win32') app.setAppUserModelId('com.closedcluely.app');

let win, tray, store, quitting = false, settings, keys = {}, history = [], active = null, lastAttempt = null;
let passThrough = false, captureBusy = false, settingsBusy = false, geometryTimer, normalBounds;
let panelNative = null, panelBehavior = { available: false, preventsActivation: false };
let screenshotRestore = true;
let launchHidden = false;
let interruptedWork, initializationComplete = false;
let localStt, listener, sttKeys = {}, meetingContext = { notes: '', files: [] }, listenStartEntries = 0, autoAnswerPending = null;
const sherpa = loadSherpa();
let chatgpt, loadedChatGPTProfile = null, chatgptSessionEpoch = 0, pendingAsk = null;
let codex, codexEpoch = 0;
let claude;
let archivedChats = [];
const images = new Map(), warnings = [], rendererRestarts = [], shortcuts = [];
const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024;
const draftImageIds = new Set();
const html = path.join(__dirname, 'ui', 'index.html');
let pageURL = pathToFileURL(html).href;
let answerFunction = streamAnswer;
let keyValidator = validateApiKey;
let modelLister = listProviderModels;
const modelCatalog = structuredClone(MODEL_CATALOG), modelStatus = {}, modelRefreshes = new Map();
let screenPermissionFunction = () => platform.mac ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
let sttFunction = null; // Tests replace transcription.
let microphonePermissionFunction = null; // Tests replace the macOS permission prompt.
function requestQuit() {
  if (listener?.listening) void stopListening({ answer: false }).catch(() => {});
  app.quit();
  return true;
}

function log(code) {
  try {
    const file = path.join(app.getPath('userData'), 'diagnostics.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 512000) fs.renameSync(file, `${file}.previous`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${code}\n`);
  } catch { /* Logging is best effort. No prompts, transcripts, keys or API bodies are logged. */ }
}
function warn(message) { if (!warnings.includes(message)) warnings.push(message); log('warning'); }
function emit(event) { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('overlay:event', event); }
function publicImage(image) { return { id: image.id, name: image.name, preview: image.preview, width: image.width, height: image.height }; }
function loginState() {
  if (!app.isPackaged) return {};
  try { return app.getLoginItemSettings(platform.mac ? {} : { path: process.execPath, args: ['--background'] }); }
  catch { return {}; }
}
function canStartAtLogin() {
  return startupAvailable(app.isPackaged, platform.mac && app.isInApplicationsFolder(), !!process.env.PORTABLE_EXECUTABLE_DIR);
}
function screenPermission() { return screenPermissionFunction(); }
function currentState() {
  return {
    settings, history: diskHistory(history), passThrough, panelBehavior, busy: !!active || !!pendingAsk, captureBusy,
    active: active ? { id: active.id, question: active.question, text: active.text, images: active.images.map(publicImage), provider: active.provider, model: active.model } : null,
    lastAttempt: lastAttempt ? { ...lastAttempt, images: imageIds(lastAttempt.question).map(id => images.get(id)).filter(Boolean).map(publicImage) } : null,
    maxImages: MAX_IMAGES,
    draftImages: [...draftImageIds].map(id => images.get(id)).filter(Boolean).map(publicImage),
    keyStatus: Object.fromEntries(PROVIDERS.map(provider => [provider, provider === 'claude' ? !!claude?.publicState().connected : provider === 'codex' ? !!codex?.publicState().connected : provider === 'chatgpt' ? !!chatgpt?.publicState().sharing : !!keys[provider]])),
    chatgpt: chatgpt?.publicState() || { profiles: [], activeProfileId: null, connected: false, sharing: false, busy: false, error: '' },
    claude: claude?.publicState() || { installed: false, connected: false, busy: false, signingIn: false, error: null },
    codex: codex?.publicState() || { connected: false, busy: false, signingIn: false, error: '' },
    modelCatalog, modelStatus,
    archivedChats: archivedChats.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    secureStorage: store.available(), warnings, shortcuts, platform,
    captureProtectionActive: !!win && !win.isDestroyed() && win.isContentProtected(),
    screenPermission: screenPermission(),
    startupAvailable: canStartAtLogin(), startupStatus: loginState().status || '',
    listening: listener?.publicState() || { listening: false, mode: settings?.listenMode || 'manual', pending: 0, levels: { me: 0, them: 0 }, speaking: { me: false, them: false }, sources: {} },
    transcript: (listener?.entries || []).slice(-300),
    stt: { providers: STT_PROVIDERS.map(id => ({ id, name: STT_NAMES[id] })), models: STT_MODELS, keyStatus: Object.fromEntries(STT_PROVIDERS.filter(id => id !== 'local').map(id => [id, !!sttKeys[id] || (id === 'openai' && !!keys.openai)])), sharedOpenAIKey: !sttKeys.openai && !!keys.openai, local: localStt?.publicState() || { runtime: false, models: [], tenVad: false } },
    meetingContext: publicContext(meetingContext),
    microphonePermission: platform.mac ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
    displays: screen.getAllDisplays().map((display, i) => ({ id: String(display.id), name: display.label || `Display ${i + 1}`, primary: display.id === screen.getPrimaryDisplay().id }))
  };
}
function syncState() { emit({ type: 'state', value: currentState() }); updateTray(); }

function codexChanged() {
  if (!codex?.publicState().connected) { modelCatalog.codex = []; delete modelStatus.codex; }
  if (win && !quitting) syncState();
}
async function changeCodexConnection(action, { signOut = false } = {}) {
  if (signOut && pendingAsk) { pendingAsk.controller.abort(); await pendingAsk.done; }
  if (settingsBusy) throw new Error('Wait for the current settings or sign-in operation.');
  if (active && !signOut) throw new Error('Stop the current answer before changing Codex accounts.');
  settingsBusy = true; codexEpoch++;
  try {
    if (signOut && active?.provider === 'codex') { const request = active; request.controller.abort(); await request.done; }
    const result = await action();
    modelCatalog.codex = []; delete modelStatus.codex;
    settings.models.codex = 'codex-auto'; settings.reasoningEfforts.codex = {};
    store.remove('codex-models.json');
    if (!signOut) settings.provider = 'codex';
    persistSettings();
    if (codex.publicState().connected) await refreshCodexModels();
    if (!quitting) showOverlay(false);
    syncState(); return currentState();
  } finally { settingsBusy = false; }
}
async function refreshCodexModels() {
  if (!codex) return;
  const epoch = codexEpoch;
  const previous = modelRefreshes.get('codex');
  if (previous?.epoch === epoch) return previous.promise;
  const task = { epoch };
  modelStatus.codex = { ...modelStatus.codex, refreshing: true, error: '' };
  task.promise = (async () => {
    try {
      const result = await codex.listModels();
      if (epoch !== codexEpoch || !codex.publicState().connected) return;
      modelCatalog.codex = result.models;
      modelStatus.codex = { source: 'live', total: result.total, checkedAt: result.checkedAt, refreshing: false, error: '' };
      if (!result.models.some(item => item.id === settings.models.codex) && result.models[0]) {
        settings.models.codex = result.models[0].id; persistSettings();
      }
      store.write('codex-models.json', result);
    } catch (error) {
      if (epoch === codexEpoch) modelStatus.codex = { ...modelStatus.codex, refreshing: false, error: error.message };
    } finally {
      if (modelRefreshes.get('codex') === task) modelRefreshes.delete('codex');
      if (!quitting) syncState();
    }
  })();
  modelRefreshes.set('codex', task); syncState(); return task.promise;
}

function claudeChanged() {
  if (!claude?.publicState().connected) { modelCatalog.claude = []; delete modelStatus.claude; }
  if (win && !quitting) syncState();
}
async function changeClaudeConnection(action, { signOut = false } = {}) {
  if (settingsBusy) throw new Error('Wait for the current settings or sign-in operation.');
  if (active && !signOut) throw new Error('Stop the current answer before changing the Claude account.');
  settingsBusy = true;
  try {
    if (signOut && active?.provider === 'claude') { const request = active; request.controller.abort(); await request.done; }
    await action();
    modelCatalog.claude = []; delete modelStatus.claude;
    settings.models.claude = DEFAULTS.models.claude;
    settings.reasoningEfforts.claude = {};
    if (!signOut) settings.provider = 'claude';
    persistSettings();
    if (claude.publicState().connected) await refreshClaudeModels();
    if (!quitting) showOverlay(false);
    syncState(); return currentState();
  } finally { settingsBusy = false; }
}
async function refreshClaudeModels() {
  if (!claude) return;
  modelStatus.claude = { ...modelStatus.claude, refreshing: true, error: '' };
  try {
    const result = await claude.listModels();
    if (!claude.publicState().connected) return;
    modelCatalog.claude = result.models.map(model => ({ ...modelDetails('claude', model.id), name: model.name }));
    modelStatus.claude = { source: 'bundled', total: result.total, checkedAt: result.checkedAt, refreshing: false, error: '' };
  } catch (error) { modelStatus.claude = { ...modelStatus.claude, refreshing: false, error: error.message }; }
  finally { if (!quitting) syncState(); }
}

function validCachedModels(entry) {
  return entry && Array.isArray(entry.models) && entry.models.length <= 1000 && Number.isFinite(entry.total) && Number.isFinite(Date.parse(entry.checkedAt)) &&
    entry.models.every(model => model && validModelId(model.id) && typeof model.name === 'string' && model.name.length <= 250 &&
      Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.every(value => EFFORTS.includes(value) && value !== 'auto') &&
      [null, 'effort', 'thinkingLevel', 'thinkingBudget'].includes(model.reasoningMode) && [null, 'adaptive', 'enabled'].includes(model.thinking) && (typeof model.vision === 'boolean' || model.vision === null));
}
function loadChatGPTProfile(force = false) {
  const account = chatgpt?.publicState();
  const id = account?.activeProfileId || null;
  if (!force && loadedChatGPTProfile === id) return;
  loadedChatGPTProfile = id;
  const preferences = id ? chatgpt.getProfilePreferences() : {};
  settings.models.chatgpt = validModelId(preferences.model) ? preferences.model : 'chatgpt-auto';
  settings.reasoningEfforts.chatgpt = Object.fromEntries(Object.entries(preferences.reasoningEfforts || {}).filter(([model, effort]) => validModelId(model) && EFFORTS.includes(effort)).slice(0, 500));
  modelCatalog.chatgpt = account?.sharing && validCachedModels(preferences) ? structuredClone(preferences.models) : [];
  delete modelStatus.chatgpt;
  if (modelCatalog.chatgpt.length) modelStatus.chatgpt = { source: 'cached', total: preferences.total, checkedAt: preferences.checkedAt, refreshing: false, error: '' };
}
function chatGPTChanged() {
  if (!settings || !chatgpt) return;
  loadChatGPTProfile();
  if (!chatgpt.publicState().sharing) { modelCatalog.chatgpt = []; delete modelStatus.chatgpt; }
  if (win && !quitting) syncState();
}
async function changeChatGPTConnection(action, { signOut = false, stopAnswer = true } = {}) {
  if (signOut && stopAnswer && pendingAsk) { pendingAsk.controller.abort(); await pendingAsk.done; }
  if (settingsBusy) throw new Error('Wait for the current settings or sign-in operation.');
  if (active && !signOut) throw new Error('Stop the current answer before changing ChatGPT accounts.');
  settingsBusy = true;
  chatgptSessionEpoch++;
  try {
    if (signOut && stopAnswer && active?.provider === 'chatgpt') { const request = active; request.controller.abort(); await request.done; }
    const result = await action();
    loadChatGPTProfile(true);
    if (!signOut) settings.provider = 'chatgpt';
    persistSettings();
    if (result?.warning) emit({ type: 'notice', text: result.warning });
    if (chatgpt.publicState().sharing) await refreshModels('chatgpt');
    if (!quitting) showOverlay(false);
    syncState();
    return currentState();
  } finally { settingsBusy = false; }
}

function persistModelCatalog() {
  try {
    store.write('model-catalog.json', Object.fromEntries(PROVIDERS.filter(provider => keys[provider] && modelStatus[provider]?.checkedAt)
      .map(provider => [provider, { models: modelCatalog[provider], total: modelStatus[provider].total, checkedAt: modelStatus[provider].checkedAt }])));
  } catch { warn('The refreshed model list could not be cached. It is available until you quit.'); }
}
function restoreModelCatalog() {
  const cached = store.read('model-catalog.json', {});
  for (const provider of PROVIDERS) {
    const entry = cached?.[provider];
    if (provider === 'chatgpt' || !keys[provider] || !validCachedModels(entry)) continue;
    modelCatalog[provider] = entry.models;
    modelStatus[provider] = { source: 'cached', total: entry.total, checkedAt: entry.checkedAt, refreshing: false, error: '' };
  }
}
async function refreshModels(provider = null) {
  if (provider !== null && !PROVIDERS.includes(provider)) throw new Error('Choose a valid AI provider.');
  await Promise.all((provider ? [provider] : PROVIDERS).map(async selected => {
    if (selected === 'chatgpt') return refreshChatGPTModels();
    if (selected === 'claude') return claude?.publicState().connected || selected === provider ? refreshClaudeModels() : undefined;
    if (selected === 'codex') return codex?.publicState().connected || selected === provider ? refreshCodexModels() : undefined;
    const apiKey = keys[selected];
    if (!apiKey) return;
    if (modelRefreshes.get(selected)?.apiKey === apiKey) return modelRefreshes.get(selected).promise;
    const task = { apiKey };
    modelStatus[selected] = { ...modelStatus[selected], refreshing: true, error: '' };
    task.promise = (async () => {
      try {
        const result = await modelLister(selected, apiKey);
        if (keys[selected] !== apiKey) return;
        modelCatalog[selected] = result.models;
        modelStatus[selected] = { source: 'live', total: result.total, checkedAt: result.checkedAt, refreshing: false, error: '' };
        persistModelCatalog();
      } catch (error) {
        if (keys[selected] !== apiKey) return;
        modelStatus[selected] = { ...modelStatus[selected], refreshing: false, error: error.message };
      } finally {
        if (modelRefreshes.get(selected) === task) modelRefreshes.delete(selected);
        if (!quitting) syncState();
      }
    })();
    modelRefreshes.set(selected, task);
    syncState();
    return task.promise;
  }));
  return currentState();
}
async function refreshChatGPTModels() {
  const account = chatgpt?.publicState();
  if (!account?.sharing) return;
  const profileId = account.activeProfileId, epoch = chatgptSessionEpoch;
  const previous = modelRefreshes.get('chatgpt');
  if (previous?.profileId === profileId && previous.epoch === epoch) return previous.promise;
  const task = { profileId, epoch };
  const isCurrent = () => epoch === chatgptSessionEpoch && profileId === chatgpt.publicState().activeProfileId && chatgpt.publicState().sharing;
  modelStatus.chatgpt = { ...modelStatus.chatgpt, refreshing: true, error: '' };
  task.promise = (async () => {
    try {
      const token = await chatgpt.accessToken();
      const result = await modelLister('chatgpt', token);
      if (!isCurrent()) return;
      const preferences = { models: result.models, total: result.total, checkedAt: result.checkedAt };
      if (settings.models.chatgpt === 'chatgpt-auto' && result.models[0]) preferences.model = result.models[0].id;
      chatgpt.setProfilePreferences(preferences, profileId);
      if (preferences.model) { settings.models.chatgpt = preferences.model; persistSettings(); }
      modelCatalog.chatgpt = result.models;
      modelStatus.chatgpt = { source: 'live', total: result.total, checkedAt: result.checkedAt, refreshing: false, error: '' };
    } catch (error) {
      if (isCurrent()) modelStatus.chatgpt = { ...modelStatus.chatgpt, refreshing: false, error: error.message };
    } finally {
      if (modelRefreshes.get('chatgpt') === task) modelRefreshes.delete('chatgpt');
      if (!quitting) syncState();
    }
  })();
  modelRefreshes.set('chatgpt', task);
  syncState();
  return task.promise;
}
function manualReopen() {
  if (!settings || quitting) return;
  showOverlay(!platform.mac);
}
function allowSessionEnd() { interruptedWork?.flush(); }
function persistSettings() { store.write('preferences.json', settings); }
function applyAppearance() {
  nativeTheme.themeSource = settings.theme;
  if (win && !win.isDestroyed()) win.setHasShadow(false);
}
function setTheme(theme) {
  const next = validateSettings({ theme }, settings);
  store.write('preferences.json', next);
  settings = next;
  applyAppearance(); syncState();
  return currentState();
}
function persistHistory() {
  try {
    if (settings.rememberHistory && store.available()) {
      store.write('chats.enc', { current: diskHistory(history), archive: archivedChats }, true);
      store.write('conversation.enc', diskHistory(history), true);
    } else { store.remove('conversation.enc'); store.remove('chats.enc'); }
    return true;
  } catch { warn('The conversation could not be saved. It is still available until you quit.'); return false; }
}
function clearInterruptedWork() {
  try { interruptedWork?.clear(); }
  catch { warn('The saved unfinished answer could not be removed. Check available storage and try again.'); }
}
function changeConversation(archiveId = null) {
  if (active) throw new Error('Stop the current answer before starting or switching chats.');
  if (settingsBusy || captureBusy) throw new Error('Wait for the current operation before switching chats.');
  const target = archiveId === null ? null : archivedChats.find(chat => chat.id === archiveId);
  if (archiveId !== null && !target) throw new Error('That conversation is no longer available.');
  if (listener?.listening) throw new Error('Stop recording before starting or switching chats.');
  if (listener?.pending) throw new Error('Wait for the recording to finish transcribing before switching chats.');
  const nextArchives = archivedChats.filter(chat => chat !== target);
  // Each chat is one meeting: its context and transcript travel with it.
  const hasContext = !!(meetingContext.notes.trim() || meetingContext.files.length);
  if (history.length || listener.entries.length || hasContext) {
    const title = history.find(message => message.role === 'user')?.text || meetingContext.notes.trim().split('\n')[0] || meetingContext.files[0]?.name || listener.entries[0]?.text || 'Meeting';
    nextArchives.unshift({ id: randomUUID(), title: title.slice(0, 80), updatedAt: new Date().toISOString(), history: diskHistory(history), context: meetingContext, transcript: listener.entries });
  }
  if (nextArchives.length > 100) throw new Error('You have 100 saved chats. Export and remove old conversations before starting another.');
  if (Buffer.byteLength(JSON.stringify(nextArchives), 'utf8') > 40 * 1024 * 1024) throw new Error('Saved chats are full. Delete older chats in Settings before starting another.');
  const nextHistory = target ? validateHistory(target.history) : [];
  const nextContext = target ? validateContext(target.context) : { notes: '', files: [] };
  const nextTranscript = target?.transcript || [];
  // Save the old conversation first; a failed archive write cannot clear it.
  if (settings.rememberHistory && store.available()) {
    store.write('chats.enc', { current: diskHistory(nextHistory), archive: nextArchives }, true);
  }
  archivedChats = nextArchives; history = nextHistory; images.clear(); draftImageIds.clear(); lastAttempt = null;
  meetingContext = nextContext; listener.clear(); listener.restore(nextTranscript);
  clearInterruptedWork();
  persistHistory(); persistMeetingContext(); persistTranscript(true);
  syncState(); return currentState();
}

function fitWindow() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  win.setBounds(clampBounds(bounds, display.workArea, settings.compact));
}
function applyWindowMode() {
  applyAppearance();
  if (!win || win.isDestroyed()) return;
  // Apply before first show, and restore after sleep, focus/mode changes or recovery.
  try { win.setContentProtection(settings.hideFromCapture); }
  catch { warn('Screen capture protection could not be enabled. Check Settings and your sharing preview before sharing.'); }
  win.setAlwaysOnTop(true, 'screen-saver');
  // Renderer layers control opacity so code boxes never inherit the app fade.
  win.setOpacity(1);
  win.setIgnoreMouseEvents(passThrough, { forward: true });
  const focusable = !passThrough;
  // Disabling focus alone does not release an existing key window on macOS.
  if (!focusable && platform.mac && win.isFocused()) win.blur();
  win.setFocusable(focusable);
  if (panelNative) {
    try { panelBehavior = panelNative.configure(win.getNativeWindowHandle()); }
    catch { warn('Native panel support could not be applied. Other apps may lose focus when using this overlay.'); }
  }
}
function showOverlay(focus = false) {
  if (!win || win.isDestroyed()) createWindow();
  if (focus) passThrough = false;
  applyWindowMode(); fitWindow();
  if (win.isMinimized()) win.restore();
  if (focus) { win.show(); win.focus(); }
  else win.showInactive();
  syncState();
  if (focus) emit({ type: 'focus-input' });
}
function hideOverlay() {
  screenshotRestore = false;
  if (win && !win.isDestroyed()) { win.hide(); applyWindowMode(); }
  syncState();
}
function toggleVisibility() { if (win?.isVisible()) hideOverlay(); else showOverlay(!platform.mac); }
function togglePassThrough() {
  passThrough = !passThrough;
  applyWindowMode(); syncState();
  if (!passThrough) showOverlay(!platform.mac);
  return passThrough;
}
function saveGeometry() {
  clearTimeout(geometryTimer);
  geometryTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || quitting) return;
    const bounds = win.getBounds();
    settings.bounds = settings.compact ? { ...bounds, height: normalBounds?.height || 700 } : bounds;
    if (!settings.compact) normalBounds = bounds;
    try { persistSettings(); } catch { warn('Window position could not be saved.'); }
  }, 350);
}
function toggleCompact() {
  if (!win || win.isDestroyed()) return false;
  if (!settings.compact) normalBounds = win.getBounds();
  settings.compact = !settings.compact;
  const bounds = settings.compact ? win.getBounds() : { ...win.getBounds(), height: normalBounds?.height || 700 };
  win.setMinimumSize(360, settings.compact ? 122 : 440);
  win.setBounds(clampBounds(bounds, screen.getDisplayMatching(bounds).workArea, settings.compact));
  try { persistSettings(); } catch { warn('Window preference could not be saved.'); }
  syncState(); return settings.compact;
}
function recoverRenderer(reason) {
  if (quitting || !win || win.isDestroyed()) return;
  // Provider requests and their checkpoints live in main. A renderer crash
  // should not interrupt a healthy request; the reloaded UI receives its state.
  const now = Date.now();
  rendererRestarts.push(now);
  while (rendererRestarts[0] < now - 60000) rendererRestarts.shift();
  log(`renderer-restart:${reason}`);
  // Capture lives in the renderer; a reload ends it.
  if (listener?.listening) void stopListening({ answer: false }).catch(() => {});
  passThrough = false; applyWindowMode();
  if (rendererRestarts.length <= 3) win.reload();
  else {
    hideOverlay();
    dialog.showMessageBox({ type: 'error', title: 'Overlay needs a restart', message: 'The overlay failed repeatedly. Your saved conversation is preserved.', detail: 'Use the tray menu to show the overlay again, or quit and reopen the app.', buttons: ['OK'] }).catch(() => {});
  }
}
function createWindow() {
  const saved = settings.bounds;
  const display = saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay();
  normalBounds = clampBounds(saved, display.workArea, false);
  win = new BrowserWindow({
    ...clampBounds(saved, display.workArea, settings.compact), minWidth: 360, minHeight: settings.compact ? 122 : 440,
    title: 'Chat',
    frame: false, transparent: true, backgroundColor: '#00000000', show: false,
    ...(platform.mac ? { type: 'panel', hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
    alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true, maximizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), partition: 'overlay-memory', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: true, spellcheck: false }
  });
  if (platform.mac) {
    try {
      panelNative = require(path.join(__dirname, 'native/bin', `macos-panel-${process.arch}.node`));
      panelBehavior = panelNative.configure(win.getNativeWindowHandle());
      if (!panelBehavior.available || !panelBehavior.preventsActivation) warn('Native activation prevention is unavailable on this Mac. Browser focus preservation is best effort.');
    } catch { warn('Native panel support is unavailable. Reinstall the Mac app to restore focus-preserving behavior.'); }
  }
  // The app is already an accessory. Avoid process transformations that flash/hide the window.
  if (platform.mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  applyWindowMode();
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => recoverRenderer(details.reason));
  win.on('unresponsive', async () => {
    log('renderer-unresponsive');
    const result = await dialog.showMessageBox({ type: 'warning', title: 'Overlay is busy', message: 'The overlay is not responding.', buttons: ['Reload overlay', 'Wait'], defaultId: 1, cancelId: 1 });
    if (result.response === 0) recoverRenderer('unresponsive');
  });
  win.on('close', event => { if (!quitting) { event.preventDefault(); hideOverlay(); } });
  win.on('query-session-end', allowSessionEnd);
  win.on('session-end', allowSessionEnd);
  win.on('closed', () => { win = null; });
  win.on('move', saveGeometry); win.on('resize', saveGeometry);
  if (platform.mac) for (const event of ['focus', 'blur']) win.on(event, () => {
    if (quitting || !win || win.isDestroyed()) return;
    if (panelNative) {
      try { panelBehavior = panelNative.inspect(win.getNativeWindowHandle()); }
      catch { log('panel-inspection-failed'); }
    }
    syncState();
  });
  win.webContents.on('did-finish-load', () => syncState());
  win.webContents.on('did-fail-load', (_event, code) => { if (code !== -3) { warn('The overlay could not load. Quit and reopen from the tray.'); } });
  win.once('ready-to-show', () => { if (!testMode && !launchHidden) win.showInactive(); });
  const initialPage = pathToFileURL(html);
  initialPage.searchParams.set('theme', settings.theme);
  pageURL = initialPage.href;
  win.loadURL(pageURL).catch(() => warn('The overlay could not load.'));
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Closed Cluely', enabled: false },
    { label: 'Show and type a question', click: () => showOverlay(true) },
    { label: win?.isVisible() ? 'Hide overlay (keep running)' : 'Show overlay without focus', click: () => win?.isVisible() ? hideOverlay() : showOverlay(false) },
    { type: 'separator' },
    { label: 'Click-through', type: 'checkbox', checked: passThrough, click: togglePassThrough },
    { label: 'Compact view', type: 'checkbox', checked: settings.compact, click: toggleCompact },
    { label: 'Settings', click: () => { showOverlay(true); emit({ type: 'open-settings' }); } },
    { label: listener?.listening ? 'Stop listening' : 'Start listening', click: () => { showOverlay(false); emit({ type: 'toggle-listen' }); } },
    ...(platform.mac ? [{ label: 'Screen Recording permission…', click: () => { void openScreenSettings().catch(() => {}); } }] : []),
    { type: 'separator' },
    { label: 'Quit Closed Cluely', click: requestQuit }
  ]));
}

function addImage(native, name) {
  if (!native || native.isEmpty()) throw new Error('This image could not be decoded. Choose a different PNG or JPEG.');
  const original = native.getSize();
  if (original.width * original.height > 32_000_000) throw new Error('The image exceeds 32 megapixels.');
  const ratio = Math.min(1, 2560 / Math.max(original.width, original.height));
  const resized = ratio < 1 ? native.resize({ width: Math.round(original.width * ratio), height: Math.round(original.height * ratio), quality: 'best' }) : native;
  const bytes = resized.toJPEG(92);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('The processed image is too large. Please crop it first.');
  const size = resized.getSize();
  const preview = resized.resize({ width: Math.min(260, size.width), quality: 'good' }).toDataURL();
  const image = { id: randomUUID(), name: String(name || 'Image').slice(0, 160), mime: 'image/jpeg', data: bytes.toString('base64'), preview, ...size };
  // Composer attachments and all images in a running request must survive
  // cache eviction. Older history retains attachment names after pixels expire.
  while (images.size >= MAX_IMAGES * 2) {
    const removable = [...images.keys()].find(id => !imageIds(active?.question).includes(id) && !draftImageIds.has(id));
    if (!removable) throw new Error('Image memory is full. Finish the answer or remove a queued image first.');
    images.delete(removable);
  }
  images.set(image.id, image);
  return publicImage(image);
}
function importImage(input) {
  if (!input || typeof input.data !== 'string' || input.data.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new Error('Choose a PNG or JPEG up to 10 MB.');
  const bytes = Buffer.from(input.data, 'base64');
  inspectImage(bytes);
  return addImage(nativeImage.createFromBuffer(bytes), input.name);
}
async function capture(displayId) {
  if (captureBusy) throw new Error('A screenshot is already in progress.');
  if (['denied', 'restricted'].includes(screenPermission())) throw new Error('Allow Closed Cluely in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen the app. You can still upload or paste images.');
  if (displayId != null && (typeof displayId !== 'string' || !screen.getAllDisplays().some(display => String(display.id) === displayId))) throw new Error('That display is no longer connected.');
  captureBusy = true;
  screenshotRestore = true;
  const visible = win && !win.isDestroyed() && win.isVisible();
  const display = displayId ? screen.getAllDisplays().find(display => String(display.id) === displayId) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (visible) win.hide();
  try {
    await new Promise(resolve => setTimeout(resolve, 180));
    const scale = Math.min(display.scaleFactor || 1, 2560 / Math.max(display.size.width, display.size.height));
    let captureTimer;
    let sources;
    try {
      sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) } }),
        new Promise((_resolve, reject) => { captureTimer = setTimeout(() => reject(new Error('Screenshot timed out. Upload an image or try again.')), 10000); })
      ]);
    } finally { clearTimeout(captureTimer); }
    if (platform.mac && screenPermission() !== 'granted') throw new Error('Enable Screen & System Audio Recording for Closed Cluely in System Settings, then quit and reopen it. Open Settings in the overlay for a shortcut.');
    const source = sources.find(source => source.display_id === String(display.id));
    if (!source) throw new Error('Could not capture this display. Check screen-recording permission or upload an image instead.');
    return addImage(source.thumbnail, `${display.label || 'Screen'} screenshot`);
  } finally {
    captureBusy = false;
    if (visible && screenshotRestore && win && !win.isDestroyed() && !quitting) { applyWindowMode(); win.showInactive(); }
    syncState();
  }
}

async function ask(input) {
  if (active) throw new Error('An answer is already running. Stop it before asking another question.');
  if (settingsBusy) throw new Error('Settings are being saved. Please try again.');
  const question = validateQuestion(input);
  const provider = settings.provider, model = settings.models[provider];
  let apiKey = keys[provider];
  if (provider === 'chatgpt') {
    if (!chatgpt.publicState().connected) throw new Error('Continue with ChatGPT in Settings to connect your account.');
    if (!chatgpt.publicState().sharing) throw new Error('Enable ChatGPT plan usage in Settings before asking a question.');
    if (!modelCatalog.chatgpt.some(item => item.id === model)) throw new Error('Refresh your ChatGPT models and choose an available model in Settings.');
    // Reserve the composer while a refresh is in progress so duplicate asks or
    // account changes cannot race token acquisition before active is assigned.
    settingsBusy = true;
    let settled;
    const pending = { controller: new AbortController(), done: new Promise(resolve => { settled = resolve; }) };
    pendingAsk = pending; syncState();
    try { apiKey = await chatgpt.accessToken({ signal: pending.controller.signal }); pending.controller.signal.throwIfAborted(); }
    finally { pendingAsk = null; settingsBusy = false; settled(); syncState(); }
  } else if (provider === 'claude') {
    if (!claude.publicState().connected) throw new Error('Sign in to your Claude account in Settings before asking a question.');
  } else if (provider === 'codex') {
    if (!codex.publicState().connected) throw new Error('Sign in to Codex in Settings before asking a question.');
    if (!modelCatalog.codex.some(item => item.id === model)) throw new Error('Refresh Codex models and choose an available model in Settings.');
  } else if (!apiKey) throw new Error(`Add your ${PROVIDER_NAMES[provider]} API key in Settings first.`);
  const attachments = question.imageIds.map(id => images.get(id));
  if (attachments.some(image => !image)) throw new Error('An attachment expired. Please attach the missing image again.');
  const modelInfo = modelCatalog[provider].find(item => item.id === model) || modelDetails(provider, model);
  if (modelInfo.vision === false && attachments.length) throw new Error('This model accepts text only. Select a vision model for images.');
  const savedEffort = settings.reasoningEfforts[provider]?.[model] || 'auto';
  const reasoningEffort = modelInfo.reasoningEfforts.includes(savedEffort) ? savedEffort : 'auto';
  const request = { id: randomUUID(), question, images: attachments, provider, model, text: '', controller: new AbortController() };
  active = request; lastAttempt = null;
  interruptedWork.start(request, history);
  emit({ type: 'start', id: request.id, question, images: attachments.map(publicImage), provider, model });
  updateTray();
  // Returning immediately lets the UI cancel while the stream is running.
  request.done = (async () => {
    try {
      const messages = boundedContext(history, question, id => images.get(id));
      const preamble = meetingPreamble(meetingContext, listener?.text(16000) || '');
      if (preamble) messages[0] = { ...messages[0], text: preamble + messages[0].text };
      const answer = await (provider === 'claude' ? options => claude.answer(options) : provider === 'codex' ? options => codex.answer(options) : answerFunction)({ provider, model, apiKey, reasoningEffort, modelInfo, messages, signal: request.controller.signal,
        onDelta: delta => { request.text += delta; interruptedWork.update(request, history); emit({ type: 'delta', id: request.id, text: delta }); },
        onStatus: text => emit({ type: 'status', id: request.id, text }) });
      request.controller.signal.throwIfAborted();
      request.text = answer.text;
      interruptedWork.start(request, history);
      const createdAt = new Date().toISOString();
      history.push({ id: randomUUID(), role: 'user', text: question.text, imageId: question.imageId, imageIds: question.imageIds, imageName: attachments[0]?.name, imageNames: attachments.map(image => image.name), createdAt },
        { id: request.id, role: 'assistant', text: answer.text, provider, model, createdAt });
      history = history.slice(-40);
      if (persistHistory()) clearInterruptedWork();
      emit({ type: 'done', id: request.id, text: answer.text, truncated: answer.truncated });
    } catch (error) {
      const message = request.controller.signal.aborted ? 'Answer stopped. You can retry when you are ready.' : error.message;
      lastAttempt = { id: request.id, question, text: request.text, error: message, provider, model, imageNames: attachments.map(image => image.name),
        ...(provider === 'chatgpt' ? { action: error.action || '', code: error.code || '', requestId: error.requestId || '' } : {}) };
      interruptedWork.start(request, history);
      emit({ type: 'error', ...lastAttempt }); log('request-failed');
    } finally {
      if (active === request) active = null;
      syncState();
      if (autoAnswerPending && !active) { autoAnswerPending = false; setTimeout(() => { void respondToMeeting({ automatic: true }).catch(() => {}); }, 50); }
    }
  })();
  return { id: request.id };
}

async function saveSettings(input) {
  if (settingsBusy) throw new Error('Settings are already being saved.');
  if (active) throw new Error('Stop the current answer before changing settings.');
  settingsBusy = true;
  try {
    const next = validateSettings(input, settings);
    if (['chatgpt', 'codex', 'claude'].includes(next.provider) && (input.removeKey === true || (typeof input.apiKey === 'string' && input.apiKey.trim()))) throw new Error('Use the account sign-in or Sign out controls for this connection. API keys use the separate OpenAI API key connection.');
    if (input.models?.chatgpt && input.models.chatgpt !== 'chatgpt-auto' && !modelCatalog.chatgpt.some(item => item.id === input.models.chatgpt)) throw new Error('Choose a model available to this ChatGPT account.');
    if (input.models?.codex && input.models.codex !== 'codex-auto' && !modelCatalog.codex.some(item => item.id === input.models.codex)) throw new Error('Choose a model available to the Codex connection.');
    if (input.models?.claude && input.models.claude !== DEFAULTS.models.claude && !modelCatalog.claude.some(item => item.id === input.models.claude)) throw new Error('Choose a model available to the Claude connection.');
    for (const [provider, choices] of Object.entries(input.reasoningEfforts || {})) {
      for (const [model, effort] of Object.entries(choices)) {
        const info = modelCatalog[provider].find(item => item.id === model) || modelDetails(provider, model);
        if (effort !== 'auto' && !info.reasoningEfforts.includes(effort)) throw new Error('This model does not support the selected reasoning effort.');
      }
    }
    if (next.rememberHistory && !store.available()) throw new Error('Secure storage is unavailable. Turn off conversation history to save preferences.');
    const nextKeys = { ...keys };
    let replacementKey = '';
    if (input.apiKey != null) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 500) throw new Error('Enter a valid API key, or leave the field blank to keep your saved key.');
      replacementKey = input.apiKey.trim();
      if (replacementKey && (/\s/.test(replacementKey) || replacementKey.length < 12)) throw new Error('Enter a valid API key, or leave the field blank to keep your saved key.');
      if (replacementKey && input.removeKey === true) throw new Error('Choose either replacing or removing the saved key.');
      if (replacementKey) {
        if (!store.available()) throw new Error('Secure storage is unavailable. The new key cannot be saved.');
        await keyValidator(next.provider, replacementKey);
        nextKeys[next.provider] = replacementKey;
      }
    }
    if (input.removeKey === true) delete nextKeys[next.provider];
    const startupChanged = next.launchAtLogin !== settings.launchAtLogin;
    if (startupChanged && !canStartAtLogin()) throw new Error(platform.startupHint);
    const credentialsChanged = !!replacementKey || input.removeKey === true;
    // A user can move/compact the window while the network check is in progress.
    next.bounds = settings.bounds;
    // Appearance can change while a key is being verified or an answer streams.
    if (!('theme' in input)) next.theme = settings.theme;
    if (!('compact' in input)) next.compact = settings.compact;
    const hadCredentials = fs.existsSync(path.join(store.directory, 'credentials.enc'));
    const profileId = chatgpt.publicState().activeProfileId;
    const oldChatGPTPreferences = profileId ? chatgpt.getProfilePreferences() : null;
    let chatgptPreferencesChanged = false;
    try {
      if (!next.rememberHistory) interruptedWork.clear();
      if (credentialsChanged) store.write('credentials.enc', nextKeys, true);
      if (startupChanged) {
        app.setLoginItemSettings(loginOptions(next.launchAtLogin, process.execPath));
        const login = loginState();
        if (platform.mac && next.launchAtLogin && !login.openAtLogin && login.status !== 'requires-approval') throw new Error('macOS did not enable launch at sign-in. Add Closed Cluely in System Settings → General → Login Items.');
      }
      if (profileId && (input.models?.chatgpt || input.reasoningEfforts?.chatgpt)) {
        chatgpt.setProfilePreferences({ model: next.models.chatgpt, reasoningEfforts: next.reasoningEfforts.chatgpt || {} }, profileId);
        chatgptPreferencesChanged = true;
      }
      store.write('preferences.json', next);
    } catch (error) {
      try {
        if (credentialsChanged) { if (hadCredentials) store.write('credentials.enc', keys, true); else store.remove('credentials.enc'); }
        if (chatgptPreferencesChanged) chatgpt.setProfilePreferences(oldChatGPTPreferences, profileId);
        if (startupChanged) app.setLoginItemSettings(loginOptions(settings.launchAtLogin, process.execPath));
      } catch { warn('Settings could not be fully restored after a disk error. Reopen Settings and check your preferences.'); }
      throw error;
    }
    settings = next; keys = nextKeys;
    if (credentialsChanged) {
      modelCatalog[next.provider] = structuredClone(MODEL_CATALOG[next.provider]);
      delete modelStatus[next.provider];
      persistModelCatalog();
      if (replacementKey && !testMode) void refreshModels(next.provider);
    }
    if (settings.rememberHistory && lastAttempt) interruptedWork.start(lastAttempt, history);
    applyWindowMode(); persistHistory(); persistTranscript(true); persistMeetingContext(); syncState();
    return currentState();
  } finally { settingsBusy = false; }
}

// ---------- Listening, transcription and meeting context ----------
const unpacked = file => file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
function segmenterOptions() {
  const ten = settings.vadEngine === 'ten' ? localStt.tenVadPath() : '';
  const engine = settings.vadEngine === 'ten' && !ten ? 'silero' : settings.vadEngine;
  return { engine, sherpa, modelPath: engine === 'ten' ? ten : unpacked(path.join(__dirname, 'models', 'silero_vad.onnx')),
    threshold: settings.vadThreshold, endSilenceMs: settings.endSilenceMs };
}
function sttKeyFor(provider) { return sttKeys[provider] || (provider === 'openai' ? keys.openai || '' : ''); }
function transcribe(source, samples, prompt) {
  if (sttFunction) return sttFunction({ source, samples, prompt });
  const provider = settings.sttProvider, model = settings.sttModels[provider], language = settings.sttLanguage;
  if (provider === 'local') return localStt.transcribe({ model, samples, language });
  return transcribeCloud({ provider, model, apiKey: sttKeyFor(provider), samples, language, prompt });
}
function sttReadiness() {
  const provider = settings.sttProvider, model = settings.sttModels[provider];
  if (provider === 'local') {
    if (!localStt.available()) return 'Local transcription could not load on this computer. Choose a cloud speech-to-text provider in Listening settings.';
    if (!localStt.installed(model)) return 'Download the selected local speech model in Listening settings first, or choose a cloud provider.';
    return '';
  }
  return sttKeyFor(provider) ? '' : `Add your ${STT_NAMES[provider]} API key in Listening settings.`;
}
let transcriptTimer = null;
function persistTranscript(now = false) {
  clearTimeout(transcriptTimer);
  const write = () => {
    try {
      if (settings.rememberHistory && store.available()) store.write('transcript.enc', listener.entries, true);
      else store.remove('transcript.enc');
    } catch { warn('The transcript could not be saved. It is still available until you quit.'); }
  };
  if (now) write(); else transcriptTimer = setTimeout(write, 1500);
}
function persistMeetingContext() {
  try {
    if (settings.rememberHistory && store.available()) store.write('meeting-context.enc', meetingContext, true);
    else store.remove('meeting-context.enc');
  } catch { warn('Meeting context could not be saved. It is still available until you quit.'); }
}
async function prepareListening() {
  if (listener.listening) throw new Error('Recording has already started.');
  const problem = sttReadiness();
  if (problem) throw new Error(problem);
  if (platform.mac) {
    let status = microphonePermissionFunction ? await microphonePermissionFunction() : systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') status = await systemPreferences.askForMediaAccess('microphone') ? 'granted' : 'denied';
    if (status !== 'granted') {
      if (!testMode) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone').catch(() => {});
      throw new Error('Allow Closed Cluely in System Settings → Privacy & Security → Microphone. BlackHole and other audio inputs also need this permission.');
    }
  }
  return { device: settings.themDevice, platform };
}
function startListening(input) {
  // One input, recorded between Start and Stop. Speech is stored as "them": the
  // other person talking.
  if (!Array.isArray(input?.sources) || !input.sources.includes('them')) throw new Error('No audio input was opened.');
  listener.start({ mode: 'manual', sources: ['them'] });
  listenStartEntries = listener.entries.length;
  log('recording-started');
  syncState(); return currentState();
}
async function stopListening({ answer = true } = {}) {
  if (!listener.listening) return currentState();
  const mode = listener.mode;
  await listener.stop();
  emit({ type: 'listen-stopped' });
  syncState();
  // Return at once so Stop never waits for transcription; answer when it finishes.
  if (mode === 'manual' && answer) void listener.idle().then(() => {
    if (settings.autoAnswer && listener.entries.length > listenStartEntries) return respondToMeeting({ automatic: true });
  }).catch(error => emit({ type: 'notice', text: error.message }));
  return currentState();
}
async function respondToMeeting({ automatic = false } = {}) {
  const entries = listener.entries;
  // Answer the latest recording as a whole (it may span several pauses).
  const latest = entries.length > listenStartEntries ? entries.slice(listenStartEntries) : entries.slice(-1);
  if (!latest.length) throw new Error('Nothing has been transcribed yet. Press Start, then Stop when the other person finishes.');
  if (active || pendingAsk || settingsBusy) {
    if (automatic) { autoAnswerPending = true; return null; }
    throw new Error('An answer is already running. Stop it or wait before asking again.');
  }
  if (automatic && !connectionReadyForAsk()) { emit({ type: 'notice', text: 'Transcribed. Connect an AI provider in Settings to get suggested answers.' }); return null; }
  const said = latest.map(entry => entry.text).join(' ');
  const quote = said.length > 1500 ? `…${said.slice(-1500)}` : said;
  return ask({ text: `Help me respond to what was just said: "${quote}"`, imageIds: [] });
}
function connectionReadyForAsk() {
  const provider = settings.provider;
  return provider === 'claude' ? !!claude?.publicState().connected : provider === 'codex' ? !!codex?.publicState().connected
    : provider === 'chatgpt' ? !!chatgpt?.publicState().sharing : !!keys[provider];
}
function handleTurn(source, text) {
  if (source !== 'them' || listener.mode !== 'auto' || !listener.listening || !settings.autoAnswer) return;
  if (!text || text.split(/\s+/).length < 4) return;
  // The other side resumed speaking: wait for the real end of their turn.
  if (listener.speaking.them) return;
  void respondToMeeting({ automatic: true }).catch(error => emit({ type: 'notice', text: error.message }));
}
async function saveListenSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid listening settings.');
  const allowed = ['listenMode', 'sttProvider', 'sttModels', 'sttLanguage', 'vadEngine', 'vadThreshold', 'endSilenceMs', 'captureMe', 'captureThem', 'micDevice', 'themDevice', 'autoAnswer', 'showTranscript'];
  const changes = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
  if (listener.listening && Object.keys(changes).some(key => !['autoAnswer', 'showTranscript'].includes(key))) throw new Error('Stop listening before changing audio or transcription settings.');
  const next = validateSettings(changes, settings);
  const nextKeys = { ...sttKeys };
  const provider = next.sttProvider;
  if (typeof input.sttApiKey === 'string' && input.sttApiKey.trim()) {
    if (provider === 'local') throw new Error('Local models do not use an API key.');
    const key = input.sttApiKey.trim();
    if (key.length < 12 || key.length > 500 || /\s/.test(key)) throw new Error('Enter a valid API key.');
    if (!store.available()) throw new Error('Secure storage is unavailable. The key cannot be saved.');
    await sttKeyValidator(provider, key);
    nextKeys[provider] = key;
  }
  if (input.removeSttKey === true) delete nextKeys[provider];
  const keysChanged = JSON.stringify(nextKeys) !== JSON.stringify(sttKeys);
  if (keysChanged) store.write('stt-credentials.enc', nextKeys, true);
  next.bounds = settings.bounds; next.theme = settings.theme; next.compact = settings.compact;
  store.write('preferences.json', next);
  settings = next; sttKeys = nextKeys;
  if (settings.vadEngine === 'ten' && !localStt.tenVadPath()) void localStt.downloadTenVad().catch(() => emit({ type: 'notice', text: 'TEN VAD could not be downloaded. Silero VAD will be used until it is available.' }));
  syncState(); return currentState();
}
let sttKeyValidator = validateSttKey;
function saveMeetingContext(input) {
  if (!input || typeof input !== 'object' || typeof input.notes !== 'string') throw new Error('Invalid meeting notes.');
  if (input.notes.length > MAX_NOTES_CHARS) throw new Error(`Notes are limited to ${MAX_NOTES_CHARS.toLocaleString()} characters. Add longer material as a file.`);
  meetingContext = { ...meetingContext, notes: input.notes };
  persistMeetingContext(); syncState(); return currentState();
}
async function addContextFiles(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(file => typeof file !== 'string')) throw new Error('Choose files to add.');
  if (meetingContext.files.length + paths.length > MAX_FILES) throw new Error(`Add up to ${MAX_FILES} context files.`);
  const added = [], problems = [];
  for (const file of paths) {
    try { added.push({ id: randomUUID(), name: path.basename(file), text: await extractText(file), addedAt: new Date().toISOString() }); }
    catch (error) { problems.push(`${path.basename(file)}: ${error.message}`); }
  }
  meetingContext = validateContext({ ...meetingContext, files: [...meetingContext.files, ...added] });
  persistMeetingContext(); syncState();
  const size = contextSize(meetingContext);
  if (size > MAX_CONTEXT_CHARS) problems.push(`Meeting context is ${size.toLocaleString()} characters; only the first ${MAX_CONTEXT_CHARS.toLocaleString()} are sent with each question.`);
  return { state: currentState(), added: added.map(file => file.name), problems };
}

function handle(channel, action) {
  ipcMain.handle(`overlay:${channel}`, async (event, ...args) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pageURL) return { ok: false, error: 'Unauthorized app request.' };
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: error.message || 'This action could not be completed.' }; }
  });
}
async function openScreenSettings() {
  if (!platform.mac) return false;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return true;
}
function registerIPC() {
  handle('state', currentState); handle('ask', ask);
  handle('cancel', () => { pendingAsk?.controller.abort(); active?.controller.abort(); return true; });
  handle('set-attachments', ids => {
    const question = validateQuestion({ text: 'attachments', imageIds: ids });
    if (question.imageIds.some(id => !images.has(id))) throw new Error('An attachment expired. Attach the image again.');
    draftImageIds.clear(); for (const id of question.imageIds) draftImageIds.add(id);
    return true;
  });
  handle('upload', async (limit = MAX_IMAGES) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
    const result = await dialog.showOpenDialog(win, { title: 'Attach images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Question images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (result.canceled || !result.filePaths.length) return [];
    if (result.filePaths.length > limit) throw new Error(`Choose up to ${limit} more image${limit === 1 ? '' : 's'}.`);
    const selected = result.filePaths.map(file => {
      if (fs.statSync(file).size > MAX_IMAGE_BYTES) throw new Error('Choose images up to 10 MB each.');
      const bytes = fs.readFileSync(file); inspectImage(bytes);
      return { native: nativeImage.createFromBuffer(bytes), name: path.basename(file) };
    });
    const added = [];
    try { for (const item of selected) added.push(addImage(item.native, item.name)); return added; }
    catch (error) { for (const item of added) images.delete(item.id); throw error; }
  });
  handle('paste-image', async () => {
    const added = [];
    try {
      for (const item of await clipboard.read()) {
        const mime = item.types.find(type => ['image/png', 'image/jpeg'].includes(type));
        if (!mime) continue;
        const blob = await item.getType(mime);
        if (blob.size > MAX_IMAGE_BYTES) throw new Error('Choose a PNG or JPEG up to 10 MB.');
        const bytes = Buffer.from(await blob.arrayBuffer()); inspectImage(bytes);
        if (added.length >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question.`);
        added.push(addImage(nativeImage.createFromBuffer(bytes), 'Clipboard image'));
      }
      return added;
    } catch (error) { for (const item of added) images.delete(item.id); throw error; }
  });
  handle('import-image', importImage); handle('capture', capture);
  handle('release-image', id => { draftImageIds.delete(id); if (typeof id === 'string' && !history.some(message => imageIds(message).includes(id)) && !imageIds(active?.question).includes(id) && !imageIds(lastAttempt?.question).includes(id)) images.delete(id); return true; });
  handle('save-settings', saveSettings);
  handle('set-theme', setTheme);
  handle('refresh-models', refreshModels);
  handle('chatgpt-sign-in', options => changeChatGPTConnection(() => chatgpt.signIn(options || {})));
  handle('chatgpt-cancel-sign-in', () => { chatgpt.cancelSignIn(); return currentState(); });
  handle('chatgpt-select-profile', id => changeChatGPTConnection(() => chatgpt.selectProfile(id)));
  handle('chatgpt-sign-out', id => changeChatGPTConnection(() => chatgpt.signOut(id), { signOut: true, stopAnswer: !id || id === chatgpt.publicState().activeProfileId }));
  handle('chatgpt-manage-usage', async () => { await shell.openExternal('https://chatgpt.com/settings/usage'); return currentState(); });
  handle('codex-sign-in', () => changeCodexConnection(() => codex.signIn()));
  handle('codex-cancel-sign-in', async () => { await codex.cancelSignIn(); return currentState(); });
  handle('codex-sign-out', () => changeCodexConnection(() => codex.signOut(), { signOut: true }));
  handle('claude-sign-in', () => changeClaudeConnection(() => claude.signIn()));
  handle('claude-cancel-sign-in', async () => { await claude.cancelSignIn(); return currentState(); });
  handle('claude-sign-out', () => changeClaudeConnection(() => claude.signOut(), { signOut: true }));
  handle('screen-settings', openScreenSettings);
  handle('new-chat', () => changeConversation());
  handle('open-chat', id => { if (typeof id !== 'string') throw new Error('Choose a saved chat.'); return changeConversation(id); });
  handle('delete-chat', id => {
    if (typeof id !== 'string' || !archivedChats.some(chat => chat.id === id)) throw new Error('Choose a saved chat.');
    const next = archivedChats.filter(chat => chat.id !== id);
    if (settings.rememberHistory && store.available()) store.write('chats.enc', { current: diskHistory(history), archive: next }, true);
    archivedChats = next; syncState(); return currentState();
  });
  handle('clear', () => {
    if (active) throw new Error('Stop the answer before clearing the conversation.');
    // Remove the saved file first, so a disk failure does not falsely report deletion.
    interruptedWork.clear();
    if (settings.rememberHistory && store.available()) store.write('chats.enc', { current: [], archive: archivedChats }, true);
    store.remove('conversation.enc'); history = []; lastAttempt = null; images.clear(); draftImageIds.clear(); syncState(); return true;
  });
  handle('export', async () => {
    if (!history.length && !listener.entries.length) throw new Error('There is no conversation or transcript to export.');
    const result = await dialog.showSaveDialog(win, { title: 'Export conversation', defaultPath: 'Closed-Cluely-conversation.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled || !result.filePath) return false;
    const transcript = listener.text(Infinity);
    const content = history.map(message => `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${imageNames(message).map(name => `[Image: ${name}]\n\n`).join('')}${message.text}\n`).join('\n') + (transcript ? `\n## Meeting transcript\n\n${transcript}\n` : '');
    fs.writeFileSync(result.filePath, content, 'utf8'); return true;
  });
  handle('hide', hideOverlay); handle('pass-through', togglePassThrough); handle('compact', toggleCompact);
  handle('copy', async text => { if (typeof text !== 'string' || text.length > 80000) throw new Error('Invalid clipboard text.'); await clipboard.writeText(text); return true; });
  handle('quit', requestQuit);
  // Listening
  handle('listen-prepare', prepareListening);
  handle('listen-start', startListening);
  handle('listen-stop', () => stopListening());
  handle('listen-respond', () => respondToMeeting());
  handle('listen-save', saveListenSettings);
  handle('transcript-clear', () => { listener.clear(); persistTranscript(true); syncState(); return currentState(); });
  handle('stt-download', id => {
    if (typeof id !== 'string') throw new Error('Choose a local model.');
    void localStt.download(id).then(() => emit({ type: 'notice', text: 'Speech model installed. It runs entirely on this computer.' }))
      .catch(error => emit({ type: 'notice', text: error.message }));
    return currentState();
  });
  handle('stt-cancel-download', id => { localStt.cancelDownload(id); return currentState(); });
  handle('stt-remove', id => { if (listener.listening && settings.sttProvider === 'local' && settings.sttModels.local === id) throw new Error('Stop listening before deleting the model in use.'); localStt.remove(id); return currentState(); });
  handle('context-save', saveMeetingContext);
  handle('context-pick', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Add meeting context', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: CONTEXT_EXTENSIONS }] });
    if (result.canceled || !result.filePaths.length) return { state: currentState(), added: [], problems: [] };
    return addContextFiles(result.filePaths);
  });
  handle('context-add', addContextFiles);
  handle('context-remove', id => {
    if (typeof id !== 'string' || !meetingContext.files.some(file => file.id === id)) throw new Error('That file is no longer in the meeting context.');
    meetingContext = { ...meetingContext, files: meetingContext.files.filter(file => file.id !== id) };
    persistMeetingContext(); syncState(); return currentState();
  });
  handle('context-clear', () => { meetingContext = { notes: '', files: [] }; persistMeetingContext(); syncState(); return currentState(); });
  handle('microphone-settings', async () => { if (platform.mac) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'); return true; });
  ipcMain.on('overlay:audio', (event, source, samples) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
    if ((source !== 'me' && source !== 'them') || !(samples instanceof Float32Array) || samples.length > 16000) return;
    listener.feed(source, samples);
  });
}
async function screenshotToComposer() {
    try { if (draftImageIds.size >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question. Remove one before taking another screenshot.`); const image = await capture(); showOverlay(!platform.mac); emit({ type: 'attach', image }); }
    catch (error) { screenshotFailed(error); }
}
// Without Screen Recording a screenshot cannot work, so the notice comes with
// the right Settings page instead of leaving the user to find it.
function screenshotFailed(error) {
  showOverlay(false); emit({ type: 'notice', text: error.message });
  if (!testMode && ['denied', 'restricted'].includes(screenPermission())) void openScreenSettings().catch(() => {});
}
// F8: captures the screen and copies it to the clipboard only. Nothing is
// attached; F9 (or any paste) adds it to the question when wanted.
async function screenshotToClipboard() {
  try {
    const shot = await capture();
    const stored = images.get(shot.id);
    if (!stored) throw new Error('The screenshot could not be copied. Try again.');
    const png = nativeImage.createFromBuffer(Buffer.from(stored.data, 'base64')).toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    images.delete(shot.id);
    emit({ type: 'notice', text: 'Screenshot copied. Press F9 to paste it into your question.' });
  } catch (error) { screenshotFailed(error); }
}
// Pastes whatever is on the clipboard into the question box: an image becomes
// an attachment, text is inserted at the cursor.
async function pasteFromClipboard() {
  try {
    const native = await clipboardImage();
    if (native) {
      if (draftImageIds.size >= MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per question. Remove one before pasting another.`);
      const image = addImage(native, 'Clipboard image');
      showOverlay(true); emit({ type: 'attach', image }); return;
    }
    const text = await clipboard.readText();
    if (!text) throw new Error('The clipboard has no text or image to paste. Press F8 to take a screenshot first.');
    showOverlay(true); emit({ type: 'paste-text', text: text.slice(0, 12000) });
  } catch (error) { showOverlay(false); emit({ type: 'notice', text: error.message }); }
}
// An image file copied in Finder is read from disk; any other file is refused
// rather than pasted as its path. Web links on the clipboard stay ordinary text.
async function clipboardImage() {
  for (const item of await clipboard.read()) {
    const mime = item.types.find(type => ['image/png', 'image/jpeg'].includes(type));
    if (mime) {
      const blob = await item.getType(mime);
      if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('The clipboard image is too large. Please crop it first.');
      return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    }
    if (!item.types.includes('text/uri-list')) continue;
    const link = (await (await item.getType('text/uri-list')).text()).split(/\r?\n/).find(Boolean) || '';
    if (!link.startsWith('file:')) continue;
    const file = fileURLToPath(link);
    if (!/\.(png|jpe?g)$/i.test(file)) throw new Error('The clipboard has a file, not an image. Copy a PNG or JPEG, or press F8 to take a screenshot.');
    const bytes = fs.readFileSync(file); inspectImage(bytes);
    return nativeImage.createFromBuffer(bytes);
  }
  return null;
}
function registerShortcuts() {
  const commands = [
    ['CommandOrControl+Alt+Space', 'Show / hide', toggleVisibility],
    ['CommandOrControl+Alt+I', 'Click-through', togglePassThrough],
    ['CommandOrControl+Alt+S', 'Screenshot', screenshotToComposer],
    ['F6', 'Screenshot and attach (F6)', screenshotToComposer],
    ['F7', 'Show / hide (F7)', toggleVisibility],
    ['F8', 'Screenshot (F8)', screenshotToClipboard],
    ['F9', 'Paste (F9)', pasteFromClipboard],
    ['CommandOrControl+Alt+L', 'Listen', () => { showOverlay(false); emit({ type: 'toggle-listen' }); }],
    ['CommandOrControl+Alt+Enter', 'Respond', () => { showOverlay(false); void respondToMeeting().catch(error => emit({ type: 'notice', text: error.message })); }]
  ];
  for (const [accelerator, label, action] of commands) {
    let registered = false;
    try { registered = globalShortcut.register(accelerator, action); } catch { /* Surface conflicts in UI. */ }
    shortcuts.push({ accelerator, label, registered, display: shortcutLabel(accelerator) });
    if (!registered) warn(`${label} shortcut is unavailable because another app may be using it. Use the tray or overlay buttons.`);
  }
}

async function initialize() {
  if (platform.mac) {
    app.setActivationPolicy('accessory');
    // Native edit roles enable Command+C/V/X/A in the frameless accessory window.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.getName(), submenu: [
        { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit Closed Cluely', accelerator: 'Command+Q', click: requestQuit }
      ] }, { role: 'editMenu' },
      { label: 'Overlay', submenu: [{ label: 'Settings…', accelerator: 'Command+,', click: () => { showOverlay(true); emit({ type: 'open-settings' }); } }] }
    ]));
  }
  const login = loginState();
  launchHidden = startHidden(process.argv, login);
  store = new Store(app.getPath('userData'), safeStorage, warn);
  const loaded = store.read('preferences.json', DEFAULTS);
  try { settings = validateSettings(loaded); settings.bounds = loaded.bounds && ['x','y','width','height'].every(key => Number.isFinite(loaded.bounds[key])) ? loaded.bounds : null; }
  catch { settings = { ...DEFAULTS, models: { ...DEFAULTS.models } }; warn('Saved settings were invalid. Defaults are in use.'); }
  if (canStartAtLogin() && typeof login.openAtLogin === 'boolean') settings.launchAtLogin = login.openAtLogin;
  if (!store.available()) { settings.rememberHistory = false; warn('Secure storage is unavailable. API keys and history cannot be saved.'); }
  const credentials = store.read('credentials.enc', {}, true);
  for (const provider of PROVIDERS) if (!['chatgpt', 'codex', 'claude'].includes(provider) && typeof credentials?.[provider] === 'string' && credentials[provider].length <= 500) keys[provider] = credentials[provider];
  const savedSttKeys = store.read('stt-credentials.enc', {}, true);
  for (const provider of STT_PROVIDERS) if (typeof savedSttKeys?.[provider] === 'string' && savedSttKeys[provider].length <= 500) sttKeys[provider] = savedSttKeys[provider];
  localStt = new LocalStt({ directory: path.join(app.getPath('userData'), 'stt-models'), sherpa, onChange: () => { if (win && !quitting) syncState(); } });
  listener = new Listener({ segmenterOptions, transcribe,
    onChange: () => emit({ type: 'listening', value: listener.publicState() }),
    onEntry: entry => { persistTranscript(); emit({ type: 'transcript', entry }); },
    onTurn: handleTurn,
    onError: text => emit({ type: 'notice', text }) });
  if (!sherpa) warn('The on-device speech runtime could not load. Cloud transcription and the basic voice detector remain available.');
  if (settings.rememberHistory) {
    try { meetingContext = validateContext(store.read('meeting-context.enc', null, true)); } catch { warn('Saved meeting context could not be restored.'); }
    try { listener.restore(store.read('transcript.enc', [], true)); } catch { warn('The saved transcript could not be restored.'); }
  }
  chatgpt = new ChatGPTAuth({ store, openExternal: url => shell.openExternal(url), onChange: chatGPTChanged });
  codex = new CodexConnection({ directory: path.join(store.directory, 'codex-profile'), openExternal: url => shell.openExternal(url), onChange: codexChanged, version: app.getVersion() });
  claude = new ClaudeAccount({ directory: path.join(store.directory, 'claude-profile'), onChange: claudeChanged });
  loadChatGPTProfile(true);
  restoreModelCatalog();
  if (settings.rememberHistory) {
    try { history = validateHistory(store.read('conversation.enc', [], true)); }
    catch { warn('Saved conversation could not be restored.'); }
    try {
      const saved = store.read('chats.enc', null, true);
      if (saved !== null && (!Array.isArray(saved.archive) || saved.archive.length > 100)) throw new Error('Invalid chat archive.');
      archivedChats = (saved?.archive || []).map(chat => {
        if (!chat || typeof chat.id !== 'string' || typeof chat.title !== 'string' || typeof chat.updatedAt !== 'string') throw new Error('Invalid chat.');
        return { id: chat.id, title: chat.title.slice(0, 80), updatedAt: chat.updatedAt, history: validateHistory(chat.history), context: validateContext(chat.context), transcript: Array.isArray(chat.transcript) ? chat.transcript.slice(-2000) : [] };
      });
      if (saved !== null) history = validateHistory(saved.current);
    } catch { warn('Previous chats could not be restored. The original file is preserved until the next successful save.'); }
  }
  interruptedWork = new InterruptedWork({ store, enabled: () => settings.rememberHistory && store.available(), report: warn });
  // Temporary Keychain unavailability must not delete an existing checkpoint.
  lastAttempt = store.available() ? interruptedWork.restore(history) : null;
  const overlaySession = session.fromPartition('overlay-memory');
  // Audio capture only: microphones / loopback inputs, and on Windows system
  // audio through the display-media loopback. Camera and screen video stay off.
  overlaySession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const audioOnly = permission === 'media' && Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
    callback(audioOnly && contents === win?.webContents);
  });
  overlaySession.setPermissionCheckHandler((_contents, permission, _origin, details) => permission === 'media' && details?.mediaType !== 'video');
  overlaySession.setDisplayMediaRequestHandler((_request, callback) => {
    if (platform.mac) { callback({}); return; }
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {})).catch(() => callback({}));
  });
  // The renderer uses only packaged files and data-URL image previews. AI networking stays in main.
  overlaySession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !['file:', 'data:', 'devtools:'].some(prefix => details.url.startsWith(prefix)) }));
  createWindow();
  const trayImage = nativeImage.createFromPath(path.join(__dirname, 'assets', platform.mac ? 'trayTemplate.png' : 'tray.png'));
  if (platform.mac) trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.setToolTip(`Closed Cluely — ${shortcutLabel('CommandOrControl+Alt+Space')}`);
  if (!platform.mac) tray.on('click', () => showOverlay(true));
  updateTray();
  registerIPC(); registerShortcuts();
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => { fitWindow(); syncState(); });
  powerMonitor.on('resume', () => { applyWindowMode(); fitWindow(); syncState(); });
  powerMonitor.on('suspend', () => { active?.controller.abort(); });
  powerMonitor.on('shutdown', allowSessionEnd);
  initializationComplete = true;
  log('app-ready');
  if (!testMode) {
    void refreshModels();
    if (fs.existsSync(path.join(store.directory, 'claude-profile'))) void claude.readAccount().then(() => claude.publicState().connected ? refreshClaudeModels() : undefined).catch(() => { log('claude-restore-unavailable'); });
    if (fs.existsSync(path.join(store.directory, 'codex-profile'))) void codex.readAccount().then(() => {
      const cached = store.read('codex-models.json', null);
      if (codex.publicState().connected && validCachedModels(cached)) {
        modelCatalog.codex = cached.models;
        modelStatus.codex = { source: 'cached', total: cached.total, checkedAt: cached.checkedAt, refreshing: false, error: '' };
      }
      return codex.publicState().connected ? refreshCodexModels() : undefined;
    }).catch(() => { log('codex-restore-unavailable'); });
  }
  if (testMode) {
    await require(interruptionTestMode ? '../tests/interruption-electron' : '../tests/smoke-electron').run({ app, getWindow: () => win, store, currentState, ask, saveSettings, refreshModels, importImage, capture, screenshotToClipboard, pasteFromClipboard, images, showOverlay, hideOverlay, togglePassThrough, toggleCompact, requestQuit, changeConversation,
      getListener: () => listener, startListening, stopListening, saveListenSettings, saveMeetingContext, addContextFiles, respondToMeeting, setSttFunction: fn => { sttFunction = fn; }, setMicrophonePermissionFunction: fn => { microphonePermissionFunction = fn; },
      setModelLister: fn => { const previous = modelLister; modelLister = fn; return previous; },
      setChatGPTController: controller => { const previous = chatgpt; chatgpt = controller; chatgptSessionEpoch++; loadChatGPTProfile(true); syncState(); return previous; },
      setClaudeController: controller => { const previous = claude; claude = controller; claudeChanged(); return previous; },
      setCodexController: controller => { const previous = codex; codex = controller; codexEpoch++; codexChanged(); return previous; },
      setAnswerFunction: fn => { const previous = answerFunction; answerFunction = fn; return previous; }, setKeyValidator: fn => { keyValidator = fn; }, setSttKeyValidator: fn => { sttKeyValidator = fn; }, setScreenPermissionFunction: fn => { screenPermissionFunction = fn; }, cancel: () => { pendingAsk?.controller.abort(); active?.controller.abort(); }, clear: () => { history = []; images.clear(); lastAttempt = null; persistHistory(); syncState(); },
      getHistory: () => history, interruptedWork });
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => manualReopen());
  app.on('activate', manualReopen);
  app.on('window-all-closed', () => { /* The tray owns lifetime; closing the UI keeps the app running. */ });
  app.on('before-quit', () => {
    interruptedWork?.flush();
    if (listener?.listening) void listener.stop();
    quitting = true; pendingAsk?.controller.abort(); active?.controller.abort(); clearTimeout(geometryTimer);
    chatgpt?.cancelSignIn();
    codex?.stop(); claude?.stop();
    if (settings && store) {
      if (win && !win.isDestroyed()) { const bounds = win.getBounds(); settings.bounds = { ...bounds, height: settings.compact ? normalBounds?.height || 700 : bounds.height }; }
      try { persistSettings(); persistHistory(); } catch { log('shutdown-save-failed'); }
    }
  });
  app.on('will-quit', () => { codex?.stop(); claude?.stop(); globalShortcut.unregisterAll(); tray?.destroy(); });
  app.whenReady().then(initialize).catch(error => {
    log('startup-failed');
    if (testMode) { console.error(error); app.exit(1); }
    else { dialog.showErrorBox('Closed Cluely could not start', 'The app could not initialize. Reopen it or reinstall the app. Your saved data is preserved.'); app.exit(1); }
  });
}
process.on('uncaughtException', () => { log('main-process-fatal'); app.exit(1); });
process.on('unhandledRejection', () => { log('unhandled-operation'); });
