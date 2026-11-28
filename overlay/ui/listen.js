'use strict';
// Listening bar, live transcript, Listening settings and Meeting context.
// Shares helpers from app.js ($, api, call, guard, notify, applyState, state).
(() => {
  const audio = window.meetingAudio;
  let listenBusy = false, transcriptSignature = '', devices = [], contextDirty = false;
  // Live listening resumes by itself (at launch, after a device drops) unless the
  // user paused it. A failed automatic start waits for the user or new settings.
  let autoStartBlocked = false, lastAutoStart = 0;
  const listening = () => !!state?.listening?.listening;

  function sendFrame(source, samples) { api.audioFrame(source, samples); }

  // ---------- Listening bar ----------
  function renderBar() {
    if (!state) return;
    const info = state.listening || {};
    const on = !!info.listening;
    $('listenButton').setAttribute('aria-pressed', String(on));
    $('listenButton').classList.toggle('recording', on);
    $('listenLabel').textContent = listenBusy ? (on ? 'Pausing…' : 'Starting…') : on ? 'Live' : 'Paused';
    $('listenButton').disabled = listenBusy;
    $('respondButton').disabled = !state.transcript?.some(entry => entry.source === 'them') || !!state.busy || !!info.pendingBy?.them;
    $('retryTranscription').hidden = !info.failed;
    $('retryTranscription').disabled = !!info.pending;
    renderLevels(info);
    const status = [];
    if (on) {
      const lanes = info.sources?.me ? 'speaker and mic' : 'speaker';
      status.push(info.speaking?.them ? 'They are speaking…' : `Live on ${lanes}.${state.settings.autoAnswer ? ` Answers after a ${(state.settings.answerPauseMs / 1000).toFixed(1)} s pause.` : ''}`);
    }
    if (info.pending) status.push(`Transcribing ${info.pending} segment${info.pending === 1 ? '' : 's'}…`);
    if (info.failed) status.push(`${info.failed} segment${info.failed === 1 ? '' : 's'} need retrying. Audio is kept until you clear the transcript or quit.`);
    $('listenStatus').textContent = status.join(' · ');
    $('listenStatus').hidden = !status.length;
    $('transcriptToggle').setAttribute('aria-pressed', String(!!state.settings.showTranscript));
    $('transcriptPanel').hidden = !state.settings.showTranscript || (!state.transcript?.length && !on);
    const count = (state.meetingContext?.files.length || 0) + (state.meetingContext?.notes.trim() ? 1 : 0);
    $('contextBadge').hidden = !count; $('contextBadge').textContent = String(count);
    $('contextButton').title = count ? `Meeting context: ${state.meetingContext.chars.toLocaleString()} characters used for every answer` : 'Meeting context: notes and files used for every answer';
    $('welcomeContextDetail').textContent = count ? `${count} item${count === 1 ? '' : 's'} added · ${state.meetingContext.chars.toLocaleString()} characters · edit` : 'Notes, slides or documents the answers should use';
    renderTranscript();
    maybeAutoStart(info);
  }
  function renderLevels(info) {
    for (const source of ['them', 'me']) {
      const meter = $(source === 'me' ? 'meterMe' : 'meterThem');
      meter.style.setProperty('--level', String(info.listening ? info.levels?.[source] || 0 : 0));
      meter.parentElement.classList.toggle('speaking', !!info.speaking?.[source]);
    }
    $('meterMeWrap').hidden = !!info.listening && !info.sources?.me;
  }
  function renderLane(box, entries, emptyText) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    box.replaceChildren(...entries.slice(-120).map(entry => {
      const line = document.createElement('p'); line.className = `line ${entry.source}`;
      line.textContent = entry.text;
      return line;
    }));
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'line empty'; empty.textContent = emptyText; box.append(empty); }
    if (atBottom || entries.length <= 1) box.scrollTop = box.scrollHeight;
  }
  // Two lanes: the laptop's audio (the other side) and the microphone (you).
  function renderTranscript() {
    const entries = state.transcript || [];
    const signature = entries.length ? `${entries.length}/${entries.at(-1).id}` : '';
    if (signature === transcriptSignature) return;
    transcriptSignature = signature;
    renderLane($('transcriptLines'), entries.filter(entry => entry.source === 'them'), 'What the other side says will appear here.');
    renderLane($('transcriptMeLines'), entries.filter(entry => entry.source === 'me'), 'What you say into the microphone appears here.');
  }
  function maybeAutoStart(info) {
    if (!info.autoStart || info.listening || listenBusy || autoStartBlocked || audio.active()) return;
    // After a stop for falling behind, let transcription catch up first.
    if ((info.backlogSeconds || 0) > 10 || info.pendingBy?.them) return;
    if (Date.now() - lastAutoStart < 3000) return;
    lastAutoStart = Date.now();
    void startListening({ automatic: true });
  }

  async function startListening({ automatic = false } = {}) {
    if (listenBusy || listening()) return;
    listenBusy = true; renderBar();
    try {
      const plan = await call('listenPrepare');
      const result = await audio.start(plan, sendFrame);
      if (!result.started.length) throw new Error(`The audio input could not be opened. ${result.problems.join(' ')}`.trim());
      applyState(await call('listenStart', { sources: result.started }));
      await audio.resume();
      autoStartBlocked = false;
      notify([`Listening live · speaker: ${result.labels.them}${result.labels.me ? ` · mic: ${result.labels.me}` : ''}`, ...result.problems].join(' '));
    } catch (error) {
      await audio.stop().catch(() => {});
      if (listening()) await call('listenStop').catch(() => {});
      if (automatic) autoStartBlocked = true;
      notify(automatic ? `Live listening could not start: ${error.message}` : error.message);
      if (/Microphone|permission|NotAllowed/i.test(error.message)) $('lsMicSettings').hidden = false;
    } finally { listenBusy = false; renderBar(); }
  }
  // user: the user paused listening, so it stays off until they turn it back on.
  async function stopListening({ user = false } = {}) {
    if (listenBusy) return;
    listenBusy = true; renderBar();
    try {
      let audioError;
      try { await audio.stop(); } catch (error) { audioError = error; }
      applyState(await call('listenStop', { user }));
      if (audioError) notify(audioError.message);
    }
    catch (error) { notify(error.message); }
    finally { listenBusy = false; renderBar(); }
  }
  const toggleListening = () => { autoStartBlocked = false; return listening() || audio.active() ? stopListening({ user: true }) : startListening(); };

  api.onEvent(event => {
    if (!state) return;
    if (event.type === 'listening') { state.listening = event.value; renderBar(); }
    else if (event.type === 'transcript') { state.transcript = [...(state.transcript || []).filter(entry => entry.id !== event.entry.id), event.entry].sort((a, b) => (a.order || 0) - (b.order || 0)).slice(-300); renderBar(); }
    else if (event.type === 'toggle-listen') void toggleListening();
    else if (event.type === 'listen-stopped') { void audio.stop().catch(error => notify(error.message)); }
  });
  window.addEventListener('audio-source-ended', () => {
    if (!listening()) return;
    // Live listening restarts by itself with whatever inputs are available.
    notify('An audio input disconnected. Listening restarts with the inputs that are available.');
    void stopListening();
  });

  $('listenButton').addEventListener('click', () => void toggleListening());
  $('retryTranscription').addEventListener('click', guard(async () => applyState(await call('listenRetry'))));
  $('respondButton').addEventListener('click', guard(async () => { await call('listenRespond'); }));
  $('transcriptToggle').addEventListener('click', guard(async () => applyState(await call('listenSave', { showTranscript: !state.settings.showTranscript }))));
  $('clearTranscript').addEventListener('click', guard(async () => { applyState(await call('transcriptClear')); notify('Transcript cleared.'); }));

  // ---------- Listening settings ----------
  const sttModels = provider => provider === 'local' ? (state.stt.local.models || []).map(model => ({ id: model.id, name: `${model.name}${model.installed ? '' : ' · not downloaded'}` })) : state.stt.models[provider] || [];
  function fillSelect(select, value, options) {
    select.replaceChildren(...options);
    if (value && ![...select.options].some(option => option.value === value)) select.append(new Option(`${value} · not connected`, value));
    select.value = value;
  }
  function fillDevices() {
    const names = [...new Set(devices.filter(device => device.label).map(device => device.label))];
    const loopback = names.find(name => audio.isLoopback(name));
    fillSelect($('lsThem'), state.settings.themDevice, [
      new Option(state.platform.mac ? `Automatic${loopback ? ` · ${loopback}` : ' · BlackHole when connected'}` : 'Windows system audio (everything you hear)', ''),
      ...names.map(name => new Option(audio.isLoopback(name) ? `${name} · computer audio` : name, name))]);
    fillSelect($('lsMic'), state.settings.micDevice, [new Option('System default microphone', ''),
      ...names.filter(name => !audio.isLoopback(name)).map(name => new Option(name, name))]);
    $('lsThemHint').textContent = !names.length ? 'Device names appear after microphone access is allowed. Listen once, then refresh devices.'
      : state.platform.mac ? (loopback ? `Route the call's sound to ${loopback} with a Multi-Output Device (Audio MIDI Setup) so you still hear it in your headphones.` : 'No loopback input found. Install BlackHole to hear the call directly; until then the microphone stands in for the other side.')
      : 'Hears everything your computer plays. Choose a device such as VB-CABLE to hear only one app.';
    $('lsMicLabel').hidden = !$('lsCaptureMe').checked;
  }
  const pauseText = () => `${(Number($('lsPause').value) / 1000).toFixed(1)} s`;
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
    $('lsAutoAnswer').checked = s.autoAnswer; $('lsCaptureMe').checked = s.captureMe;
    $('lsPause').value = String(s.answerPauseMs); $('lsPauseValue').textContent = pauseText();
    $('lsProvider').replaceChildren(...state.stt.providers.map(item => new Option(item.name, item.id)));
    $('lsProvider').value = s.sttProvider; fillModels(s.sttProvider, s.sttModels[s.sttProvider]);
    $('lsKey').value = ''; $('lsLanguage').value = s.sttLanguage;
    $('lsMicSettings').hidden = !state.platform.mac || state.microphonePermission === 'granted';
    $('listenError').hidden = true;
    fillDevices(); void refreshDevices();
    if (!$('listenDialog').open) $('listenDialog').showModal();
    window.overlaySelects?.refresh();
  }
  $('listenSettingsButton').addEventListener('click', openListenSettings);
  $('closeListen').addEventListener('click', () => { $('lsKey').value = ''; $('listenDialog').close(); });
  $('lsProvider').addEventListener('change', () => fillModels($('lsProvider').value, state.settings.sttModels[$('lsProvider').value]));
  $('lsModel').addEventListener('change', updateProviderFields);
  $('lsCaptureMe').addEventListener('change', () => { $('lsMicLabel').hidden = !$('lsCaptureMe').checked; });
  $('lsPause').addEventListener('input', () => { $('lsPauseValue').textContent = pauseText(); });
  $('lsRefreshDevices').addEventListener('click', guard(refreshDevices));
  $('lsMicSettings').addEventListener('click', guard(() => call('openMicrophoneSettings')));
  $('lsRemoveKey').addEventListener('click', guard(async () => { applyState(await call('listenSave', { sttProvider: $('lsProvider').value, removeSttKey: true })); updateProviderFields(); notify('Speech-to-text key removed.'); }));
  $('listenForm').addEventListener('submit', async event => {
    event.preventDefault();
    $('listenError').hidden = true;
    const provider = $('lsProvider').value;
    const model = $('lsModel').value === '__custom__' ? $('lsCustomModel').value.trim() : $('lsModel').value;
    const s = state.settings;
    const quick = { autoAnswer: $('lsAutoAnswer').checked, answerPauseMs: Number($('lsPause').value) };
    const input = { ...quick, themDevice: $('lsThem').value, captureMe: $('lsCaptureMe').checked, micDevice: $('lsMic').value, sttProvider: provider, ...(model ? { sttModels: { [provider]: model } } : {}),
      sttLanguage: $('lsLanguage').value.trim(),
      ...($('lsKey').value.trim() ? { sttApiKey: $('lsKey').value.trim() } : {})
    };
    // Inputs and transcription can only change while listening is paused: pause,
    // save, then resume.
    const restart = listening() && (input.sttApiKey || input.themDevice !== s.themDevice || input.captureMe !== s.captureMe || input.micDevice !== s.micDevice
      || provider !== s.sttProvider || (model && model !== s.sttModels[provider]) || input.sttLanguage !== s.sttLanguage);
    $('listenSave').disabled = true; $('listenSave').textContent = input.sttApiKey ? 'Verifying key…' : 'Saving…';
    try {
      if (restart) await stopListening();
      applyState(await call('listenSave', listening() ? quick : input));
      $('lsKey').value = ''; $('listenDialog').close();
      autoStartBlocked = false;
      notify(input.sttApiKey ? 'Key verified. Recording settings saved.' : 'Recording settings saved.');
      if (restart) await startListening();
    } catch (error) { $('listenError').textContent = error.message; $('listenError').hidden = false; if (restart) void startListening(); }
    finally { $('listenSave').disabled = false; $('listenSave').textContent = 'Save recording settings'; }
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
  // newChat: shown right after New chat, so the meeting can start with context.
  let contextForNewChat = false;
  function openContext({ newChat = false } = {}) {
    if (!state) return;
    contextForNewChat = newChat;
    $('contextTitle').textContent = newChat ? 'New chat' : 'Meeting context';
    $('contextIntro').textContent = newChat ? 'Add notes and files for this meeting, such as the agenda, slides or what you want to say. Every answer in this chat will use them. You can change them later with the 📄 button.'
      : 'Notes and files here are sent with every question in this chat: slides, agenda, a prepared answer, background. Text is extracted on this device.';
    $('contextSkip').hidden = !newChat; $('contextClear').hidden = newChat;
    $('contextSaveButton').textContent = newChat ? 'Start chat' : 'Save notes';
    $('contextNotes').value = state.meetingContext.notes; contextDirty = false;
    $('contextError').hidden = true; renderContextFiles();
    if (!$('contextDialog').open) $('contextDialog').showModal();
    if (newChat) $('contextNotes').focus();
  }
  window.openMeetingContext = openContext;
  async function saveNotes() {
    applyState(await call('contextSave', { notes: $('contextNotes').value })); contextDirty = false;
  }
  $('contextButton').addEventListener('click', () => openContext());
  $('welcomeContext').addEventListener('click', () => openContext());
  $('contextSkip').addEventListener('click', guard(async () => { if (contextDirty) await saveNotes(); $('contextDialog').close(); focusQuestion(); }));
  $('contextNotes').addEventListener('input', () => { contextDirty = true; renderContextFiles(); });
  $('contextAddFiles').addEventListener('click', guard(async () => { if (contextDirty) await saveNotes(); showContextResult(await call('contextPick')); }));
  $('contextSaveButton').addEventListener('click', guard(async () => {
    await saveNotes(); $('contextDialog').close();
    const count = state.meetingContext.files.length + (state.meetingContext.notes.trim() ? 1 : 0);
    notify(contextForNewChat ? (count ? 'New chat started with your meeting context.' : 'New chat started.') : 'Meeting context saved. It is included with every question.');
    focusQuestion();
  }));
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
