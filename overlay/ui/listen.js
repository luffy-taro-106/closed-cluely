'use strict';
// Listening bar, live transcript, Listening settings and Meeting context.
// Shares helpers from app.js ($, api, call, guard, notify, applyState, state).
(() => {
  const audio = window.meetingAudio;
  let listenBusy = false, transcriptSignature = '', devices = [], contextDirty = false;
  const listening = () => !!state?.listening?.listening;

  function sendFrame(source, samples) { api.audioFrame(source, samples); }

  // ---------- Listening bar ----------
  function renderBar() {
    if (!state) return;
    const info = state.listening || {};
    const on = !!info.listening;
    $('listenButton').setAttribute('aria-pressed', String(on));
    $('listenButton').classList.toggle('recording', on);
    $('listenLabel').textContent = listenBusy ? (on ? 'Stopping…' : 'Starting…') : on ? (info.mode === 'manual' ? `Stop · ${formatSeconds(info.manualSeconds || 0)}` : 'Stop listening') : state.settings.listenMode === 'manual' ? 'Start recording' : 'Start listening';
    $('listenButton').disabled = listenBusy;
    $('listenMode').value = state.settings.listenMode;
    $('listenMode').disabled = on || listenBusy;
    $('respondButton').disabled = !state.transcript?.length || !!state.busy;
    $('meterMeWrap').hidden = !state.settings.captureMe;
    $('meterThemWrap').hidden = !state.settings.captureThem;
    renderLevels(info);
    const status = [];
    if (on && info.mode === 'auto') status.push(info.speaking?.them ? 'Them speaking…' : info.speaking?.me ? 'You are speaking…' : `Listening for speech${info.engine ? ` · ${engineName(info.engine)}` : ''}`);
    if (on && info.mode === 'manual') status.push('Recording. Press Stop to transcribe and answer.');
    if (info.pending) status.push(`Transcribing ${info.pending} segment${info.pending === 1 ? '' : 's'}…`);
    $('listenStatus').textContent = status.join(' · ');
    $('listenStatus').hidden = !status.length;
    $('transcriptToggle').setAttribute('aria-pressed', String(!!state.settings.showTranscript));
    $('transcriptPanel').hidden = !state.settings.showTranscript || (!state.transcript?.length && !on);
    const count = (state.meetingContext?.files.length || 0) + (state.meetingContext?.notes.trim() ? 1 : 0);
    $('contextBadge').hidden = !count; $('contextBadge').textContent = String(count);
    $('contextButton').title = count ? `Meeting context: ${state.meetingContext.chars.toLocaleString()} characters used for every answer` : 'Meeting context: notes and files used for every answer';
    renderTranscript();
  }
  function renderLevels(info) {
    $('meterMe').style.setProperty('--level', String(info.levels?.me || 0));
    $('meterThem').style.setProperty('--level', String(info.levels?.them || 0));
    $('meterMeWrap').classList.toggle('speaking', !!info.speaking?.me);
    $('meterThemWrap').classList.toggle('speaking', !!info.speaking?.them);
  }
  const engineName = engine => ({ silero: 'Silero VAD', ten: 'TEN VAD', energy: 'level detector' })[engine] || engine;
  const formatSeconds = value => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  function renderTranscript() {
    const entries = state.transcript || [];
    const signature = entries.length ? `${entries.length}/${entries.at(-1).id}` : '';
    if (signature === transcriptSignature) return;
    transcriptSignature = signature;
    const box = $('transcriptLines');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.replaceChildren(...entries.slice(-150).map(entry => {
      const line = document.createElement('p'); line.className = `line ${entry.source}`;
      const who = document.createElement('b'); who.textContent = entry.source === 'me' ? 'Me' : 'Them';
      line.append(who, document.createTextNode(` ${entry.text}`));
      return line;
    }));
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'line empty'; empty.textContent = 'Speech will appear here.'; box.append(empty); }
    if (atBottom || entries.length <= 1) box.scrollTop = box.scrollHeight;
  }

  async function startListening() {
    if (listenBusy || listening()) return;
    listenBusy = true; renderBar();
    try {
      const plan = await call('listenPrepare');
      const result = await audio.start({ me: plan.me, them: plan.them, micLabel: plan.micLabel, themLabel: plan.themLabel, platform: plan.platform }, sendFrame);
      if (!result.started.length) throw new Error(result.problems.join(' ') || 'No audio source could be opened.');
      applyState(await call('listenStart', { sources: result.started }));
      const heard = result.started.map(source => `${source === 'me' ? 'Me' : 'Them'}: ${result.labels[source]}`).join(' · ');
      notify(result.problems.length ? `${result.problems.join(' ')} Listening with ${heard}.` : `Listening · ${heard}`);
    } catch (error) {
      await audio.stop();
      notify(error.message);
      if (/Microphone|permission|NotAllowed/i.test(error.message)) $('lsMicSettings').hidden = false;
    } finally { listenBusy = false; renderBar(); }
  }
  async function stopListening() {
    if (listenBusy) return;
    listenBusy = true; renderBar();
    try { await audio.stop(); applyState(await call('listenStop')); }
    catch (error) { notify(error.message); }
    finally { listenBusy = false; renderBar(); }
  }
  const toggleListening = () => listening() || audio.active() ? stopListening() : startListening();

  api.onEvent(event => {
    if (!state) return;
    if (event.type === 'listening') { state.listening = event.value; renderBar(); }
    else if (event.type === 'transcript') { state.transcript = [...(state.transcript || []), event.entry].slice(-300); renderBar(); }
    else if (event.type === 'toggle-listen') void toggleListening();
    else if (event.type === 'listen-stopped') { void audio.stop(); }
  });
  window.addEventListener('audio-source-ended', event => {
    if (!listening()) return;
    notify(`${event.detail === 'me' ? 'The microphone' : 'Meeting audio'} disconnected. Listening stopped.`);
    void stopListening();
  });

  $('listenButton').addEventListener('click', () => void toggleListening());
  $('listenMode').addEventListener('change', guard(async () => {
    try { applyState(await call('listenSave', { listenMode: $('listenMode').value })); }
    finally { $('listenMode').value = state.settings.listenMode; }
  }));
  $('respondButton').addEventListener('click', guard(async () => { await call('listenRespond'); }));
  $('transcriptToggle').addEventListener('click', guard(async () => applyState(await call('listenSave', { showTranscript: !state.settings.showTranscript }))));
  $('clearTranscript').addEventListener('click', guard(async () => { applyState(await call('transcriptClear')); notify('Transcript cleared.'); }));

  // ---------- Listening settings ----------
  const sttModels = provider => provider === 'local' ? (state.stt.local.models || []).map(model => ({ id: model.id, name: `${model.name}${model.installed ? '' : ' · not downloaded'}` })) : state.stt.models[provider] || [];
  function fillDevices() {
    const mic = $('lsMic'), them = $('lsThem');
    const inputs = devices.filter(device => device.label);
    const names = [...new Set(inputs.map(device => device.label))];
    mic.replaceChildren(new Option('System default microphone', ''), ...names.filter(name => !audio.isLoopback(name)).map(name => new Option(name, name)));
    them.replaceChildren(
      new Option(state.platform.mac ? 'Auto-detect BlackHole / loopback device' : 'Auto-detect loopback device (VB-CABLE…)', ''),
      ...(state.platform.mac ? [] : [new Option('Windows system audio (all apps)', audio.SYSTEM)]),
      ...names.map(name => new Option(audio.isLoopback(name) ? `${name} · loopback` : name, name)));
    for (const [select, value] of [[mic, state.settings.micDevice], [them, state.settings.themDevice]]) {
      if (value && ![...select.options].some(option => option.value === value)) select.append(new Option(`${value} · not connected`, value));
      select.value = value;
    }
    const loopback = names.find(name => audio.isLoopback(name));
    $('lsThemHint').textContent = state.platform.mac
      ? loopback ? `Found ${loopback}. Send meeting sound to it through a Multi-Output Device (Audio MIDI Setup) so you still hear the call.` : 'Install BlackHole 2ch, then create a Multi-Output Device with your speakers or headphones and BlackHole in Audio MIDI Setup and select it as the sound output.'
      : 'Windows system audio captures everything you hear. A virtual cable can isolate the meeting app.';
    if (!names.length) $('lsThemHint').textContent = 'Device names appear after microphone access is allowed. Start listening once, then refresh devices.';
  }
  async function refreshDevices() { devices = await audio.inputDevices(); if ($('listenDialog').open) fillDevices(); }
  function fillModels(provider, current) {
    const list = sttModels(provider);
    const options = list.map(model => new Option(model.name, model.id));
    if (provider !== 'local') options.push(new Option('Custom model ID…', '__custom__'));
    $('lsModel').replaceChildren(...options);
    const known = list.some(model => model.id === current);
    $('lsModel').value = known ? current : provider === 'local' ? list[0]?.id || '' : '__custom__';
    $('lsCustomModel').value = known || provider === 'local' ? '' : current || '';
    updateProviderFields();
  }
  function updateProviderFields() {
    const provider = $('lsProvider').value, local = provider === 'local';
    $('lsCustomLabel').hidden = local || $('lsModel').value !== '__custom__';
    $('lsKeyLabel').hidden = local; $('lsRemoveKey').hidden = local || !state.stt.keyStatus[provider] || (provider === 'openai' && state.stt.sharedOpenAIKey);
    $('lsKeyBadge').textContent = local ? '' : provider === 'openai' && state.stt.sharedOpenAIKey ? 'Using your OpenAI chat key' : state.stt.keyStatus[provider] ? 'Key saved' : 'No key yet';
    $('lsKey').placeholder = state.stt.keyStatus[provider] ? 'Leave blank to keep the saved key' : 'Paste your API key';
    $('lsLocal').hidden = !local;
    if (local) renderLocalModels();
  }
  function renderLocalModels() {
    const local = state.stt.local;
    const rows = (local.models || []).map(model => {
      const row = document.createElement('div'); row.className = 'local-model';
      const info = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = model.name;
      const detail = document.createElement('span');
      const dl = model.download;
      detail.textContent = dl ? dl.phase === 'extracting' ? 'Unpacking…' : `Downloading ${Math.round(dl.received / 1e6)} / ${Math.round((dl.total || model.sizeMB * 1e6) / 1e6)} MB` : model.installed ? 'Installed · runs on this computer' : `${model.sizeMB} MB download`;
      info.append(name, detail);
      const button = document.createElement('button'); button.type = 'button'; button.className = `text-button${model.installed ? ' danger' : ''}`;
      button.textContent = dl ? 'Cancel' : model.installed ? 'Delete' : 'Download';
      button.addEventListener('click', guard(async () => {
        applyState(await call(dl ? 'sttCancelDownload' : model.installed ? 'sttRemove' : 'sttDownload', model.id));
      }));
      row.append(info, button); return row;
    });
    const note = document.createElement('p'); note.className = 'connection-hint';
    note.textContent = local.runtime ? 'Parakeet v2 gives the best English accuracy; Whisper turbo and Parakeet v3 cover other languages; Moonshine and Whisper tiny are lightest. Models come from the official sherpa-onnx release.' : 'The on-device speech runtime could not load on this computer. Choose a cloud provider.';
    $('lsLocal').replaceChildren(...rows, note);
  }
  function openListenSettings() {
    if (!state) return;
    const s = state.settings;
    $('lsMode').value = s.listenMode; $('lsAutoAnswer').checked = s.autoAnswer;
    $('lsCaptureMe').checked = s.captureMe; $('lsCaptureThem').checked = s.captureThem;
    $('lsProvider').replaceChildren(...state.stt.providers.map(item => new Option(item.name, item.id)));
    $('lsProvider').value = s.sttProvider; fillModels(s.sttProvider, s.sttModels[s.sttProvider]);
    $('lsKey').value = ''; $('lsLanguage').value = s.sttLanguage;
    $('lsVad').value = s.vadEngine;
    $('lsThreshold').value = Math.round(s.vadThreshold * 100); $('lsThresholdValue').textContent = s.vadThreshold.toFixed(2);
    $('lsSilence').value = s.endSilenceMs; $('lsSilenceValue').textContent = `${(s.endSilenceMs / 1000).toFixed(1)} s`;
    $('lsMicSettings').hidden = !state.platform.mac || state.microphonePermission === 'granted';
    $('listenError').hidden = true;
    for (const id of ['lsMode', 'lsCaptureMe', 'lsCaptureThem', 'lsMic', 'lsThem', 'lsProvider', 'lsModel', 'lsCustomModel', 'lsKey', 'lsLanguage', 'lsVad', 'lsThreshold', 'lsSilence']) $(id).disabled = listening();
    fillDevices(); void refreshDevices();
    if (!$('listenDialog').open) $('listenDialog').showModal();
    window.overlaySelects?.refresh();
  }
  $('listenSettingsButton').addEventListener('click', openListenSettings);
  $('closeListen').addEventListener('click', () => { $('lsKey').value = ''; $('listenDialog').close(); });
  $('lsProvider').addEventListener('change', () => fillModels($('lsProvider').value, state.settings.sttModels[$('lsProvider').value]));
  $('lsModel').addEventListener('change', updateProviderFields);
  $('lsRefreshDevices').addEventListener('click', guard(refreshDevices));
  $('lsMicSettings').addEventListener('click', guard(() => call('openMicrophoneSettings')));
  $('lsThreshold').addEventListener('input', () => { $('lsThresholdValue').textContent = (Number($('lsThreshold').value) / 100).toFixed(2); });
  $('lsSilence').addEventListener('input', () => { $('lsSilenceValue').textContent = `${(Number($('lsSilence').value) / 1000).toFixed(1)} s`; });
  $('lsRemoveKey').addEventListener('click', guard(async () => { applyState(await call('listenSave', { sttProvider: $('lsProvider').value, removeSttKey: true })); updateProviderFields(); notify('Speech-to-text key removed.'); }));
  $('listenForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('listenError').hidden = true;
    const provider = $('lsProvider').value;
    const model = $('lsModel').value === '__custom__' ? $('lsCustomModel').value.trim() : $('lsModel').value;
    const input = listening() ? { autoAnswer: $('lsAutoAnswer').checked } : {
      listenMode: $('lsMode').value, autoAnswer: $('lsAutoAnswer').checked, captureMe: $('lsCaptureMe').checked, captureThem: $('lsCaptureThem').checked,
      micDevice: $('lsMic').value, themDevice: $('lsThem').value, sttProvider: provider, ...(model ? { sttModels: { [provider]: model } } : {}),
      sttLanguage: $('lsLanguage').value.trim(), vadEngine: $('lsVad').value, vadThreshold: Number($('lsThreshold').value) / 100, endSilenceMs: Number($('lsSilence').value),
      ...($('lsKey').value.trim() ? { sttApiKey: $('lsKey').value.trim() } : {})
    };
    $('listenSave').disabled = true; $('listenSave').textContent = input.sttApiKey ? 'Verifying key…' : 'Saving…';
    try {
      applyState(await call('listenSave', input));
      $('lsKey').value = ''; $('listenDialog').close();
      notify(input.sttApiKey ? 'Key verified. Listening settings saved.' : listening() ? 'Saved. Stop listening to change audio or transcription settings.' : 'Listening settings saved.');
    } catch (error) { $('listenError').textContent = error.message; $('listenError').hidden = false; }
    finally { $('listenSave').disabled = false; $('listenSave').textContent = 'Save listening settings'; }
  });

  // ---------- Meeting context ----------
  function renderContextFiles() {
    const context = state.meetingContext;
    $('contextFiles').replaceChildren(...context.files.map(file => {
      const row = document.createElement('div'); row.className = 'context-file';
      const name = document.createElement('strong'); name.textContent = file.name;
      const size = document.createElement('span'); size.textContent = `${file.chars.toLocaleString()} characters`;
      const info = document.createElement('div'); info.append(name, size);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button remove-image'; remove.title = `Remove ${file.name}`; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.append(icon('close'));
      remove.addEventListener('click', guard(async () => { applyState(await call('contextRemove', file.id)); renderContextFiles(); }));
      row.append(icon('doc'), info, remove); return row;
    }));
    const total = context.chars - context.notes.length + $('contextNotes').value.length;
    $('contextSize').textContent = `${total.toLocaleString()} / ${context.maxChars.toLocaleString()} characters sent with each question${total > context.maxChars ? ' · over the limit, later files are cut' : ''}`;
  }
  function showContextResult(result) {
    applyState(result.state); renderContextFiles();
    $('contextError').textContent = result.problems.join('\n'); $('contextError').hidden = !result.problems.length;
    if (result.added.length) notify(`Added ${result.added.join(', ')}.`);
  }
  function openContext() {
    if (!state) return;
    $('contextNotes').value = state.meetingContext.notes; contextDirty = false;
    $('contextError').hidden = true; renderContextFiles();
    if (!$('contextDialog').open) $('contextDialog').showModal();
  }
  async function saveNotes() {
    applyState(await call('contextSave', { notes: $('contextNotes').value })); contextDirty = false;
  }
  $('contextButton').addEventListener('click', openContext);
  $('contextNotes').addEventListener('input', () => { contextDirty = true; renderContextFiles(); });
  $('contextAddFiles').addEventListener('click', guard(async () => { if (contextDirty) await saveNotes(); showContextResult(await call('contextPick')); }));
  $('contextSaveButton').addEventListener('click', guard(async () => { await saveNotes(); $('contextDialog').close(); notify('Meeting context saved. It is included with every question.'); }));
  $('closeContext').addEventListener('click', guard(async () => { if (contextDirty) await saveNotes(); $('contextDialog').close(); }));
  $('contextClear').addEventListener('click', guard(async () => { applyState(await call('contextClear')); $('contextNotes').value = ''; contextDirty = false; renderContextFiles(); notify('Meeting context cleared.'); }));
  const drop = $('contextDialog');
  drop.addEventListener('dragover', event => { event.preventDefault(); $('contextDrop').classList.add('dragging'); });
  drop.addEventListener('dragleave', () => $('contextDrop').classList.remove('dragging'));
  drop.addEventListener('drop', guard(async event => {
    event.preventDefault(); $('contextDrop').classList.remove('dragging');
    const paths = api.filePaths(event.dataTransfer.files);
    if (!paths.length) return;
    if (contextDirty) await saveNotes();
    showContextResult(await call('contextAdd', paths));
  }));

  window.renderListening = () => { renderBar(); if ($('listenDialog').open && $('lsProvider').value === 'local') renderLocalModels(); };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());
})();
