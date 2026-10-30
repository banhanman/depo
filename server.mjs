import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { open, helpers } from './lib/db.mjs';
import * as auth from './lib/auth.mjs';
import { Hub } from './lib/events.mjs';
import { Runner } from './lib/runner.mjs';
import { Meters, chatContext, dropChatContext } from './lib/usage.mjs';
import { readKimiUsage } from './lib/kimi-meta.mjs';
import * as P from './lib/projects.mjs';
import * as handoff from './lib/handoff.mjs';
import * as files from './lib/files.mjs';
import * as voice from './lib/voice.mjs';
import { Telegram } from './lib/telegram.mjs';
import * as sessions from './lib/sessions.mjs';
import { catalog, kimiCatalog, refreshKimiCatalog } from './lib/models.mjs';
import * as codexMeta from './lib/codex-meta.mjs';
import * as accounts from './lib/accounts.mjs';
import { Linker } from './lib/link.mjs';
import { snapshotProject } from './lib/snapshot.mjs';
import * as companion from './lib/companion.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DEPO_DATA_DIR || path.join(ROOT, 'data');
const PORT = +(process.env.PORT || 4620);
const HOST = process.env.HOST || '0.0.0.0';
const PUB = path.join(ROOT, 'public');
const UPLOADS = path.join(DATA, 'uploads');
const TLS = path.join(DATA, 'tls');
const HTTPS_PORT = +(process.env.HTTPS_PORT || PORT + 1);

const db = open(DATA);
const h = helpers(db);
const hub = new Hub();
const boardItems = () => {
  const chats = h.all(`SELECT c.*, p.name AS project, p.glyph FROM chats c JOIN projects p ON p.id=c.project_id
                       WHERE c.archived=0 AND p.archived=0 ORDER BY c.updated_at DESC`);
  const lastText = id => h.get("SELECT text FROM messages WHERE chat_id=? AND role IN ('assistant','error','system') AND text IS NOT NULL ORDER BY id DESC LIMIT 1", id)?.text ?? '';
  const pend = [...approvals.values()].filter(a => !a.decided);
  return chats.map(c => {
    const a = pend.find(x => x.chat_id === c.id);
    const col = runner.isRunning(c.id) && !a ? 'running' : (c.state === 'attention' || a) ? 'attention' : c.unread ? 'done' : null;
    if (!col) return null;
    return { ...chatDTO(c), project: c.project, glyph: c.glyph, column: col,
      question: a ? `Разрешить ${a.tool_name}: ${summarizeInput(a.tool_name, a.input)}` : col === 'attention' ? lastText(c.id).slice(0, 220) : '',
      snippet: col !== 'attention' ? lastText(c.id).slice(0, 160) : '', approval_id: a?.id ?? null };
  }).filter(Boolean);
};

const tg = new Telegram(h, {
  meters: () => meters.both(),
  board: boardItems,
  running: () => runner.activeChats().map(id => {
    const c = h.get('SELECT c.title, p.name project FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?', id);
    return { id, title: c?.title ?? '', project: c?.name ?? c?.project ?? '' };
  }),
  attention: () => h.all("SELECT id FROM chats WHERE archived=0 AND state='attention'"),
  recent: () => h.all(`SELECT c.id, c.title, p.name project FROM chats c JOIN projects p ON p.id=c.project_id
                       WHERE c.archived=0 AND p.archived=0 ORDER BY c.updated_at DESC LIMIT 8`),
  chat: id => h.get('SELECT id, title, provider FROM chats WHERE id=?', id),
  tail: (id, n = 4) => h.all(`SELECT m.role, m.kind, m.text, r.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id
      WHERE m.chat_id=? AND m.text IS NOT NULL AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT ?`, id, n).reverse(),
  decide: (id, allow) => !!decide(id, allow, allow ? null : 'Отклонено из телеграма.'),
  send: async (chatId, text) => {
    const c = h.get('SELECT * FROM chats WHERE id=?', chatId);
    if (!c) return { ok: false, error: 'чат не найден' };
    const pr = h.get('SELECT * FROM projects WHERE id=?', c.project_id);
    if (!pr || !fs.existsSync(pr.path)) return { ok: false, error: 'папка проекта недоступна' };
    if (runner.isRunning(chatId)) return runner.write(chatId, text) ? { ok: true } : { ok: false, error: 'ход уже идёт' };
    try { runner.start({ ...c, cwd: pr.path }, text); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
});
const APPROVAL_TOKEN = crypto.randomBytes(24).toString('base64url');

const approvals = new Map();
function newApproval({ chat_id, tool_name, input, tool_use_id }) {
  const id = crypto.randomUUID();
  const a = { id, chat_id, tool_name, input, tool_use_id, decided: false, allow: false, message: null, waiters: [], at: Date.now() };
  approvals.set(id, a);
  h.run("UPDATE chats SET state='attention' WHERE id=? AND state='running'", chat_id);
  hub.send('approval', { id, chat_id, tool_name, input, at: a.at });
  hub.send('chat', { patch: { state: 'attention' }, chat_id });
  const chat = h.get('SELECT title, project_id FROM chats WHERE id=?', chat_id);
  if (tg.wants('attention')) tg.askApproval({
    id, title: chat?.title ?? 'чат', tool: tool_name,
    project: h.get('SELECT name FROM projects WHERE id=?', chat?.project_id)?.name ?? '',
    what: summarizeInput(tool_name, input),
  }).then(r => { if (!r.ok && !r.skipped) h.log('warn', 'telegram', r.error); });
  setTimeout(() => { if (!a.decided) decide(id, false, 'Никто не ответил за 20 минут.'); }, 20 * 60e3).unref();
  return a;
}
function decide(id, allow, message) {
  const a = approvals.get(id); if (!a || a.decided) return a;
  Object.assign(a, { decided: true, allow, message });
  for (const w of a.waiters.splice(0)) w();
  hub.send('approval-decided', { id, chat_id: a.chat_id, allow });
  if (runner.isRunning(a.chat_id)) { h.run("UPDATE chats SET state='running' WHERE id=?", a.chat_id); hub.send('chat', { patch: { state: 'running' }, chat_id: a.chat_id }); }
  setTimeout(() => approvals.delete(id), 60e3).unref();
  return a;
}
const summarizeInput = (tool, i) => String(i?.command || i?.file_path || i?.path || i?.pattern || i?.url || JSON.stringify(i ?? {})).slice(0, 160);
const pendingFor = chatId => [...approvals.values()].filter(a => !a.decided && a.chat_id === chatId)
  .map(a => ({ id: a.id, chat_id: a.chat_id, tool_name: a.tool_name, input: a.input, at: a.at }));

function notify(kind, d) {
  if (!tg.wants(kind)) return;
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let text;
  if (kind === 'error') text = `⚠️ <b>${esc(d.project)}</b> · ${esc(d.title)}\nход упал: ${esc((d.text || '').slice(0, 300))}`;
  else if (kind === 'done_long') text = `✅ <b>${esc(d.project)}</b> · ${esc(d.title)}\nход закончен за ${Math.round(d.secs / 60)} мин${d.cost ? ` · $${d.cost.toFixed(3)}` : ''}${d.answer ? '\n\n' + esc(d.answer.slice(0, 600)) : ''}`;
  else if (kind === 'limit') text = `📊 ${esc(d.label)} — ${d.pct}% израсходовано, сброс ${esc(d.resets)}`;
  else if (kind === 'attention') text = `❓ <b>${esc(d.project)}</b> · ${esc(d.title)}\n${esc(d.text || 'нужен твой ответ')}`;
  else if (kind === 'service') text = `🔁 Depo: ${esc(d.text)}`;
  else return;
  const buttons = d.chat_id ? [[{ text: '💬 Показать ход', callback_data: `open:${d.chat_id}` }, { text: '✍️ Ответить', callback_data: `chat:${d.chat_id}` }]] : undefined;
  tg.send(text, { buttons }).then(r => { if (!r.ok && !r.skipped) h.log('warn', 'telegram', r.error); });
}

const kimiModels = () => kimiCatalog();
const kimiReady = () => accounts.ready('kimi');
const companionOf = () => {
  const want = h.setting('pref_companion') || companion.DEFAULT;
  return companion.PROVIDERS.includes(want) ? want : companion.DEFAULT;
};
const catalogAll = () => ({
  ...catalog(), kimi: kimiModels(),
  ready: {
    claude: accounts.ready('claude'), codex: accounts.ready('codex'), kimi: kimiReady(),
    companion: companion.ready(companionOf()),
  },
  companion: { who: companionOf(), ready: Object.fromEntries(companion.PROVIDERS.map(p => [p, companion.ready(p)])) },
});

const runner = new Runner({ h, hub, env: process.env, notify, root: ROOT,
  approvalEnv: chatId => ({ DEPO_URL: `http://127.0.0.1:${PORT}`, DEPO_TOKEN: APPROVAL_TOKEN, DEPO_CHAT: chatId }),
  onRateLimit: info => meters.fromEvent(info),
  onRunEnd: chatId => {
    dropChatContext(chatId);
    for (const a of approvals.values()) if (!a.decided && a.chat_id === chatId) decide(a.id, false, 'Ход закончился.');
    snapshotLater(chatId);
  },
});
const meters = new Meters({ h, hub, home: os.homedir(), notify });

const dropEmpty = () => Number(h.run(
  `DELETE FROM chats WHERE turns=0 AND origin='depo' AND id NOT IN (SELECT DISTINCT chat_id FROM messages)
     AND created_at < ?`, Date.now() - 10 * 60e3).changes);
const droppedAtBoot = dropEmpty();
if (droppedAtBoot) h.log('info', 'chats', `убрано пустых чатов: ${droppedAtBoot}`);
setInterval(() => { const n = dropEmpty(); if (n) hub.send('reload', {}); }, 10 * 60e3).unref();

const interrupted = runner.reconcile();
if (interrupted) notify('service', { text: `перезапуск прервал ${interrupted} ход(ов), они помечены в чатах` });
meters.startLoop();
refreshKimiCatalog().then(() => hub.send('models', catalogAll())).catch(() => { });
tg.restartPolling();

const json = (res, code, body) => {
  const s = JSON.stringify(body ?? null);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};
const ok = (res, body) => json(res, 200, body ?? { ok: true });
const bad = (res, code, error) => json(res, code, { error });

async function body(req, limit = 4 << 20) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Слишком большой запрос.'); parts.push(c); }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new Error('Некорректный JSON.'); }
}

async function rawBody(req, limit = 24 << 20) {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Запись слишком длинная.'); parts.push(c); }
  return Buffer.concat(parts);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.json': 'application/json',
};
async function serveFile(res, file, { store = true } = {}) {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': store ? 'no-cache' : 'no-store',
    });
    res.end(data);
    return true;
  } catch { return false; }
}

const ipOf = req => (req.socket.remoteAddress || '').replace('::ffff:', '');

const projectDTO = p => ({ ...p, short: P.shorten(p.path), archived: !!p.archived });
let winCache = { at: 0, map: new Map() };
function windowOfModel(model) {
  if (!model) return 0;
  if (Date.now() - winCache.at > 60000) {
    winCache = { at: Date.now(), map: new Map() };
    for (const r of h.all(`SELECT model, MAX(ctx_window) w FROM runs
                           WHERE provider='claude' AND ctx_window>0 AND model IS NOT NULL GROUP BY model`))
      winCache.map.set(r.model, r.w);
  }
  return winCache.map.get(model) ?? 0;
}

function ctxOf(c) {
  const last = h.get(
    'SELECT ctx_used, ctx_window FROM runs WHERE chat_id=? AND provider=? AND ctx_used>0 ORDER BY id DESC LIMIT 1',
    c.id, c.provider);
  let used = last?.ctx_used ?? 0, win = last?.ctx_window ?? 0, exact = !!last;

  if (c.provider === 'codex') {
    const live = c.codex_thread ? codexMeta.contextFor(c.codex_thread) : null;
    if (live) { used = live.used; win = live.window || win || 400000; exact = true; }
    else win = win || 400000;
  } else if (c.provider === 'kimi') {
    used = used || c.ctx_used || 0;
    const model = kimiModels().items.find(m => m.id === (c.model || ''));
    win = win || c.ctx_window || model?.contextWindow || 0;
    exact = !!used;
  } else if (!used && c.origin === 'claude') {
    const pr = h.get('SELECT path FROM projects WHERE id=?', c.project_id);
    used = (pr && sessions.contextOf(pr.path, c.id)) || c.ctx_used || 0;
    win = windowOfModel(c.model);
    exact = false;
  }
  if (!used) return { used: 0, window: 0, pct: 0, exact: false };
  if (win && used > win) return { used: 0, window: 0, pct: 0, exact: false, over: true };
  return { used, window: win, pct: win ? Math.min(100, Math.round(used / win * 100)) : 0, exact };
}
const chatDTO = c => ({
  id: c.id, project_id: c.project_id, title: c.title, provider: c.provider, model: c.model,
  permission_mode: c.permission_mode, effort: c.effort ?? '', state: c.state, pinned: !!c.pinned, archived: !!c.archived, origin: c.origin ?? 'depo', unread: !!c.unread,
  turns: c.turns, cost_usd: c.cost_usd, ctx_used: c.ctx_used, ctx_window: c.ctx_window,
  created_at: c.created_at, updated_at: c.updated_at,
  ...(({ used, window, pct, exact, over }) => ({ ctx_used: used, ctx_window: window, ctx_pct: pct, ctx_exact: exact, ctx_over: !!over }))(ctxOf(c)),
});
const msgDTO = m => ({ ...m, json: m.json ? JSON.parse(m.json) : null, provider: m.provider ?? null });

function fullState(user) {
  const projects = h.all('SELECT * FROM projects ORDER BY archived, position, id').map(projectDTO);
  const chats = h.all('SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC').map(chatDTO);
  return {
    user: { login: user.login },
    projects, chats,
    meters: { claude: meters.snapshot('claude'), codex: meters.snapshot('codex'), kimi: meters.snapshot('kimi') },
    running: runner.activeChats(),
    approvals: [...approvals.values()].filter(a => !a.decided).map(a => ({ id: a.id, chat_id: a.chat_id, tool_name: a.tool_name, input: a.input, at: a.at })),
    models: catalogAll(), prefs: prefs(),
    host: { name: os.hostname(), home: os.homedir() },
    https: fs.existsSync(path.join(TLS, 'server.crt')) ? HTTPS_PORT : null,
    version: VERSION,
  };
}
const VERSION = '0.1.0';
const PROVIDERS = new Set(['claude', 'codex', 'kimi']);
const normProv = p => PROVIDERS.has(p) ? p : 'claude';
const DEFAULTS = { companion: companion.DEFAULT, provider: 'claude', model: '', permission_mode: 'manual', mirror: '1', archive_days: '14', effort: '', tools: '0', snapshot: '1' };
const prefs = () => Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, h.setting('pref_' + k) ?? v]));

const routes = [];
const route = (method, pattern, handler, open = false) => {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-z_]+/gi, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, open });
};

route('POST', '/api/login', async (req, res) => {
  const { login, password } = await body(req);
  const key = ipOf(req) + '|' + String(login).slice(0, 64);
  const t = auth.throttle(key);
  if (!t.ok) return bad(res, 429, `Слишком много попыток. Подожди ${Math.ceil(t.wait / 60)} мин.`);
  const u = auth.verify(h, String(login || ''), String(password || ''));
  if (!u) { h.log('warn', 'auth', `неудачный вход ${login} c ${ipOf(req)}`); return bad(res, 401, 'Неверный логин или пароль.'); }
  auth.resetThrottle(key);
  const token = auth.startSession(h, u.id, req.headers['user-agent']);
  res.setHeader('set-cookie', auth.cookieHeader(token, !!req.socket.encrypted));
  h.log('info', 'auth', `вход ${u.login} c ${ipOf(req)}${req.socket.encrypted ? ' (https)' : ''}`);
  ok(res, { ok: true });
}, true);

route('POST', '/api/logout', async (req, res) => {
  auth.endSession(h, req);
  res.setHeader('set-cookie', auth.clearCookie());
  ok(res);
}, true);

route('POST', '/api/password', async (req, res, _p, s) => {
  const { current, next } = await body(req);
  if (!auth.verify(h, s.user.login, String(current || ''))) return bad(res, 403, 'Текущий пароль неверный.');
  if (String(next || '').length < 8) return bad(res, 400, 'Пароль должен содержать не менее 8 символов.');
  auth.setPassword(h, s.user.id, String(next));
  res.setHeader('set-cookie', auth.clearCookie());
  ok(res, { ok: true, relogin: true });
});

route('GET', '/api/state', (req, res, _p, s) => ok(res, fullState(s.user)));
route('GET', '/api/stream', (req, res) => { hub.attach(res, req); });
route('GET', '/api/meters', async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const provider = normProv(q.get('provider'));
  if (provider === 'codex') return ok(res, meters.snapshot('codex'));
  await meters.refresh({ force: q.get('force') === '1' });
  ok(res, meters.snapshot(provider));
});

route('GET', '/api/projects/suggest', (req, res) =>
  ok(res, { items: P.suggestions(h.all('SELECT path FROM projects').map(r => r.path)) }));

route('POST', '/api/projects', async (req, res) => {
  const { name, path: raw, create } = await body(req);
  const nm = String(name || '').trim();
  if (!nm) return bad(res, 400, 'Нужно название проекта.');
  const chk = P.checkPath(raw || path.join(os.homedir(), slug(nm)));
  if (!chk.ok) return bad(res, 400, chk.error);
  const dir = P.ensureDir(chk.abs, !!create);
  if (!dir.ok) return bad(res, 400, dir.error);
  if (h.get('SELECT id FROM projects WHERE path=?', chk.abs)) return bad(res, 409, 'Эта папка уже подключена.');
  const taken = h.all('SELECT glyph FROM projects').map(r => r.glyph);
  const pos = (h.get('SELECT MAX(position) m FROM projects')?.m ?? 0) + 1;
  const r = h.run('INSERT INTO projects(name,path,glyph,position,created_at) VALUES(?,?,?,?,?)',
    nm, chk.abs, P.glyphFor(nm, taken), pos, Date.now());
  const p = projectDTO(h.get('SELECT * FROM projects WHERE id=?', Number(r.lastInsertRowid)));
  hub.send('project', { project: p });
  h.log('info', 'projects', `подключён ${nm} → ${chk.abs}${dir.created ? ' (папка создана)' : ''}`);
  ok(res, { project: p, created: dir.created });
});

route('PATCH', '/api/projects/:id', async (req, res, p) => {
  const b = await body(req);
  const cur = h.get('SELECT * FROM projects WHERE id=?', +p.id);
  if (!cur) return bad(res, 404, 'Проект не найден.');
  const sets = [], vals = [];
  for (const k of ['name', 'glyph', 'position', 'archived']) {
    if (b[k] === undefined) continue;
    sets.push(`${k}=?`); vals.push(k === 'archived' ? (b[k] ? 1 : 0) : k === 'glyph' ? String(b[k]).toUpperCase().slice(0, 2) : b[k]);
  }
  if (!sets.length) return ok(res, { project: projectDTO(cur) });
  h.run(`UPDATE projects SET ${sets.join(',')} WHERE id=?`, ...vals, +p.id);
  const np = projectDTO(h.get('SELECT * FROM projects WHERE id=?', +p.id));
  hub.send('project', { project: np });
  ok(res, { project: np });
});

route('POST', '/api/projects/reorder', async (req, res) => {
  const { ids } = await body(req);
  if (!Array.isArray(ids)) return bad(res, 400, 'Нужен список id.');
  ids.forEach((id, i) => h.run('UPDATE projects SET position=? WHERE id=?', i + 1, +id));
  hub.send('projects-reordered', { ids });
  ok(res);
});

route('DELETE', '/api/projects/:id', async (req, res, p) => {
  const cur = h.get('SELECT * FROM projects WHERE id=?', +p.id);
  if (!cur) return bad(res, 404, 'Проект не найден.');
  for (const c of h.all('SELECT id FROM chats WHERE project_id=?', +p.id)) runner.cancel(c.id);
  h.run('DELETE FROM projects WHERE id=?', +p.id);
  hub.send('project-removed', { id: +p.id });
  h.log('info', 'projects', `отключён ${cur.name} (папка ${cur.path} осталась на диске)`);
  ok(res, { ok: true, folder_kept: cur.path });
});

route('POST', '/api/chats', async (req, res) => {
  const b = await body(req);
  const idle = h.get(`SELECT * FROM chats WHERE project_id=? AND turns=0 AND archived=0 AND origin='depo'
                      AND id NOT IN (SELECT DISTINCT chat_id FROM messages) ORDER BY created_at DESC LIMIT 1`, +b.project_id);
  if (idle && !b.force) return ok(res, { chat: chatDTO(idle), reused: true });
  const pr = h.get('SELECT * FROM projects WHERE id=?', +b.project_id);
  if (!pr) return bad(res, 400, 'Проект не найден.');
  const id = crypto.randomUUID();
  const t = Date.now();
  h.run(`INSERT INTO chats(id,project_id,title,provider,model,permission_mode,effort,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?)`,
    id, pr.id, String(b.title || 'Новый чат').slice(0, 200), normProv(b.provider || prefs().provider),
    b.model ?? (prefs().model || null), b.permission_mode || prefs().permission_mode || 'manual',
    b.effort ?? (prefs().effort || ''), t, t);
  const c = chatDTO(h.get('SELECT * FROM chats WHERE id=?', id));
  hub.send('chat', { chat: c, created: true });
  ok(res, { chat: c });
});

route('GET', '/api/chats/:id/messages', (req, res, p) => {
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  const after = +(new URL(req.url, 'http://x').searchParams.get('after') || 0);
  const rows = h.all(`SELECT m.*, r.provider FROM messages m LEFT JOIN runs r ON r.id = m.run_id
                      WHERE m.chat_id=? AND m.id>? ORDER BY m.id LIMIT 2000`, p.id, after);
  if (c.unread && !after) { h.run('UPDATE chats SET unread=0 WHERE id=?', p.id); c.unread = 0; hub.send('chat', { patch: { unread: false }, chat_id: p.id }); }
  ok(res, { chat: chatDTO(c), messages: rows.map(msgDTO), running: runner.isRunning(p.id) });
});

route('PATCH', '/api/chats/:id', async (req, res, p) => {
  const b = await body(req);
  const cur = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!cur) return bad(res, 404, 'Чат не найден.');
  const sets = [], vals = [];
  for (const k of ['title', 'provider', 'model', 'permission_mode', 'effort', 'pinned', 'archived', 'state', 'unread']) {
    if (b[k] === undefined) continue;
    const v = k === 'provider' ? normProv(b[k]) : ['pinned', 'archived', 'unread'].includes(k) ? (b[k] ? 1 : 0) : b[k];
    sets.push(`${k}=?`); vals.push(v);
  }
  if (!sets.length) return ok(res, { chat: chatDTO(cur) });
  sets.push('updated_at=?'); vals.push(Date.now());
  h.run(`UPDATE chats SET ${sets.join(',')} WHERE id=?`, ...vals, p.id);
  const c = chatDTO(h.get('SELECT * FROM chats WHERE id=?', p.id));
  hub.send('chat', { chat: c });
  ok(res, { chat: c });
});

route('DELETE', '/api/chats/:id', (req, res, p) => {
  runner.cancel(p.id);
  sessions.deleteChat(h, p.id);
  hub.send('chat-removed', { id: p.id });
  ok(res);
});

route('POST', '/api/chats/:id/send', async (req, res, p) => {
  const { text, attachments } = await body(req);
  const msg = String(text || '').trim();
  const atts = (Array.isArray(attachments) ? attachments : []).filter(a => a?.path?.startsWith(UPLOADS + path.sep)).slice(0, 12);
  if (!msg && !atts.length) return bad(res, 400, 'Пустое сообщение.');
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  if (!accounts.ready(c.provider)) return bad(res, 409, `${handoff.nameOf(c.provider)} отключён. Войди в аккаунт в настройках или выбери другого агента.`);
  const pr = h.get('SELECT * FROM projects WHERE id=?', c.project_id);
  if (!pr || !fs.existsSync(pr.path)) return bad(res, 400, 'Папка проекта недоступна.');

  if (runner.isRunning(p.id)) {
    if (runner.write(p.id, msg)) {
      runner.save(p.id, null, 'user', 'text', msg);
      return ok(res, { steered: true });
    }
    return bad(res, 409, 'Ход уже идёт, дополнить его не вышло.');
  }

  if (c.title === 'Новый чат') {
    const title = msg.replace(/\s+/g, ' ').slice(0, 72) + (msg.length > 72 ? '…' : '');
    h.run('UPDATE chats SET title=? WHERE id=?', title, p.id);
    hub.send('chat', { chat: chatDTO(h.get('SELECT * FROM chats WHERE id=?', p.id)) });
  }
  let prompt = msg;
  const last = h.get('SELECT provider FROM runs WHERE chat_id=? ORDER BY id DESC LIMIT 1', p.id);
  if (last && last.provider !== c.provider) {
    const ho = handoff.build(h, c, last.provider, c.provider);
    if (ho) {
      prompt = ho.text + '\n\n## Новое сообщение владельца\n' + msg;
      runner.save(p.id, null, 'handoff', 'notice',
        `Передача из ${handoff.nameOf(last.provider)} в ${handoff.nameOf(c.provider)}: задача, ${ho.files.length} файлов и последние ходы. Скрытые рассуждения не переносятся.`,
        { files: ho.files, from: last.provider, to: c.provider });
    }
  }

  try {
    const runId = runner.start({ ...c, cwd: pr.path }, msg || '(вложения)', prompt || 'Посмотри вложения.', atts);
    meters.refresh({ force: true, cwd: pr.path }).catch(() => { });
    ok(res, { run_id: runId });
  } catch (e) { bad(res, 409, e.message); }
});

route('POST', '/api/chats/:id/cancel', (req, res, p) =>
  ok(res, { cancelled: runner.cancel(p.id) }));

const tokenOk = req => req.headers['x-depo-token'] === APPROVAL_TOKEN && ipOf(req) === '127.0.0.1';
route('POST', '/api/approvals', async (req, res) => {
  if (!tokenOk(req)) return bad(res, 403, 'Нет.');
  const b = await body(req);
  if (!b.chat_id || !b.tool_name) return bad(res, 400, 'Нужны chat_id и tool_name.');
  ok(res, { id: newApproval(b).id });
}, true);
route('GET', '/api/approvals/:id/wait', (req, res, p) => {
  if (!tokenOk(req)) return bad(res, 403, 'Нет.');
  const a = approvals.get(p.id);
  if (!a) return ok(res, { decided: true, allow: false, message: 'Запрос потерян.' });
  const answer = () => ok(res, { decided: true, allow: a.allow, message: a.message });
  if (a.decided) return answer();
  const t = setTimeout(() => { a.waiters = a.waiters.filter(w => w !== answer); ok(res, { decided: false }); }, 50000);
  a.waiters.push(() => { clearTimeout(t); answer(); });
}, true);
route('POST', '/api/approvals/:id/decide', async (req, res, p) => {
  const b = await body(req);
  const a = decide(p.id, !!b.allow, b.allow ? null : (b.message || 'Владелец отклонил.'));
  if (!a) return bad(res, 404, 'Такого запроса уже нет.');
  runner.save(a.chat_id, null, 'system', 'notice', `${b.allow ? 'Разрешено' : 'Отклонено'}: ${a.tool_name} — ${summarizeInput(a.tool_name, a.input)}`);
  ok(res, { ok: true });
});
route('GET', '/api/chats/:id/context', async (req, res, p) => {
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  if (c.provider === 'kimi') {
    if (!c.kimi_session) return ok(res, { provider: 'kimi', ...ctxOf(c), rows: [] });
    try {
      const d = await readKimiUsage({ sessionId: c.kimi_session, cwd: h.get('SELECT path FROM projects WHERE id=?', c.project_id)?.path || os.homedir() });
      if (!d.context) return ok(res, { provider: 'kimi', ...ctxOf(c), rows: [] });
      const { used, window, pct } = d.context;
      h.run('UPDATE chats SET ctx_used=?, ctx_window=? WHERE id=?', used, window, c.id);
      hub.send('chat', { patch: { ctx_used: used, ctx_window: window, ctx_pct: pct, ctx_exact: true }, chat_id: c.id });
      return ok(res, { provider: 'kimi', used, window, pct, exact: true, rows: [] });
    } catch (e) { return bad(res, 503, e.message); }
  }
  if (c.provider !== 'claude') return ok(res, { provider: c.provider, ...ctxOf(c), rows: [] });
  const pr = h.get('SELECT * FROM projects WHERE id=?', c.project_id);
  if (!pr || !fs.existsSync(pr.path)) return bad(res, 400, 'Папка проекта недоступна.');
  let size = 0;
  try { size = fs.statSync(path.join(sessions.sessionsDir(pr.path), c.id + '.jsonl')).size; } catch { }
  try {
    const d = await chatContext(c.id, pr.path, size);
    if (!d) return ok(res, { provider: 'claude', ...ctxOf(c), rows: [] });
    h.run('UPDATE chats SET ctx_used=?, ctx_window=? WHERE id=?', d.used, d.window, c.id);
    h.run(`INSERT INTO runs(chat_id,provider,model,status,started_at,ended_at,ctx_used,ctx_window)
           SELECT ?,?,?,'context',?,?,?,? WHERE NOT EXISTS
           (SELECT 1 FROM runs WHERE chat_id=? AND status='context' AND ctx_used=?)`,
      c.id, 'claude', (d.model && !d.model.startsWith('<')) ? d.model : c.model, Date.now(), Date.now(), d.used, d.window, c.id, d.used);
    hub.send('chat', { patch: { ctx_used: d.used, ctx_window: d.window, ctx_pct: d.window ? Math.round(d.used / d.window * 100) : 0, ctx_exact: true }, chat_id: c.id });
    ok(res, { provider: 'claude', used: d.used, window: d.window, model: d.model,
      pct: d.window ? Math.round(d.used / d.window * 100) : 0, exact: true,
      rows: d.rows, untilCompact: d.untilCompact });
  } catch (e) { bad(res, 503, e.message); }
});

route('GET', '/api/chats/:id/approvals', (req, res, p) => ok(res, { items: pendingFor(p.id) }));

route('GET', '/api/models', (req, res) => ok(res, catalogAll()));

const syncing = new Set();
const mirrorEmit = (t, d) => hub.send(t, t === 'chat' ? { ...d, chat: chatDTO(d.chat) } : d);
async function syncOne(pr, only = null) {
  if (!only && prefs().mirror !== '1') return { added: 0, updated: 0, off: true };
  if (syncing.has(pr.id)) return { added: 0, updated: 0 };
  syncing.add(pr.id);
  try { return await sessions.syncProject(h, pr, { archiveDays: +prefs().archive_days || 14, skip: id => runner.isRunning(id), emit: mirrorEmit, only }); }
  catch (e) { h.log('warn', 'sessions', `${pr.name}: ${e.message}`); return { added: 0, updated: 0, error: e.message }; }
  finally { syncing.delete(pr.id); }
}
route('POST', '/api/projects/:id/sync', async (req, res, p) => {
  const pr = h.get('SELECT * FROM projects WHERE id=?', +p.id);
  if (!pr) return bad(res, 404, 'Проект не найден.');
  ok(res, await syncOne(pr));
});
route('GET', '/api/projects/:id/sessions', async (req, res, p) => {
  const pr = h.get('SELECT * FROM projects WHERE id=?', +p.id);
  if (!pr) return bad(res, 404, 'Проект не найден.');
  ok(res, { items: await sessions.previewSessions(h, pr), dir: sessions.sessionsDir(pr.path) });
});
route('POST', '/api/projects/:id/sessions/:sid/import', async (req, res, p) => {
  const pr = h.get('SELECT * FROM projects WHERE id=?', +p.id);
  if (!pr) return bad(res, 404, 'Проект не найден.');
  const r = await syncOne(pr, [p.sid]);
  if (!r.added && !r.updated) return bad(res, 409, 'Эта сессия уже поднята или в ней нечего поднимать.');
  hub.send('reload', {});
  ok(res, { ...r, chat_id: p.sid });
});

setInterval(() => {
  for (const pr of h.all('SELECT * FROM projects WHERE archived=0')) syncOne(pr).catch(() => { });
}, 45000).unref();

const projectRoot = id => {
  const p = h.get('SELECT * FROM projects WHERE id=?', +id);
  if (!p) throw new Error('Проект не найден.');
  if (!fs.existsSync(p.path)) throw new Error('Папка проекта недоступна.');
  return p.path;
};
route('GET', '/api/projects/:id/files', async (req, res, p) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path') || '.';
  ok(res, await files.list(projectRoot(p.id), rel));
});
route('GET', '/api/projects/:id/file', async (req, res, p) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path');
  if (!rel) return bad(res, 400, 'Нужен путь.');
  ok(res, { ...await files.read(projectRoot(p.id), rel), path: rel });
});
route('GET', '/api/projects/:id/diff', async (req, res, p) => ok(res, await files.diff(projectRoot(p.id))));

const safeName = n => String(n || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120) || 'file';
const isImage = t => /^image\/(png|jpe?g|gif|webp)$/.test(t || '');
route('POST', '/api/chats/:id/attach', async (req, res, p) => {
  if (!h.get('SELECT id FROM chats WHERE id=?', p.id)) return bad(res, 404, 'Чат не найден.');
  const data = await rawBody(req, 32 << 20);
  if (!data.length) return bad(res, 400, 'Пустой файл.');
  const name = safeName(decodeURIComponent(req.headers['x-name'] || 'file'));
  const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  const dir = path.join(UPLOADS, p.id); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now().toString(36)}-${name}`);
  await fsp.writeFile(file, data);
  ok(res, { name, path: file, size: data.length, image: isImage(type), media_type: type, url: `/api/uploads/${p.id}/${path.basename(file)}` });
});
route('GET', '/api/uploads/:chat/:name', async (req, res, p) => {
  const file = path.join(UPLOADS, p.chat, path.basename(p.name));
  if (!file.startsWith(UPLOADS)) return bad(res, 403, 'Нельзя.');
  if (!await serveFile(res, file)) bad(res, 404, 'Нет файла.');
});
route('POST', '/api/projects/:id/upload', async (req, res, p) => {
  const root = projectRoot(p.id);
  const q = new URL(req.url, 'http://x').searchParams;
  const dir = files.inside(root, q.get('dir') || '.');
  const name = safeName(decodeURIComponent(req.headers['x-name'] || 'file'));
  const data = await rawBody(req, 256 << 20);
  if (!data.length) return bad(res, 400, 'Пустой файл.');
  let target = path.join(dir, name), i = 1;
  while (fs.existsSync(target)) { const e = path.extname(name); target = path.join(dir, `${name.slice(0, name.length - e.length)}-${i++}${e}`); }
  await fsp.writeFile(target, data);
  h.log('info', 'files', `загружен ${path.relative(root, target)} в ${path.basename(root)}`);
  ok(res, { path: path.relative(root, target), size: data.length });
});
route('GET', '/api/projects/:id/raw', async (req, res, p) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path');
  if (!rel) return bad(res, 400, 'Нужен путь.');
  const abs = files.inside(projectRoot(p.id), rel);
  if (!await serveFile(res, abs)) bad(res, 404, 'Нет файла.');
});

route('GET', '/api/accounts', (req, res) => ok(res, {
  claude: { current: accounts.current('claude'), profiles: accounts.list(DATA, 'claude') },
  codex: { current: accounts.current('codex'), profiles: accounts.list(DATA, 'codex') },
  kimi: { current: accounts.current('kimi') },
  gemini: { current: accounts.current('gemini') },
}));
route('POST', '/api/accounts/:provider/save', async (req, res, p) => {
  const { name } = await body(req);
  try { ok(res, await accounts.save(DATA, p.provider, name)); } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/accounts/:provider/use', async (req, res, p) => {
  const { name } = await body(req);
  if (runner.activeChats().length) return bad(res, 409, 'Сначала дождись или останови текущие ходы.');
  try {
    const r = await accounts.use(DATA, p.provider, name);
    h.log('info', 'accounts', `${p.provider} → профиль ${r.name}`);
    meters.refresh({ force: true }).catch(() => { });
    hub.send('models', catalogAll()); ok(res, r);
  } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/accounts/:provider/forget', async (req, res, p) => {
  const { name } = await body(req);
  await accounts.remove(DATA, p.provider, name); ok(res);
});
route('POST', '/api/accounts/:provider/logout', async (req, res, p) => {
  if (runner.activeChats().length) return bad(res, 409, 'Сначала дождись или останови текущие ходы.');
  try {
    await accounts.logout(p.provider);
    h.log('info', 'accounts', `${p.provider}: выход из аккаунта`);
    hub.send('models', catalogAll()); ok(res);
  } catch (e) { bad(res, 400, e.message); }
});

route('POST', '/api/chats/:id/companion', async (req, res, p) => {
  const who = companionOf();
  if (!companion.ready(who)) return bad(res, 400, `Собеседник (${who}) не подключён — войди в него в настройках.`);
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  const { text = '', voice = false } = await body(req);
  const question = String(text).trim() || 'Что сейчас происходит в этом чате и что разумно сделать дальше?';

  const rows = h.all(`SELECT m.role, m.text, r.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id
                      WHERE m.chat_id=? AND m.role IN ('user','assistant') AND m.kind='text' ORDER BY m.id`, c.id);
  const t = Date.now();
  const rr = h.run('INSERT INTO runs(chat_id,provider,model,status,started_at) VALUES(?,?,?,?,?)',
    c.id, 'companion', who, 'running', t);
  const runId = Number(rr.lastInsertRowid);
  const put = (role, body2) => {
    const r2 = h.run('INSERT INTO messages(chat_id,run_id,role,kind,text,ts) VALUES(?,?,?,?,?,?)', c.id, runId, role, 'text', body2, Date.now());
    const m = h.get('SELECT m.*, r.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.id=?', Number(r2.lastInsertRowid));
    hub.send('message', { chat_id: c.id, message: msgDTO(m) });
    return m;
  };
  put('user', question);
  try {
    const a = await companion.ask({ provider: who, question, context: companion.digest(rows), voice: !!voice });
    put('assistant', a.text);
    h.run('UPDATE runs SET status=?, ended_at=? WHERE id=?', 'done', Date.now(), runId);
    h.run('UPDATE chats SET updated_at=? WHERE id=?', Date.now(), c.id);
    ok(res, { text: a.text, provider: a.provider });
  } catch (e) {
    h.run('UPDATE runs SET status=?, ended_at=? WHERE id=?', 'error', Date.now(), runId);
    put('error', `Собеседник: ${e.message}`);
    bad(res, 502, e.message);
  }
});
const snapTimers = new Map();
function snapshotLater(chatId) {
  if (h.setting('pref_snapshot') === '0') return;
  const c = h.get('SELECT project_id FROM chats WHERE id=?', chatId);
  if (!c) return;
  clearTimeout(snapTimers.get(c.project_id));
  snapTimers.set(c.project_id, setTimeout(() => {
    snapTimers.delete(c.project_id);
    snapshotNow(c.project_id).catch(() => { });
  }, 30000).unref());
}
async function snapshotNow(projectId) {
  const pr = h.get('SELECT * FROM projects WHERE id=?', projectId);
  if (!pr) return { skipped: 'нет проекта' };
  try {
    const r = await snapshotProject(h, pr);
    if (r.written) h.log('info', 'snapshot', `${pr.name}: обновлено файлов ${r.written}`);
    return r;
  } catch (e) { h.log('warn', 'snapshot', `${pr.name}: ${e.message}`); return { error: e.message }; }
}
route('POST', '/api/projects/:id/snapshot', async (req, res, p) => ok(res, await snapshotNow(+p.id)));

const AUTH_FILES = {
  claude: ['.claude/.credentials.json'],
  codex: ['.codex/auth.json'],
  gemini: ['.gemini/oauth_creds.json'],
  kimi: [],
};
const authSig = provider => {
  const flag = provider === 'kimi' ? accounts.kimiSignature() : provider === 'gemini' ? String(companion.ready('gemini')) : '';
  const files = (AUTH_FILES[provider] ?? []).map(rel => {
    try { const st = fs.statSync(path.join(os.homedir(), rel)); return `${st.size}:${Math.round(st.mtimeMs)}`; }
    catch { return '-'; }
  }).join('|');
  return `${flag}#${files}`;
};

const linker = new Linker({
  log: (lvl, scope, text) => h.log(lvl, scope, text),
  emit: (t, d) => { hub.send(t, d); if (t === 'link' && d.status === 'done') hub.send('models', catalogAll()); },
  authSig,
});
route('GET', '/api/link/:provider', (req, res, p) => ok(res, linker.state(p.provider)));
route('POST', '/api/link/:provider/start', (req, res, p) => {
  try { ok(res, linker.start(p.provider)); } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/link/:provider/send', async (req, res, p) => {
  const b = await body(req);
  try { ok(res, b.key ? linker.key(p.provider, b.key) : linker.send(p.provider, b.text ?? '', { enter: b.enter !== false })); }
  catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/link/:provider/cancel', (req, res, p) => ok(res, linker.cancel(p.provider)));
route('POST', '/api/link/:provider/callback', async (req, res, p) => {
  const { url = '' } = await body(req);
  try { ok(res, await linker.callback(p.provider, url)); } catch (e) { bad(res, 400, e.message); }
});

route('GET', '/api/settings', (req, res) => ok(res, { prefs: prefs(), defaults: DEFAULTS }));
route('POST', '/api/settings', async (req, res) => {
  const b = await body(req);
  for (const k of Object.keys(DEFAULTS)) if (b[k] !== undefined) h.setting('pref_' + k, String(b[k] ?? ''));
  hub.send('prefs', { prefs: prefs() });
  ok(res, { prefs: prefs() });
});

route('GET', '/api/board', (req, res) => ok(res, { items: boardItems() }));

route('POST', '/api/projects/:id/archive-old', async (req, res, p) => {
  const { days = 7 } = await body(req);
  const cut = Date.now() - Math.max(1, +days) * 864e5;
  const r = h.run(`UPDATE chats SET archived=1 WHERE project_id=? AND archived=0 AND updated_at<? AND state NOT IN ('running','attention') AND pinned=0`, +p.id, cut);
  hub.send('reload', {});
  ok(res, { archived: Number(r.changes) });
});

route('GET', '/api/voice/status', async (req, res) => ok(res, await voice.status()));
route('POST', '/api/voice/start', async (req, res) => { try { ok(res, await voice.start()); } catch (e) { bad(res, 503, e.message); } });
route('POST', '/api/voice/feed', async (req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  try { ok(res, await voice.feed(id, await rawBody(req, 8 << 20))); } catch (e) { bad(res, 503, e.message); }
});
route('POST', '/api/voice/stop', async (req, res) => {
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  try { ok(res, await voice.stop(id, await rawBody(req, 8 << 20))); } catch (e) { bad(res, 503, e.message); }
});
route('POST', '/api/voice/transcribe', async (req, res) => {
  const audio = await rawBody(req);
  if (!audio.length) return bad(res, 400, 'Пустая запись.');
  try {
    const r = await voice.transcribe(audio);
    ok(res, r);
  } catch (e) { bad(res, 503, e.message); }
});

route('GET', '/api/telegram', (req, res) => ok(res, tg.config()));
route('POST', '/api/telegram', async (req, res) => {
  const b = await body(req);
  const cfg = tg.setConfig(b);
  ok(res, cfg);
});
route('POST', '/api/telegram/test', async (req, res) => {
  const who = await tg.whoami();
  if (!who.ok) return bad(res, 400, who.error);
  const r = await tg.send(`<b>Depo</b> на связи. Бот @${who.username}, хост ${os.hostname()}.`, { force: true });
  r.ok ? ok(res, { ok: true, username: who.username }) : bad(res, 400, r.error);
});
route('POST', '/api/telegram/detect', async (req, res) => {
  const r = await tg.lastChat();
  r.ok ? ok(res, r) : bad(res, 400, r.error);
});

route('GET', '/api/backup', (req, res) => {
  let last = null;
  try { last = JSON.parse(h.setting('last_backup') || 'null'); } catch { }
  ok(res, { last });
});
route('POST', '/api/backup', async (req, res) => {
  const { execFile } = await import('node:child_process');
  const out = await new Promise(resolve =>
    execFile(process.execPath, [path.join(ROOT, 'scripts', 'backup.mjs')],
      { env: process.env, timeout: 600000, maxBuffer: 1 << 22 },
      (err, so, se) => resolve({ err, so, se })));
  let last = null;
  try { last = JSON.parse(h.setting('last_backup') || 'null'); } catch { }
  if (last?.ok) ok(res, last);
  else bad(res, 500, last?.error || (out.se || out.err?.message || 'Бэкап не прошёл.'));
});

route('GET', '/api/log', (req, res) =>
  ok(res, { items: h.all('SELECT * FROM log ORDER BY id DESC LIMIT 200') }));

route('GET', '/health', (req, res) => ok(res, { ok: true, version: VERSION, running: runner.activeChats().length }), true);

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9а-я]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  try {
    const m = routes.find(r => r.method === req.method && r.rx.test(pathname));
    if (m) {
      const session = auth.readSession(h, req);
      if (!m.open && !session) return bad(res, 401, 'Нужен вход.');
      const vals = pathname.match(m.rx).slice(1);
      const params = Object.fromEntries(m.keys.map((k, i) => [k, vals[i]]));
      return await m.handler(req, res, params, session);
    }
    if (pathname.startsWith('/api/')) return bad(res, 404, 'Нет такого метода.');

    if (req.method !== 'GET') return bad(res, 405, 'Метод не поддерживается.');
    const session = auth.readSession(h, req);
    if (pathname === '/' || pathname === '/index.html') {
      return void await serveFile(res, path.join(PUB, session ? 'app.html' : 'login.html'), { store: false });
    }
    if (pathname === '/ca.crt') {
      try {
        const pem = await fsp.readFile(path.join(TLS, 'ca.crt'));
        res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="depo-ca.crt"' });
        return res.end(pem);
      } catch { return bad(res, 404, 'Сертификата нет. Запусти scripts/make-cert.sh.'); }
    }
    if (pathname === '/login') {
      if (session) { res.writeHead(302, { location: '/' }); return res.end(); }
      return void await serveFile(res, path.join(PUB, 'login.html'), { store: false });
    }
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUB, safe);
    if (!file.startsWith(PUB)) return bad(res, 403, 'Нельзя.');
    const isPublic = /^\/(icons|manifest\.webmanifest|login\.|app\.css|boot\.js|sw\.js)/.test(safe);
    if (!session && !isPublic) { res.writeHead(302, { location: '/login' }); return res.end(); }
    if (await serveFile(res, file)) return;
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    h.log('error', 'http', `${req.method} ${pathname}: ${e.stack || e.message}`);
    if (!res.headersSent) bad(res, 500, e.message || 'Внутренняя ошибка.');
    else try { res.end(); } catch { }
  }
};
const server = http.createServer(handler);
server.headersTimeout = 0; server.requestTimeout = 0;
server.listen(PORT, HOST, () => {
  h.log('info', 'server', `Depo ${VERSION} слушает ${HOST}:${PORT}, данные в ${DATA}`);
  console.log(`Depo ${VERSION} → http://${HOST}:${PORT}  (данные: ${DATA})`);
});
let tls = null;
try {
  tls = https.createServer({ key: fs.readFileSync(path.join(TLS, 'server.key')), cert: fs.readFileSync(path.join(TLS, 'server.crt')) }, handler);
  tls.headersTimeout = 0; tls.requestTimeout = 0;
  tls.listen(HTTPS_PORT, HOST, () => { h.log('info', 'server', `https на ${HOST}:${HTTPS_PORT}`); console.log(`Depo → https://${HOST}:${HTTPS_PORT}`); });
} catch (e) { h.log('warn', 'server', `https не поднят: ${e.message} — запусти scripts/make-cert.sh`); }

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  h.log('info', 'server', `остановка по ${sig}`);
  for (const id of runner.activeChats()) runner.cancel(id);
  server.close(() => process.exit(0)); tls?.close();
  setTimeout(() => process.exit(0), 3000);
});
process.on('unhandledRejection', e => h.log('error', 'server', `необработанный отказ: ${e?.stack || e}`));
