'use strict';

// One microphone turn at a time. Ending or interrupting a turn invalidates every pending callback.
(() => {
  const toggle = $('voiceToggle'), action = $('voiceTurn'), status = $('voiceStatus');
  const mic = $('voiceMic');
  let turn = null, context = null;

  async function listMics(t) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (turn !== t) return;
    const selected = mic.value;
    mic.replaceChildren(new Option('Default microphone', ''));
    for (const device of devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')) {
      mic.add(new Option(device.label || 'Microphone ' + mic.length, device.deviceId));
    }
    mic.value = selected;
    mic.hidden = mic.length < 2;
  }

  function closeMic(t) {
    clearInterval(t.timer);
    if (t.recorder?.state === 'recording') t.recorder.stop();
    t.stream?.getTracks().forEach(track => track.stop());
    t.input?.disconnect();
    t.analyser?.disconnect();
  }

  function stop(message = '') {
    const t = turn;
    turn = null;
    if (t) {
      t.cancel.abort();
      closeMic(t);
      t.player?.stop();
    }
    if (context) { context.close().catch(() => {}); context = null; }
    toggle.textContent = 'Start voice';
    action.hidden = mic.hidden = true;
    status.textContent = message;
  }

  function check(t) { t.cancel.signal.throwIfAborted(); }

  async function request(t, route, body) {
    check(t);
    const binary = body instanceof Blob;
    const r = await fetch('/api/voice/' + route, {
      method: 'POST', headers: { 'x-attune-token': TOKEN, 'content-type': binary ? body.type : 'application/json' },
      body: binary ? body : JSON.stringify(body), signal: t.cancel.signal,
    });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      throw new Error(error.errorText || error.error || 'Voice request failed. Try again or use text chat.');
    }
    return r;
  }

  function* segments(text) {
    let rest = text.trim();
    while (rest.length > 199) {
      const space = rest.lastIndexOf(' ', 199);
      const end = space > 0 ? space : 198;
      yield rest.slice(0, end);
      rest = rest.slice(end).trimStart();
    }
    if (rest) yield rest;
  }

  async function finish(t, blob) {
    try {
      check(t);
      status.textContent = 'Transcribing…';
      action.textContent = 'Interrupt';
      const { text } = await (await request(t, 'transcribe', blob)).json();
      check(t);
      if (!text) throw new Error('No speech recognized. Try again.');
      addMsg(text, 'user');
      status.textContent = 'Thinking…';
      const response = await (await request(t, 'reply', { text })).json();
      check(t);
      addMsg(response.reply, 'bot', { by: response.usedBody, instruction: response.vitalsInstruction });
      status.textContent = 'Speaking…';
      for (const part of segments(response.reply)) {
        const data = await (await request(t, 'speak', { text: part })).arrayBuffer();
        check(t);
        const sound = await context.decodeAudioData(data);
        check(t);
        const player = context.createBufferSource();
        player.buffer = sound;
        player.connect(context.destination);
        t.player = player;
        await new Promise(resolve => { player.onended = resolve; player.start(); });
        player.disconnect();
        t.player = null;
        check(t);
      }
      beginTurn();
    } catch (error) { if (turn === t) stop(error.message); }
  }

  async function beginTurn() {
    const t = { cancel: new AbortController() };
    turn = t;
    toggle.textContent = 'End voice';
    action.hidden = true;
    status.textContent = 'Opening microphone…';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, ...(mic.value ? { deviceId: { exact: mic.value } } : {}) }, video: false });
      if (turn !== t) { stream.getTracks().forEach(track => track.stop()); return; }
      t.stream = stream;
      listMics(t).catch(() => {});
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported(x));
      if (!type) throw new Error('This device cannot record a supported audio format.');
      const recorder = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 64000 });
      t.recorder = recorder;
      const chunks = [];
      recorder.ondataavailable = e => { if (e.data.size && turn === t) chunks.push(e.data); };
      recorder.onerror = () => { if (turn === t) stop('Microphone disconnected. Choose a microphone and start again.'); };
      recorder.onstop = () => {
        closeMic(t);
        if (turn === t) finish(t, new Blob(chunks, { type }));
      };
      t.input = context.createMediaStreamSource(stream);
      t.analyser = context.createAnalyser();
      t.analyser.fftSize = 1024;
      t.input.connect(t.analyser);
      stream.getAudioTracks()[0].onended = () => { if (turn === t) stop('Microphone disconnected. Start again to reconnect.'); };
      recorder.start();
      status.textContent = 'Listening… pause to send.';
      action.textContent = 'Send now';
      action.hidden = false;
      const samples = new Float32Array(t.analyser.fftSize);
      const started = performance.now();
      let lastSpeech = 0;
      t.timer = setInterval(() => {
        t.analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) energy += value * value;
        const now = performance.now();
        if (Math.sqrt(energy / samples.length) > 0.018) lastSpeech = now;
        if (!lastSpeech && now - started > 15000) return stop('Voice ended after silence.');
        if ((lastSpeech && now - lastSpeech > 1100) || now - started > 45000) closeMic(t);
      }, 100);
    } catch (error) {
      if (turn === t) stop(error.name === 'NotAllowedError' ? 'Microphone access was denied. Check device permissions or use text chat.' : error.message);
    }
  }

  toggle.onclick = async () => {
    if (turn) return stop('Voice ended.');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return stop('Microphone recording is unavailable here.');
    if (lastState?.mode === 'demo') return stop('Use real mode and your Groq key for voice.');
    if (!setup.hasGroq) { switchView('keys'); $('groqStatus').textContent = 'Add a Groq key to start voice chat.'; return; }
    if (!confirm('Start voice chat? Your microphone audio, transcript and replies go to Groq using your API key. Voice listens again after each reply until you end it. Camera consent is separate.')) return;
    try {
      context = new AudioContext();
      const ready = context.resume();
      beginTurn();
      await ready;
    } catch { stop('Audio is unavailable. Check your output device.'); }
  };
  action.onclick = () => {
    if (!turn) return;
    if (turn.recorder?.state === 'recording') return closeMic(turn);
    interrupt();
  };
  function interrupt() {
    if (!turn) return;
    const interrupted = turn;
    turn = null;
    interrupted.cancel.abort();
    closeMic(interrupted);
    interrupted.player?.stop();
    beginTurn();
  }
  mic.onchange = interrupt;
  for (const button of document.querySelectorAll('.navitem, #newChat')) button.addEventListener('click', () => stop());
  $('chatForm').addEventListener('submit', () => stop());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => stop());
})();
