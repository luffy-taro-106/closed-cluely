'use strict';
// Audio capture for listening. "Me" is a microphone. "Them" is the meeting
// audio: on macOS a loopback device such as BlackHole, on Windows the system
// audio loopback (or any input device, e.g. VB-CABLE).
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
  async function resolve(label, fallback) {
    const devices = await inputDevices();
    if (label) {
      const match = devices.find(device => device.label === label);
      if (match) return match;
      throw new Error('The selected audio input is unavailable. Reconnect it or choose another input in Recording settings.');
    }
    return fallback ? fallback(devices) : null;
  }
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

  // One input: the default microphone unless another device (for example
  // BlackHole, or Windows system audio) is chosen in Recording settings.
  async function start({ device: label, platform }, send) {
    await stop();
    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
    try {
      await context.suspend();
      await context.audioWorklet.addModule('audio-worklet.js');
      let stream, name;
      if (label === SYSTEM && !platform.mac) { stream = await openSystemLoopback(); name = 'System audio'; }
      else {
        const device = await resolve(label === SYSTEM ? '' : label, devices => devices.find(item => item.deviceId === 'default') || devices[0] || null);
        // A loopback feed must stay unprocessed; a microphone gets noise suppression
        // but no echo cancellation, which would remove a voice played on speakers.
        stream = await openInput(device, !isLoopback(device?.label));
        name = stream.getAudioTracks()[0]?.label || device?.label || 'Microphone';
      }
      connect(stream, 'them', send);
      return { started: ['them'], problems: [], labels: { them: name } };
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
