'use strict';
// Audio capture for live listening. "Me" is the microphone. "Them" is what the
// laptop plays: on macOS a loopback device such as BlackHole, on Windows the
// system audio loopback (or any input device, e.g. VB-CABLE).
(() => {
  const SYSTEM = 'system';
  let context = null, streams = [], nodes = [], stopping = null;

  async function inputDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput' && device.deviceId !== 'communications'); }
    catch { return []; }
  }
  const isLoopback = label => /blackhole|loopback|soundflower|vb-?cable|cable output|voicemeeter|aggregate|multi-?output/i.test(label || '');
  // Device IDs change between launches in this private session, so devices are
  // remembered by label.
  async function openInput(device, voice) {
    return navigator.mediaDevices.getUserMedia({ audio: {
      ...(device ? { deviceId: { exact: device.deviceId } } : {}),
      // A loopback feed must not be filtered; a microphone benefits from it.
      echoCancellation: false, noiseSuppression: voice, autoGainControl: voice, channelCount: voice ? 1 : { ideal: 2 }
    }, video: false });
  }
  async function openSystemLoopback() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    for (const track of stream.getVideoTracks()) { track.stop(); stream.removeTrack(track); }
    if (!stream.getAudioTracks().length) throw new Error('System audio was not shared.');
    return stream;
  }
  function connect(stream, source, send) {
    const node = new AudioWorkletNode(context, 'frame-batcher', { numberOfInputs: 1, numberOfOutputs: 0, channelCountMode: 'explicit', channelCount: 2 });
    node.port.onmessage = event => {
      if (event.data?.type === 'flushed') node.flushDone?.();
      else if (event.data instanceof Float32Array) send(source, event.data);
    };
    context.createMediaStreamSource(stream).connect(node);
    nodes.push(node); streams.push(stream);
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => window.dispatchEvent(new CustomEvent('audio-source-ended', { detail: source })));
  }

  const unavailable = () => new Error('The selected audio input is unavailable. Reconnect it or choose another input in Recording settings.');
  // Two lanes in one AudioContext:
  // - "them": what the laptop plays. A chosen device, Windows system audio, or on
  //   a Mac the first loopback input (BlackHole). Kept unprocessed.
  // - "me": the microphone, with noise suppression.
  // Without a loopback input the microphone stands in for the other side, as
  // when they are in the same room.
  async function start({ them: themLabel = '', me: micLabel = null, platform }, send) {
    await stop();
    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    const started = [], problems = [], labels = {};
    try {
      await context.suspend();
      await context.audioWorklet.addModule('audio-worklet.js');
      const devices = await inputDevices();
      const byLabel = label => devices.find(device => device.label === label) || null;
      let themStream = null, themDevice = null;
      if (themLabel === SYSTEM || (!themLabel && !platform.mac)) {
        if (platform.mac) throw new Error('Choose BlackHole or another loopback input for the speaker audio on a Mac.');
        themStream = await openSystemLoopback(); labels.them = 'System audio';
      } else if (themLabel) {
        themDevice = byLabel(themLabel);
        if (!themDevice) throw unavailable();
        themStream = await openInput(themDevice, !isLoopback(themDevice.label)); labels.them = themDevice.label;
      } else {
        themDevice = devices.find(device => isLoopback(device.label)) || null;
        if (themDevice) { themStream = await openInput(themDevice, false); labels.them = themDevice.label; }
      }
      let mic = null;
      if (micLabel !== null || !themStream) {
        mic = micLabel ? byLabel(micLabel) : devices.find(device => device.deviceId === 'default' && !isLoopback(device.label)) || devices.find(device => !isLoopback(device.label)) || null;
        if (micLabel && !mic) { if (themStream) { problems.push('The selected microphone is unavailable, so only the speaker audio is transcribed.'); mic = undefined; } else throw unavailable(); }
        if (mic && themDevice && mic.deviceId === themDevice.deviceId) mic = undefined;
      }
      if (themStream) { connect(themStream, 'them', send); started.push('them'); }
      if (mic !== undefined && (micLabel !== null || !themStream)) {
        // A microphone gets noise suppression but no echo cancellation, which
        // would also remove a voice played on the speakers.
        const stream = await openInput(mic, !isLoopback(mic?.label));
        const name = stream.getAudioTracks()[0]?.label || mic?.label || 'Microphone';
        if (themStream) { connect(stream, 'me', send); started.push('me'); labels.me = name; }
        else {
          connect(stream, 'them', send); started.push('them'); labels.them = name;
          problems.push(platform.mac ? 'No BlackHole input was found, so the microphone is treated as the other side. Install BlackHole to hear the call directly (see docs/MACOS.md).' : 'Only the microphone is available.');
        }
      }
      return { started, problems, labels };
    } catch (error) {
      await stop();
      return { started: [], problems: [error.message || error.name], labels: {} };
    }
  }
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let failure = null;
      try {
        if (context?.state === 'running') await Promise.all(nodes.map(node => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The last audio frame could not be confirmed. Check the end of the transcript.')), 2000);
          node.flushDone = () => { clearTimeout(timer); resolve(); };
          node.port.postMessage({ type: 'flush' });
        })));
      } catch (error) { failure = error; }
      finally {
        for (const node of nodes) { try { node.port.onmessage = null; node.disconnect(); } catch {} }
        for (const stream of streams) for (const track of stream.getTracks()) track.stop();
        nodes = []; streams = [];
        if (context) { const closing = context; context = null; try { await closing.close(); } catch {} }
      }
      if (failure) throw failure;
    })();
    try { await stopping; } finally { stopping = null; }
  }

  window.meetingAudio = { start, stop, resume: () => context?.resume(), inputDevices, isLoopback, SYSTEM, active: () => !!context };
})();
