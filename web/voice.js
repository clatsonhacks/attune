'use strict';

// The microphone and speaker share one WebRTC call across every turn.
// OpenAI's server VAD handles speech boundaries, response cancellation and playout truncation.
(() => {
  const toggle = $('voiceToggle'), mic = $('voiceMic'), playback = $('voicePlayback'), status = $('voiceStatus');
  let active = null, latestCue = '';

  function showCallState(started) {
    toggle.classList.toggle('active', started);
    toggle.title = started ? 'Stop live voice' : 'Start live voice';
    toggle.setAttribute('aria-label', toggle.title);
    $('voiceNotice').hidden = started;
    $('voiceKeySetup').hidden = true;
  }

  function stop(message = '') {
    const call = active;
    active = null;
    if (call) {
      clearTimeout(call.timeout);
      call.abort.abort();
      call.stream?.getTracks().forEach(track => track.stop());
      call.channel?.close();
      call.peer?.close();
      call.audio.pause();
      call.audio.srcObject = null;
    }
    showCallState(false);
    playback.hidden = mic.hidden = true;
    status.textContent = message;
  }

  function updateGuidance(call, cue) {
    if (call !== active || call.channel?.readyState !== 'open' || call.lastCue === cue) return;
    const instructions = call.base + (cue ? '\nApproved pacing cue: ' + cue : '');
    call.channel.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions } }));
    call.lastCue = cue;
  }
  document.addEventListener('attune-guidance', e => {
    latestCue = e.detail;
    if (active) updateGuidance(active, latestCue);
  });

  async function play(call) {
    try { await call.audio.play(); if (active === call) playback.hidden = true; }
    catch { if (active === call) playback.hidden = false; }
  }
  playback.onclick = () => { if (active) play(active); };

  function activity(call) {
    api('/api/voice/realtime/activity', {}).then(result => {
      if (active === call && !result.ok) stop(result.error || 'Live voice disconnected.');
    }).catch(() => { if (active === call) stop('Attune disconnected. Start live voice to reconnect.'); });
  }

  function handleEvent(call, data) {
    if (call !== active) return;
    let e;
    try { e = JSON.parse(data); } catch { return; }
    switch (e.type) {
      case 'session.updated': {
        const instructions = e.session?.instructions || '';
        call.confirmedCue = instructions.startsWith(call.base + '\nApproved pacing cue: ')
          ? instructions.slice((call.base + '\nApproved pacing cue: ').length) : null;
        break;
      }
      case 'input_audio_buffer.speech_started':
        status.textContent = 'Hearing you…';
        activity(call);
        break;
      case 'input_audio_buffer.speech_stopped':
        status.textContent = 'Thinking…';
        break;
      case 'input_audio_buffer.committed':
        call.userBubbles.set(e.item_id, addMsg('…', 'user'));
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.failed': {
        const bubble = call.userBubbles.get(e.item_id);
        const text = e.transcript?.trim() || 'Voice turn (transcript unavailable)';
        if (bubble) bubble.textContent = text; else addMsg(text, 'user');
        call.userBubbles.delete(e.item_id);
        break;
      }
      case 'response.created':
        call.cues.set(e.response.id, call.confirmedCue);
        break;
      case 'output_audio_buffer.started':
        status.textContent = 'Speaking. You can interrupt.';
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript?.trim()) addMsg(e.transcript.trim(), 'bot', { instruction: call.cues.get(e.response_id) || null });
        break;
      case 'response.done':
        call.cues.delete(e.response?.id);
        if (e.response?.status === 'failed') stop('Voice response failed. Check your OpenAI project, then reconnect.');
        break;
      case 'output_audio_buffer.stopped':
        status.textContent = 'Listening…';
        break;
      case 'error':
        stop('OpenAI reported a session error. Check Realtime access and reconnect.');
        break;
    }
  }

  async function microphone(device) {
    return navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true,
      ...(device ? { deviceId: { exact: device } } : {}) } });
  }
  function watchMic(call, stream) {
    stream.getAudioTracks()[0].onended = () => {
      if (active === call && call.stream === stream) stop('Microphone disconnected. Select a microphone and reconnect.');
    };
  }
  mic.onchange = async () => {
    const call = active;
    if (!call?.sender) return;
    mic.disabled = true;
    let replacement;
    try {
      replacement = await microphone(mic.value);
      if (active !== call) return;
      await call.sender.replaceTrack(replacement.getAudioTracks()[0]);
      if (active !== call) return;
      call.stream.getTracks().forEach(track => track.stop());
      call.stream = replacement;
      watchMic(call, replacement);
      replacement = null;
    } catch { if (active === call) stop('Could not switch microphones. Start live voice to retry.'); }
    finally { replacement?.getTracks().forEach(track => track.stop()); mic.disabled = false; }
  };

  async function start() {
    if (active) return stop('Live voice ended.');
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return stop('Live voice requires a microphone and WebRTC.');
    if (lastState?.mode === 'demo') return stop('Start Attune in real mode to use live voice.');
    if (typeof setup.hasOpenAI !== 'boolean') return stop('Key settings unavailable. Reload Attune to try again.');
    if (!setup.hasOpenAI) {
      stop(setup.desktop ? 'Add your OpenAI key to start voice.' : 'Set OPENAI_API_KEY and restart the web service to use voice.');
      $('voiceKeySetup').hidden = !setup.desktop;
      return;
    }

    const call = { abort: new AbortController(), audio: new Audio(), confirmedCue: null, userBubbles: new Map(), cues: new Map() };
    active = call;
    showCallState(true);
    status.textContent = 'Opening microphone…';
    try {
      const stream = await microphone('');
      if (call !== active) { stream.getTracks().forEach(track => track.stop()); return; }
      call.stream = stream;
      watchMic(call, stream);
      status.textContent = 'Connecting…';
      call.timeout = setTimeout(() => { if (active === call) stop('Voice connection timed out. Try again.'); }, 35000);
      const peer = call.peer = new RTCPeerConnection();
      const channel = call.channel = peer.createDataChannel('oai-events');
      call.sender = peer.addTrack(stream.getAudioTracks()[0], stream);
      peer.ontrack = e => {
        if (active !== call) return;
        call.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
        play(call);
      };
      peer.onconnectionstatechange = () => {
        if (active === call && ['failed', 'disconnected'].includes(peer.connectionState)) stop('Voice disconnected. Start live voice to reconnect.');
      };
      channel.onmessage = e => handleEvent(call, e.data);
      channel.onclose = () => { if (active === call) stop('Voice session ended.'); };
      channel.onopen = () => {
        if (active !== call) return;
        clearTimeout(call.timeout);
        status.textContent = 'Listening…';
        updateGuidance(call, latestCue);
        activity(call);
        navigator.mediaDevices.enumerateDevices().then(devices => {
          if (active !== call) return;
          mic.replaceChildren(new Option('Default microphone', ''));
          for (const d of devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default')) {
            mic.add(new Option(d.label || 'Microphone ' + mic.length, d.deviceId));
          }
          mic.hidden = mic.length < 2;
        }).catch(() => {});
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch('/api/voice/realtime', { method: 'POST', signal: call.abort.signal,
        headers: { 'content-type': 'application/json', 'x-attune-token': TOKEN }, body: JSON.stringify({ sdp: offer.sdp }) });
      const result = await response.json();
      if (active !== call) return;
      if (!response.ok) throw new Error(result.error || 'Could not start live voice.');
      call.base = result.instructions;
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    } catch (error) {
      if (call === active) stop(error.name === 'NotAllowedError' ? 'Microphone permission was denied.' : error.message);
    }
  }

  toggle.onclick = start;
  $('voiceKeySetup').onclick = () => { stop(); switchView('keys'); $('openaiInput').focus(); };
  for (const button of document.querySelectorAll('.navitem, #newChat, #openSensing, #readInstruction, #signals')) {
    button.addEventListener('click', () => stop());
  }
  $('chatForm').addEventListener('submit', () => stop());
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  window.addEventListener('pagehide', () => stop());
})();
