// Диктовка через голос ChatGPT — штатным клиентом Codex CLI, под тем же входом в ChatGPT, что и Codex.
// Никаких ключей API и чужих эндпоинтов: Depo запускает `codex app-server`, а тот сам договаривается
// с ChatGPT о голосовой сессии (thread/realtime/*, WebRTC). Звук идёт из браузера напрямую в OpenAI,
// а текст речи возвращается через codex событиями transcript.
//
// Протокол у Codex помечен experimental и меняется между версиями (сейчас при входе через ChatGPT работает
// только v3 + audio-выход + WebRTC). Поэтому модуль сам подстраивается: перебирает версии и наборы
// параметров, запоминает рабочую комбинацию (data/voice-chatgpt.json) и после обновления Codex
// подбирает её заново. Если ничего не подошло — интерфейс сам переключается на движок сервера.
// Это голосовой ассистент, а не чистый распознаватель, поэтому:
//  • тред одноразовый (ephemeral), песочница read-only, одобрения запрещены;
//  • любой начавшийся ход агента Codex сразу прерывается, запросы разрешений отклоняются;
//  • голос ответа браузер не воспроизводит, сессия закрывается сразу после «Готово».
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_MS = 5 * 60 * 1000;
const sessions = new Map();

// ─── самонастройка под версию Codex ───
const VERSIONS = ['v3', 'v2', 'v1'];
const SHAPES = ['full', 'lean'];   // full — с clientManagedHandoffs и пр.; lean — только обязательное
let memo = { file: null, codex: null, version: null, shape: null };
export function configure({ dataDir } = {}) { if (dataDir) { memo.file = path.join(dataDir, 'voice-chatgpt.json'); try { memo = { ...memo, ...JSON.parse(fs.readFileSync(memo.file, 'utf8')) }; } catch { } } }
function remember(codex, version, shape) {
  memo = { ...memo, codex, version, shape, at: Date.now() };
  if (memo.file) try { fs.writeFileSync(memo.file, JSON.stringify({ codex, version, shape, at: memo.at })); } catch { }
}
export const forget = () => remember(null, null, null);   // после обновления Codex — подобрать заново
export const status = () => ({ ready: ready(), codex: memo.codex, version: memo.version, shape: memo.shape, at: memo.at ?? null });
const plan = codexVer => {
  const known = memo.version && memo.codex === codexVer ? [[memo.version, memo.shape]] : [];
  const all = VERSIONS.flatMap(v => SHAPES.map(sh => [v, sh]));
  return [...known, ...all.filter(([v, sh]) => !known.some(([a, b]) => a === v && b === sh))];
};
// ошибки, после которых имеет смысл попробовать другую версию/набор параметров, а не сдаваться
const retryable = msg => /version|quicksilver|unknown (field|variant)|invalid (type|value|params)|missing field|not supported|unsupported|realtime v\d|outputModality|deserializ/i.test(msg || '');

const PROMPT = `You are a silent speech-to-text service for a Russian-speaking developer.
Never reply, never speak, never call tools, never delegate or hand off. Only listen.`;

export const ready = () => { try { return fs.statSync(path.join(os.homedir(), '.codex', 'auth.json')).size > 10; } catch { return false; } };

function rpc(proc) {
  let next = 1, buf = '';
  const pending = new Map(), handlers = [];
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message || JSON.stringify(m.error))) : p.res(m.result);
      } else if (m.id != null && m.method) {
        // запрос от codex (разрешение на команду и т.п.) — всегда отказ: диктовка ничего не исполняет
        write({ id: m.id, error: { code: -32601, message: 'Depo: диктовка ничего не исполняет' } });
      } else if (m.method) for (const h of handlers) h(m.method, m.params ?? {});
    }
  });
  const write = o => { try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); } catch { } };
  return {
    call: (method, params) => new Promise((res, rej) => { const id = next++; pending.set(id, { res, rej }); write({ id, method, params }); }),
    notify: (method, params) => write({ method, ...(params ? { params } : {}) }),
    on: h => handlers.push(h),
  };
}

// Браузер прислал SDP-оффер со своим микрофоном → поднимаем сессию и отдаём SDP-ответ.
// prompt — свои инструкции (для ассистента — роль и сводка Depo); assistant — разговор, а не диктовка:
// ответы модели тоже приходят в onText (role: 'assistant'), сессия живёт дольше.
// assistant: голосовая модель отвечает сама, а вопросы «посмотри/что в проекте» передаёт агенту Codex —
// он работает в папке workdir только на чтение, с инструкциями agentInstructions (сводка Depo), без одобрений.
export async function start({ sdp, onText, log = () => { }, prompt = PROMPT, assistant = false, onEvent, workdir = null, agentInstructions = '' }) {
  if (!ready()) throw new Error('Codex не подключён — войди в аккаунт ChatGPT в настройках.');
  if (!sdp || typeof sdp !== 'string' || sdp.length > 200000) throw new Error('Нет SDP-оффера от браузера.');
  const id = crypto.randomUUID();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-voice-'));
  const proc = spawn('codex', ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => { });
  const c = rpc(proc);
  const s = { id, proc, cwd, threadId: null, text: '', partial: '', done: [], closed: false, waiters: [], error: null };
  sessions.set(id, s);
  s.timer = setTimeout(() => close(id), assistant ? 20 * 60e3 : MAX_MS);
  proc.on('close', () => { s.closed = true; s.waiters.splice(0).forEach(f => f()); cleanup(s); });
  proc.on('error', e => { s.error = e.code === 'ENOENT' ? 'Codex CLI не установлен на сервере.' : e.message; });

  let answer = null, failed = null;
  c.on((method, p) => {
    onEvent?.(method, p);   // отладка: все события сессии
    if (method === 'thread/realtime/sdp') answer = p.sdp;
    else if (method === 'thread/realtime/error') failed = p.message || p.error?.message || 'ChatGPT отказал в голосовой сессии.';
    else if (assistant && method === 'thread/realtime/transcript/delta') onText?.({ id, role: p.role, delta: p.delta ?? '' });
    else if (assistant && method === 'thread/realtime/transcript/done') onText?.({ id, role: p.role, done: p.text ?? '' });
    else if (method === 'thread/realtime/transcript/delta' && p.role === 'user') { s.partial += p.delta ?? ''; onText?.({ id, partial: (s.text + ' ' + s.partial).trim() }); }
    else if (method === 'thread/realtime/transcript/done' && p.role === 'user') {
      s.text = (s.text + ' ' + (p.text ?? '')).trim(); s.partial = '';
      onText?.({ id, partial: s.text });
      s.waiters.splice(0).forEach(f => f());
    } else if (method === 'turn/started' && assistant) {
      onText?.({ id, role: 'agent', state: 'working' });            // ассистент «смотрит в проект»
    } else if (method === 'turn/completed' && assistant) {
      onText?.({ id, role: 'agent', state: 'done' });
    } else if (method === 'turn/started') {
      // голосовая модель передала фразу агенту — останавливаем: диктовка не должна запускать работу
      log(`ChatGPT-диктовка: прерван ход Codex ${p.turn?.id ?? ''}`);
      c.call('turn/interrupt', { threadId: s.threadId, turnId: p.turn?.id }).catch(() => { });
    }
  });
  s.rpc = c;
  try {
    const init = await c.call('initialize', { clientInfo: { name: 'depo', version: '1' }, capabilities: { experimentalApi: true } });
    s.codexVersion = /\/(\d+\.\d+\.\d+)/.exec(init?.userAgent ?? '')?.[1] ?? 'unknown';
    c.notify('initialized');
    const th = await c.call('thread/start', { cwd: assistant && workdir && fs.existsSync(workdir) ? workdir : cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      developerInstructions: assistant
        ? (agentInstructions || 'Voice assistant for Depo.') + '\n\nYou are read-only: never edit files, never change git state, never run anything that modifies the system. Answer in Russian, briefly — your answer will be spoken aloud.'
        : 'Dictation only. Do nothing. Never call tools. Never edit files.' });
    s.threadId = th?.thread?.id ?? th?.threadId ?? th?.id;
    if (!s.threadId) throw new Error('Codex не создал тред для голосовой сессии.');
    const codexVer = s.codexVersion;
    let lastErr = null;
    for (const [version, shape] of plan(codexVer)) {
      failed = null; answer = null;
      const params = shape === 'full'
        ? { threadId: s.threadId, version, outputModality: 'audio', clientManagedHandoffs: !assistant, includeStartupContext: false, transport: { type: 'webrtc', sdp }, prompt }
        : { threadId: s.threadId, version, transport: { type: 'webrtc', sdp }, prompt };
      try { await c.call('thread/realtime/start', params); }
      catch (e) { lastErr = e.message; if (retryable(e.message)) continue; throw e; }
      for (let i = 0; i < 150 && !answer && !failed && !s.closed; i++) await new Promise(r => setTimeout(r, 100));
      if (answer) {
        if (memo.version !== version || memo.shape !== shape || memo.codex !== codexVer) { remember(codexVer, version, shape); log(`ChatGPT-диктовка: подобран протокол ${version}/${shape} для Codex ${codexVer}`); }
        return { id, sdp: answer };
      }
      lastErr = failed || s.error || 'ChatGPT не ответил на запрос голосовой сессии.';
      if (!failed || !retryable(failed)) break;
      await c.call('thread/realtime/stop', { threadId: s.threadId }).catch(() => { });
    }
    throw new Error(lastErr || 'Не удалось завести голосовую сессию ChatGPT.');
  } catch (e) { close(id); throw e; }
}

// «Готово»: ждём финальный текст последней фразы (обычно ~1–2 с), потом закрываем сессию.
export async function stop(id, { waitMs = 3500 } = {}) {
  const s = sessions.get(id);
  if (!s) throw new Error('Голосовая сессия уже закрыта.');
  if (s.partial && !s.closed) await new Promise(r => { s.waiters.push(r); setTimeout(r, waitMs); });
  const text = (s.text + ' ' + s.partial).trim();
  close(id);
  return { text };
}

export function close(id) {
  const s = sessions.get(id); if (!s) return;
  sessions.delete(id);
  clearTimeout(s.timer);
  if (s.threadId && !s.closed) s.rpc?.call('thread/realtime/stop', { threadId: s.threadId }).catch(() => { });
  setTimeout(() => { try { s.proc.kill('SIGTERM'); } catch { } }, 300);
}

function cleanup(s) { try { fs.rmSync(s.cwd, { recursive: true, force: true }); } catch { } }
export const active = () => sessions.size;

// Реплика текстом в живой голосовой разговор: ассистент ответит голосом, как на сказанное.
export async function appendText(id, text) {
  const s = sessions.get(id);
  if (!s || s.closed || !s.threadId) throw new Error('Голосовой разговор уже закрыт.');
  await s.rpc.call('thread/realtime/appendText', { threadId: s.threadId, text: String(text).slice(0, 4000), role: 'user' });
}
