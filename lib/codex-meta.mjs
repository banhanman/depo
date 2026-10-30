import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
export const contextFor = threadId => {
  if (!threadId) return null;
  const s = snapshot({ threadId });
  const used = s.ctxByThread[threadId];
  return used ? { used, window: s.winByThread[threadId] || 0 } : null;
};
