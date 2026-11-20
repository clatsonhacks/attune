'use strict';

const BASE = 'https://api.groq.com/openai/v1/audio/';
const MAX_AUDIO = 2 * 1024 * 1024;

class VoiceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readRecording(req) {
  const mime = (req.headers['content-type'] || '').split(';')[0];
  const extensions = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg' };
  if (!Object.hasOwn(extensions, mime)) throw new VoiceError(415, 'Unsupported microphone format.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_AUDIO) { req.resume(); throw new VoiceError(413, 'Recording is too large. Try a shorter turn.'); }
    chunks.push(chunk);
  }
  if (!size) throw new VoiceError(400, 'No audio was recorded.');
  const form = new FormData();
  form.append('file', new Blob(chunks, { type: mime }), 'turn.' + extensions[mime]);
  form.append('model', 'whisper-large-v3');
  return form;
}

function createSpeechProvider(fetchFn = fetch) {
  async function post(endpoint, key, body, signal, headers = {}) {
    const result = await fetchFn(BASE + endpoint, {
      method: 'POST', headers: { authorization: 'Bearer ' + key, ...headers }, body, signal,
    });
    if (!result.ok) {
      const message = { 401: 'Check your Groq key in API Keys.', 403: 'Check speech model access and terms in your Groq console.',
        429: 'Groq is rate-limiting voice requests. Try again later.' }[result.status];
      await result.body?.cancel();
      throw new VoiceError(502, message || 'Groq could not process this voice request. Check model access or try again.');
    }
    return result;
  }
  return {
    async transcribe(req, key, signal) {
      const form = await readRecording(req);
      const r = await post('transcriptions', key, form, signal);
      const { text } = await r.json();
      return typeof text === 'string' ? text.trim().slice(0, 4000) : '';
    },
    async speak(text, key, signal) {
      if (typeof text !== 'string' || !text.trim() || text.length > 199) throw new VoiceError(400, 'Invalid speech segment.');
      const body = JSON.stringify({ model: 'canopylabs/orpheus-v1-english', voice: 'troy', input: text, response_format: 'wav' });
      const r = await post('speech', key, body, signal, { 'content-type': 'application/json' });
      return Buffer.from(await r.arrayBuffer());
    },
  };
}
module.exports = { createSpeechProvider, VoiceError };
