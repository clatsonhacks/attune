'use strict';

const INSTRUCTIONS = 'You are the Attune voice companion. Have a natural, concise spoken conversation. Follow the user when they interrupt. Use an approved pacing cue quietly when present. Never infer vitals, claim a diagnosis, or recite sensor data.';

async function createRealtimeCall(key, sdp, signal, fetchFn = fetch) {
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime', model: 'gpt-realtime-2.1', instructions: INSTRUCTIONS,
    audio: {
      input: {
        transcription: { model: 'gpt-4o-mini-transcribe' },
        turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true },
      },
      output: { voice: 'marin' },
    },
  }));
  const response = await fetchFn('https://api.openai.com/v1/realtime/calls', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form, signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    const message = { 401: 'Check your OpenAI key in API Keys.', 403: 'Your OpenAI project needs Realtime model access.',
      429: 'Check your OpenAI project quota or try again later.' }[response.status];
    throw new Error(message || 'OpenAI could not start the realtime session. Check model access and try again.');
  }
  const answer = await response.text();
  if (!answer.startsWith('v=0')) throw new Error('The voice provider returned an invalid connection response.');
  return { sdp: answer, instructions: INSTRUCTIONS };
}
module.exports = { createRealtimeCall };
