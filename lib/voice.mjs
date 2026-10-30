import { spawn } from 'node:child_process';

const URL_ = () => process.env.DEPO_VOICE_URL || 'http://127.0.0.1:2701';

export async function status() {
  try {
    const r = await fetch(URL_() + '/health', { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    return {
      available: !!d.ok, url: URL_(), hint: null,
      vosk: d.vosk, whisper: d.whisper, whisper_loading: !!d.whisper_loading, whisper_error: d.whisper_error,
    };
  } catch {
    return { available: false, url: URL_(), hint: 'Движок распознавания не запущен: sudo systemctl start depo-voice' };
  }
}

const call = async (path, body, ms = 120000) => {
  const r = await fetch(URL_() + path, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' },
    body: body ?? Buffer.alloc(0), signal: AbortSignal.timeout(ms),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Движок распознавания ответил ошибкой.');
  return d;
};
export const start = () => call('/start', null, 10000);
export const feed = (id, pcm) => call(`/feed?id=${encodeURIComponent(id)}`, pcm, 30000);
export const stop = (id, pcm) => call(`/stop?id=${encodeURIComponent(id)}`, pcm, 180000);

export function toPcm(input) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const out = [], err = [];
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => err.push(d));
    ff.on('error', e => reject(new Error('ffmpeg не запустился: ' + e.message)));
    ff.on('close', code => code === 0 && out.length
      ? resolve(Buffer.concat(out))
      : reject(new Error('Не удалось раскодировать запись. ' + Buffer.concat(err).toString().slice(0, 200))));
    ff.stdin.on('error', () => { });
    ff.stdin.end(input);
  });
}

export async function transcribe(audio) {
  const pcm = await toPcm(audio);
  if (pcm.length < 3200) return { text: '', short: true };
  const r = await fetch(URL_() + '/transcribe', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm,
    signal: AbortSignal.timeout(120000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Движок распознавания ответил ошибкой.');
  return d;
}
