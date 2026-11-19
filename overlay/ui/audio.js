'use strict';
// Audio capture for listening. "Me" is a microphone. "Them" is the meeting
// audio: on macOS a loopback device such as BlackHole, on Windows the system
// audio loopback (or any input device, e.g. VB-CABLE).
(() => {
  const SYSTEM = 'system';
  let context = null, streams = [], nodes = [];

  async function inputDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput' && device.deviceId !== 'communications'); }
    catch { return []; }
  }
  const isLoopback = label => /blackhole|loopback|soundflower|vb-?cable|cable output|voicemeeter|aggregate|multi-?output/i.test(label || '');
  // Device IDs change between launches in this private session, so devices are
  // remembered by label.
  async function resolve(label, fallback) {
    const devices = await inputDevices();
    if (label) { const match = devices.find(device => device.label === label); if (match) return match; }
    return fallback ? fallback(devices) : null;
  }
  async function openInput(device, voice) {
    return navigator.mediaDevices.getUserMedia({ audio: {
      ...(device ? { deviceId: { exact: device.deviceId } } : {}),
      // A loopback feed must not be filtered; a microphone benefits from it.
      echoCancellation: voice, noiseSuppression: voice, autoGainControl: voice, channelCount: voice ? 1 : { ideal: 2 }
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
    node.port.onmessage = event => send(source, event.data);
    context.createMediaStreamSource(stream).connect(node);
    nodes.push(node); streams.push(stream);
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => window.dispatchEvent(new CustomEvent('audio-source-ended', { detail: source })));
  }

  async function start({ me, them, micLabel, themLabel, platform }, send) {
    await stop();
    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('audio-worklet.js');
    const started = [], problems = [], labels = {};
    if (me) {
      try {
        const device = await resolve(micLabel, devices => devices.find(item => item.deviceId === 'default' && !isLoopback(item.label)) || devices.find(item => !isLoopback(item.label)) || null);
        const stream = await openInput(device, true); connect(stream, 'me', send); started.push('me');
        labels.me = stream.getAudioTracks()[0]?.label || device?.label || 'Microphone';
      } catch (error) { problems.push(`Microphone: ${error.message || error.name}`); }
    }
    if (them) {
      try {
        let stream;
        if (themLabel === SYSTEM && !platform.mac) stream = await openSystemLoopback();
        else {
          const device = await resolve(themLabel === SYSTEM ? '' : themLabel, devices => devices.find(item => isLoopback(item.label)) || null);
          if (!device) throw new Error(platform.mac ? 'No BlackHole or loopback input found. Install BlackHole and choose it in Listening settings.' : 'Choose a meeting audio source in Listening settings.');
          stream = await openInput(device, false);
          labels.them = device.label;
        }
        connect(stream, 'them', send); started.push('them');
        labels.them = labels.them || 'System audio';
      } catch (error) { problems.push(`Meeting audio: ${error.message || error.name}`); }
    }
    if (!started.length) { await stop(); }
    return { started, problems, labels };
  }
  async function stop() {
    for (const node of nodes) { try { node.port.onmessage = null; node.disconnect(); } catch { /* Already disconnected. */ } }
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    nodes = []; streams = [];
    if (context) { const closing = context; context = null; try { await closing.close(); } catch { /* Already closed. */ } }
  }
  window.meetingAudio = { start, stop, inputDevices, isLoopback, SYSTEM, active: () => !!context };
})();
