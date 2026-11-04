// Лимиты и контекст Codex. CLI их в поток не отдаёт, но пишет в файл сессии
// (~/.codex/sessions/ГГГГ/ММ/ДД/rollout-*.jsonl): rate_limits в событиях и
// turn_token_usage с размером промпта текущего хода.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.join(os.homedir(), '.codex', 'sessions');

function recentFiles(limit = 12) {
  const out = [];
  const walk = (dir, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (it.isFile() && it.name.endsWith('.jsonl')) {
        try { out.push({ path: p, mtime: fs.statSync(p).mtimeMs }); } catch { }
      }
    }
  };
  walk(ROOT, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// Читаем хвост файла — rate_limits и usage лежат в последних записях
function tail(file, bytes = 512 * 1024) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}

function scan(file) {
  let limits = null, ctx = null, win = 0, threadId = null;
  for (const line of tail(file).split('\n')) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload ?? d;
    if (p.thread_id) threadId = p.thread_id;
    if (p.model_context_window > 0) win = p.model_context_window;
    const rl = findRateLimits(p);
    if (rl) limits = rl;
    // Текущий контекст — это промпт ПОСЛЕДНЕГО запроса к модели (token_usage_record).
    // turn_token_usage для этого не годится: он складывает все запросы внутри хода
    // (у хода с инструментами их десятки), и в сумме выходит больше окна — отсюда «250%».
    const type = p.type ?? d.type;
    if (type === 'token_usage_record' && p.usage?.input_tokens > 0) ctx = p.usage.input_tokens;
  }
  return { limits, ctx, win, threadId };
}

function findRateLimits(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 4) return null;
  if (o.rate_limits?.primary || o.rate_limits?.secondary) return o.rate_limits;
  for (const v of Object.values(o)) {
    const r = findRateLimits(v, depth + 1);
    if (r) return r;
  }
  return null;
}

const fmt = ts => new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const windowName = m => m >= 10080 ? 'Неделя' : m >= 1440 ? `${Math.round(m / 1440)} дн.` : `Сессия · ${Math.round(m / 60)} ч`;

let cache = { at: 0, data: null };
export function snapshot({ threadId } = {}) {
  if (Date.now() - cache.at < 20000 && cache.data && !threadId) return cache.data;
  const files = recentFiles();
  let limits = null, ctxByThread = {}, winByThread = {};
  for (const f of files) {
    try {
      const r = scan(f.path);
      if (r.limits && !limits) limits = r.limits;
      if (r.threadId && r.ctx && !(r.threadId in ctxByThread)) {
        ctxByThread[r.threadId] = r.ctx;
        if (r.win) winByThread[r.threadId] = r.win;
      }
    } catch { }
    if (limits && threadId && ctxByThread[threadId]) break;
  }
  const out = {
    at: Date.now(),
    limits: limits ? [
      limits.primary && { label: windowName(limits.primary.window_minutes), pct: Math.round(limits.primary.used_percent), resets: fmt(limits.primary.resets_at) },
      limits.secondary && { label: windowName(limits.secondary.window_minutes), pct: Math.round(limits.secondary.used_percent), resets: fmt(limits.secondary.resets_at) },
    ].filter(Boolean) : [],
    ctxByThread, winByThread,
  };
  cache = { at: Date.now(), data: out };
  return out;
}
// контекст и настоящее окно модели — обе цифры берём из файла сессии Codex
export const contextFor = threadId => {
  if (!threadId) return null;
  const s = snapshot({ threadId });
  const used = s.ctxByThread[threadId];
  return used ? { used, window: s.winByThread[threadId] || 0 } : null;
};

// Живые лимиты аккаунта — штатным методом app-server `account/rateLimits/read` (стабильный, квоту не тратит).
// Файлы сессий показывают лимиты того аккаунта, что работал последним; после смены аккаунта
// нужны свежие цифры сразу, без нового хода.
export function readLiveLimits({ timeout = 15000, cmd = 'codex' } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', done = false;
    const end = (err, val) => { if (done) return; done = true; clearTimeout(t); try { p.kill(); } catch { } err ? reject(err) : resolve(val); };
    const t = setTimeout(() => end(new Error('Codex не ответил про лимиты.')), timeout);
    const send = o => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); } catch { } };
    p.on('error', e => end(e));
    p.on('close', () => end(new Error('Codex app-server закрылся раньше ответа.')));
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read', params: null }); }
        if (m.id === 2) {
          if (m.error) return end(new Error(m.error.message || 'Codex вернул ошибку.'));
          const rl = m.result?.rateLimits ?? {};
          const w = x => x && { label: windowName(x.windowDurationMins ?? 300), pct: Math.round(x.usedPercent ?? 0), resets: x.resetsAt ? fmt(x.resetsAt) : '' };
          end(null, { at: Date.now(), plan: rl.planType ?? null, limits: [w(rl.primary), w(rl.secondary)].filter(Boolean) });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'depo', version: '1' } } });
  });
}
