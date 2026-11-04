// Depo — свой хаб для Claude Code и Codex. Запускается на малине, смотрит в netbird.
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
import { Runner, runInfo } from './lib/runner.mjs';
import { Meters, chatContext, dropChatContext } from './lib/usage.mjs';
import { readKimiUsage } from './lib/kimi-meta.mjs';
import * as P from './lib/projects.mjs';
import * as handoff from './lib/handoff.mjs';
import * as files from './lib/files.mjs';
import * as voice from './lib/voice.mjs';
import { Telegram } from './lib/telegram.mjs';
import * as sessions from './lib/sessions.mjs';
import { serverStats } from './lib/sysinfo.mjs';
import * as push from './lib/push.mjs';
import { catalog, kimiCatalog, refreshKimiCatalog, invalidate as invalidateModels } from './lib/models.mjs';
import * as cliUpdate from './lib/cli-update.mjs';
import * as codexMeta from './lib/codex-meta.mjs';
import * as accounts from './lib/accounts.mjs';
import { Linker } from './lib/link.mjs';
import { snapshotProject } from './lib/snapshot.mjs';
import * as companion from './lib/companion.mjs';
import * as gptVoice from './lib/chatgpt-voice.mjs';
import * as housekeeping from './lib/housekeeping.mjs';
import * as remote from './lib/remote.mjs';
import * as tlscert from './lib/tlscert.mjs';
import * as twofa from './lib/twofa.mjs';
import * as assistant from './lib/assistant.mjs';
import * as team from './lib/team.mjs';
import * as queue from './lib/queue.mjs';
import * as memory from './lib/memory.mjs';
import * as safety from './lib/safety.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DEPO_DATA_DIR || path.join(ROOT, 'data');
gptVoice.configure({ dataDir: DATA });
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
  // Перезапуск из телеграма: тот же путь, что и остановка по SIGTERM, а поднимает службу systemd (Restart=always).
  // Без systemd (INVOCATION_ID нет — запущен руками) поднять некому — честно отказываем.
  restart: () => {
    if (!process.env.INVOCATION_ID) return { ok: false, error: 'Depo запущен не как служба systemd — после остановки поднять его будет некому. Перезапусти вручную.' };
    setTimeout(() => shutdown('перезапуск из телеграма', 1), 1500);   // дать боту ответить
    return { ok: true };
  },
  // «Это не я» под кодом входа: код аннулируем, удалённый доступ выключаем
  denyLogin: ticket => {
    const t = twofa.pending(ticket); twofa.kill(ticket);
    const cur = remote.get(h);
    if (cur.enabled) remote.set(h, { enabled: false });
    h.log('warn', 'auth', `попытка входа отклонена из телеграма${t ? ` (${t.ip})` : ''}; удалённый доступ ${cur.enabled ? 'выключен' : 'и так выключен'}`);
    return { ip: t?.ip ?? null, was: cur.enabled };
  },
  // удалённый доступ через проводник: посмотреть и включить/выключить прямо из бота
  remote: {
    get: () => remote.get(h),
    set: on => {
      const v = remote.set(h, { enabled: !!on });
      if (on) remote.loginOk(h);   // включили осознанно — счётчик неверных паролей с нуля
      h.log('info', 'remote', `удалённый доступ ${on ? 'включён' : 'выключен'} из телеграма`);
      return v;
    },
  },
  send: async (chatId, text) => {
    const c = h.get('SELECT * FROM chats WHERE id=?', chatId);
    if (!c) return { ok: false, error: 'чат не найден' };
    const pr = h.get('SELECT * FROM projects WHERE id=?', c.project_id);
    if (!pr || !fs.existsSync(pr.path)) return { ok: false, error: 'папка проекта недоступна' };
    if (runner.isRunning(chatId)) return { ok: true, ...steerOrQueue(c, text, [], 'now') };
    if (cliUpdating(c.provider)) { queue.enqueue(h, chatId, text); queueEmit(chatId); return { ok: true, queued: true }; }   // уйдёт после обновления
    try { runner.start({ ...c, cwd: pr.path }, text); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
});
const APPROVAL_TOKEN = crypto.randomBytes(24).toString('base64url');

// ─────────────────────────── запросы разрешений ───────────────────────────
// MCP-процесс (lib/approve-mcp.mjs) спрашивает сюда, интерфейс отвечает кнопками.
const approvals = new Map();   // id -> {chat_id, tool_name, input, decided, allow, message, waiters:[], at}
function newApproval({ chat_id, tool_name, input, tool_use_id }) {
  const id = crypto.randomUUID();
  const a = { id, chat_id, tool_name, input, tool_use_id, decided: false, allow: false, message: null, waiters: [], at: Date.now() };
  approvals.set(id, a);
  h.run("UPDATE chats SET state='attention' WHERE id=? AND state='running'", chat_id);
  runner.setWaiting(chat_id, true);
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
  if (runner.isRunning(a.chat_id)) { runner.setWaiting(a.chat_id, false); h.run("UPDATE chats SET state='running' WHERE id=?", a.chat_id); hub.send('chat', { patch: { state: 'running' }, chat_id: a.chat_id }); }
  setTimeout(() => approvals.delete(id), 60e3).unref();
  return a;
}
const summarizeInput = (tool, i) => String(i?.command || i?.file_path || i?.path || i?.pattern || i?.url || JSON.stringify(i ?? {})).slice(0, 160);
const pendingFor = chatId => [...approvals.values()].filter(a => !a.decided && a.chat_id === chatId)
  .map(a => ({ id: a.id, chat_id: a.chat_id, tool_name: a.tool_name, input: a.input, at: a.at }));

// Короткий текст для web push — без разметки и без содержимого чатов, только факт события.
// Тревога безопасности уходит всегда: в Телеграм (если бот подключён) и пушем, мимо тишины и фильтров событий.
const rcfgDomain = () => remote.get(h).domain || remote.get(h).relay_ip || 'проводник';
function securityAlert(text) {
  try { push.broadcast(h, { kind: 'security', title: 'Depo', body: text.replace(/<[^>]+>/g, ''), chat: null }); } catch { }
  if (tg.on) tg.send(text, { force: true, keyboard: true }).catch?.(() => { });
}
function pushText(kind, d) {
  if (kind === 'error') return `⚠️ ${d.project} · ${d.title} — ход упал`;
  if (kind === 'done_long') return `✅ ${d.project} · ${d.title} — готово за ${Math.round(d.secs / 60)} мин`;
  if (kind === 'limit') return `📊 ${d.label} — израсходовано ${d.pct}%`;
  if (kind === 'attention') return `❓ ${d.project} · ${d.title} — нужен твой ответ`;
  if (kind === 'deploy_blocked') return `⛔ ${d.project} — публикация остановлена`;
  if (kind === 'rollback') return `↩️ ${d.project} — выполнен откат после неудачного релиза`;
  if (kind === 'service') return `🔁 ${d.text}`;
  return null;
}

// Что уходит в телеграм. Текст короткий: это уведомление, а не отчёт.
function notify(kind, d) {
  // шаги команды не спамят «готово» — уведомление придёт одно, когда закончит вся команда
  if (kind === 'done_long' && d?.chat_id && h.get(`SELECT 1 FROM team_tasks WHERE chat_id=? AND status IN ('planning','await','running')`, d.chat_id)) return;
  const pt = pushText(kind, d);
  if (pt) push.broadcast(h, { kind, title: 'Depo', body: pt, chat: d.chat_id || null });
  if (!tg.wants(kind)) return;
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let text;
  if (kind === 'error') text = `⚠️ <b>${esc(d.project)}</b> · ${esc(d.title)}\nход упал: ${esc((d.text || '').slice(0, 300))}`;
  else if (kind === 'done_long') text = `✅ <b>${esc(d.project)}</b> · ${esc(d.title)}\nход закончен за ${Math.round(d.secs / 60)} мин${d.cost ? ` · $${d.cost.toFixed(3)}` : ''}${d.answer ? '\n\n' + esc(d.answer.slice(0, 600)) : ''}`;
  else if (kind === 'limit') text = `📊 ${esc(d.label)} — ${d.pct}% израсходовано, сброс ${esc(d.resets)}`;
  else if (kind === 'attention') text = `❓ <b>${esc(d.project)}</b> · ${esc(d.title)}\n${esc(d.text || 'нужен твой ответ')}`;
  else if (kind === 'service') text = `🔁 Depo: ${esc(d.text)}`;
  else if (kind === 'deploy_blocked') text = `⛔ <b>${esc(d.project)}</b>: публикация остановлена\n${esc(d.text)}`;
  else if (kind === 'rollback') text = `↩️ <b>${esc(d.project)}</b>: ${esc(d.text || 'выполнен откат после неудачного релиза')}`;
  else return;
  const buttons = d.chat_id ? [[{ text: '💬 Показать ход', callback_data: `open:${d.chat_id}` }, { text: '✍️ Ответить', callback_data: `chat:${d.chat_id}` }]] : undefined;
  tg.send(text, { buttons }).then(r => { if (!r.ok && !r.skipped) h.log('warn', 'telegram', r.error); });
}

// Kimi ждёт своего CLI с входом по браузеру — ключи API мы нигде не используем.
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

const queueEmit = chatId => hub.send('queue', { chat_id: chatId, items: queue.pending(h, chatId) });

// ─────────────── команда агентов ───────────────
// Задача → ведущий планирует (только чтение) → шаги по ролям по очереди, с передачей контекста → итог.
const TEAM_LIVE = "('planning','await','running')";
const teamGet = id => { const t = h.get('SELECT * FROM team_tasks WHERE id=?', +id); return t && { ...t, steps: JSON.parse(t.steps || '[]') }; };
const teamActive = chatId => { const t = h.get(`SELECT id FROM team_tasks WHERE chat_id=? AND status IN ${TEAM_LIVE} ORDER BY id DESC LIMIT 1`, chatId); return t ? teamGet(t.id) : null; };
const AGNAME = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
function teamSave(t, patch = {}) {
  Object.assign(t, patch, { updated_at: Date.now() });
  h.run('UPDATE team_tasks SET status=?,steps=?,step=?,retries=?,msg_id=?,error=?,updated_at=? WHERE id=?',
    t.status, JSON.stringify(t.steps), t.step, t.retries, t.msg_id ?? null, t.error ?? null, t.updated_at, t.id);
  // карточка плана в ленте — одна на задачу, обновляется на месте
  const json = { task_id: t.id, status: t.status, steps: t.steps, step: t.step, error: t.error ?? null, task: t.task.slice(0, 300) };
  if (!t.msg_id) {
    const m = runner.save(t.chat_id, null, 'system', 'team_plan', 'Команда агентов', json);
    t.msg_id = m.id; h.run('UPDATE team_tasks SET msg_id=? WHERE id=?', m.id, t.id);
  } else {
    h.run('UPDATE messages SET json=? WHERE id=?', JSON.stringify(json), t.msg_id);
    hub.send('message-patch', { chat_id: t.chat_id, id: t.msg_id, json });
  }
  return t;
}
// Кто выполняет роль: выключенных из команды и без входа пропускаем (team.assignee),
// затем подмена при лимите > 90% — тоже только среди включённых. why: 'off' | 'ready' | 'limit'.
function teamPick(cfg, roleId) {
  const r = team.role(cfg, roleId);
  const ok = pv => accounts.ready(pv) && !cliUpdating(pv);
  const tired = pv => cfg.fallback && (meters.snapshot(pv)?.limits ?? []).some(l => l.pct >= 90);
  const a = team.assignee(cfg, r, ok);
  if (!a) throw new Error(`Нет доступного агента для роли «${r.name}»: все агенты команды выключены или без входа.`);
  const pick = { ...r, provider: a.provider, model: a.model, effort: a.effort, fallback: a.instead, why: a.reason };
  if (!tired(a.provider)) return pick;
  const alt = [team.role(cfg, 'lead'), ...cfg.roles].find(x => x.provider !== a.provider && !cfg.off.includes(x.provider) && ok(x.provider) && !tired(x.provider));
  if (alt) return { ...r, provider: alt.provider, model: alt.model, effort: alt.effort, fallback: a.instead ?? r.provider, why: 'limit' };
  return pick;   // устали все — работает тот, кто назначен
}
// Контекст прошлого агента (если он другой) + задание шага
function teamPrompt(c, pr, provider, body2) {
  const last = handoff.lastAgent(h, c.id);
  if (last && last !== provider) {
    const ho = handoff.build(h, { ...c, cwd: pr.path }, last, provider);
    if (ho) return ho.text + '\n\n## Задание\n' + body2;
  }
  return body2;
}
function teamStart(c, pr, msg, atts) {
  const cfg = team.config(h);
  for (const old of h.all(`SELECT id FROM team_tasks WHERE chat_id=? AND status='await'`, c.id))   // новый запрос вместо неутверждённого плана
    teamSave(teamGet(old.id), { status: 'stopped', error: 'Заменён новой задачей.' });
  const lead = teamPick(cfg, 'lead');
  const t0 = Date.now();
  const r = h.run('INSERT INTO team_tasks(chat_id,task,status,steps,step,attachments,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    c.id, msg || '(вложения)', 'planning', '[]', -1, JSON.stringify(atts || []), t0, t0);
  const t = teamGet(Number(r.lastInsertRowid));
  const runId = runner.start({ ...c, cwd: pr.path, provider: lead.provider, model: lead.model || null, effort: lead.effort, permission_mode: 'plan' },
    msg || '(вложения)', teamPrompt(c, pr, lead.provider, team.planPrompt(cfg, msg || 'Посмотри вложения.')), atts || []);
  teamSave(t, { steps: [{ role: 'lead', title: 'Составить план', status: 'run', provider: lead.provider, fallback: lead.fallback, why: lead.why, planning: true, started_at: t0 }] });
  h.log('info', 'team', `${c.id}: задача командой, план — ${AGNAME[lead.provider]}`);
  return runId;
}
function teamStep(id) {
  const t = teamGet(id);
  if (!t || t.status !== 'running') return;
  const c = h.get('SELECT * FROM chats WHERE id=?', t.chat_id), pr = c && h.get('SELECT * FROM projects WHERE id=?', c.project_id);
  if (!c || !pr) return teamSave(t, { status: 'error', error: 'Чат или проект не найден.' });
  if (runner.isRunning(c.id)) return setTimeout(() => teamStep(id), 2000);
  const cfg = team.config(h), i = t.step + 1, st = t.steps[i];
  if (!st) return teamFinish(t);
  try {
    const pick = teamPick(cfg, st.role);
    Object.assign(st, { status: 'run', provider: pick.provider, fallback: pick.fallback, why: pick.why, started_at: Date.now() });
    teamSave(t, { step: i });
    const runId = runner.start({ ...c, cwd: pr.path, provider: pick.provider, model: pick.model || null, effort: pick.effort },
      null, teamPrompt(c, pr, pick.provider, team.stepPrompt(cfg, { task: t.task, steps: t.steps, i })), i === 0 ? JSON.parse(t.attachments || '[]') : []);
    st.run_id = runId; teamSave(t);
  } catch (e) {
    st.status = 'failed';
    teamSave(t, { status: 'error', error: e.message });
    runner.save(c.id, null, 'error', 'notice', `Команда остановлена: ${e.message}`);
  }
}
function teamFinish(t) {
  teamSave(t, { status: 'done' });
  const c = h.get('SELECT title, project_id FROM chats WHERE id=?', t.chat_id);
  notify('done_long', { chat_id: t.chat_id, title: c?.title ?? 'чат', project: h.get('SELECT name FROM projects WHERE id=?', c?.project_id)?.name ?? '', secs: Math.round((Date.now() - t.created_at) / 1000), cost: 0, answer: 'Команда закончила задачу.' });
  setImmediate(() => startQueued(t.chat_id));
}
// Ход закончился: если это шаг команды — двигаем конвейер. true — команда продолжает (очередь чата ждёт).
// Уроки в .depo/memory/LESSONS.md проекта этого чата — их увидят все агенты (AGENTS.md, CLAUDE.md, передача)
function saveLessons(chatId, lines, who) {
  if (!lines.length) return;
  const pr = h.get('SELECT p.id, p.name, p.path FROM projects p JOIN chats c ON c.project_id=p.id WHERE c.id=?', chatId);
  if (!pr) return;
  try {
    const n = memory.addLessons(pr, lines, who);
    if (n) runner.save(chatId, null, 'system', 'notice', `Запомнил в уроках проекта: ${lines.slice(0, n).join('; ')}`);
  } catch (e) { h.log('warn', 'memory', e.message); }
}
function teamOnRunEnd(chatId, runId) {
  const t = teamActive(chatId);
  if (!t || t.status === 'await') return !!t;
  const run = h.get('SELECT status, provider FROM runs WHERE id=?', runId);
  const last = h.get("SELECT text FROM messages WHERE run_id=? AND role='assistant' AND kind='text' ORDER BY id DESC LIMIT 1", runId)?.text || '';
  const cur = t.steps[t.status === 'planning' ? 0 : t.step];
  if (cur && cur.run_id && cur.run_id !== runId && !cur.planning) return true;   // чужой ход (например, уточнение) — не наш шаг
  if (run?.status === 'cancelled') { if (cur) cur.status = 'failed'; teamSave(t, { status: 'stopped', error: 'Остановлено владельцем.' }); return false; }
  if (run?.status === 'error') { if (cur) cur.status = 'failed'; teamSave(t, { status: 'error', error: 'Ход агента упал — команда остановилась. Поправь и отправь задачу снова.' }); return false; }
  const cfg = team.config(h);
  if (t.status === 'planning') {
    const steps = team.parsePlan(last, cfg);
    if (!steps) { teamSave(t, { status: 'error', error: 'Ведущий не прислал план в нужном виде — попробуй сформулировать задачу иначе.', steps: [] }); return false; }
    teamSave(t, { status: cfg.approve ? 'await' : 'running', steps, step: -1 });
    if (cfg.approve) { notify('attention', { chat_id: chatId, title: 'План команды готов', project: '', text: 'утверди план, чтобы агенты начали' }); return true; }
    setImmediate(() => teamStep(t.id));
    return true;
  }
  if (cur) Object.assign(cur, { status: 'done', ended_at: Date.now(), summary: last.replace(/\s+/g, ' ').slice(0, 280) });
  if (cur && team.isFinalReview(t.steps, t.step)) saveLessons(chatId, memory.parseLessons(last), 'команда');
  if (cur && team.testStep(cfg, cur.role)) {
    const v = team.verdict(last); cur.verdict = v;
    if (v === false) {
      if (t.retries < cfg.retries) { cur.status = 'failed'; t.steps = team.withFix(cfg, t.steps, t.step, last); t.retries++; }
      else { cur.status = 'failed'; teamSave(t, { status: 'error', error: `Проверка не прошла и после ${cfg.retries} исправлений — нужен твой взгляд.` }); return false; }
    }
  }
  if (t.step + 1 >= t.steps.length) { teamFinish(t); return true; }
  teamSave(t);
  setImmediate(() => teamStep(t.id));
  return true;
}
// после перезапуска Depo живые задачи команды не продолжаем вслепую
for (const r of h.all(`SELECT id FROM team_tasks WHERE status IN ('planning','running')`)) {
  const t = teamGet(r.id); t.status = 'stopped'; t.error = 'Depo перезапустился во время задачи — отправь её снова или продолжи вручную.';
  h.run('UPDATE team_tasks SET status=?, error=? WHERE id=?', t.status, t.error, t.id);
}

// Уточнение во время хода. «Сейчас» — только туда, где CLI реально читает ввод на ходу (Claude stream-json),
// и только пока его stdin открыт. Всё остальное честно уходит в постоянную очередь «после задачи»:
// сообщение не теряется и не выдаётся за доставленное.
function steerOrQueue(c, msg, atts, mode) {
  if (mode !== 'after' && queue.canSteer(c.provider) && runner.canWrite(c.id)) {
    const m = runner.save(c.id, null, 'user', 'text', msg, { steer: 'sent', ...(atts.length ? { attachments: atts } : {}) });
    if (runner.write(c.id, msg, atts.filter(a => a.image), { msgId: m.id })) return { steered: true, message_id: m.id };
    runner.steerStatus(c.id, m.id, 'requeued');
  }
  const item = queue.enqueue(h, c.id, msg, atts);
  queueEmit(c.id);
  const fallback = mode === 'after' ? null : queue.canSteer(c.provider) ? 'closed' : 'nosteer';
  return { queued: true, item, fallback,
    reason: fallback === 'nosteer' ? `${handoff.nameOf(c.provider)} не принимает уточнения посреди хода — сообщение уйдёт следующим ходом.`
      : fallback === 'closed' ? 'Агент уже завершает ход — сообщение уйдёт следующим ходом.' : null };
}
function startQueued(chatId) {
  if (runner.isRunning(chatId)) return;
  const item = queue.claimNext(h, chatId);
  if (!item) return;
  const c = h.get('SELECT * FROM chats WHERE id=?', chatId);
  const pr = c && h.get('SELECT * FROM projects WHERE id=?', c.project_id);
  try {
    if (!c || !pr || !fs.existsSync(pr.path)) throw new Error('Папка проекта недоступна.');
    if (!accounts.ready(c.provider)) throw new Error(`${handoff.nameOf(c.provider)} отключён.`);
    if (cliUpdating(c.provider)) { queue.fail(h, item.id, cliUpdating(c.provider)); return queueEmit(chatId); }
    let prompt = item.text || 'Посмотри вложения.';
    const last = handoff.lastAgent(h, chatId);
    if (last && last !== c.provider) {
      const ho = handoff.build(h, { ...c, cwd: pr.path }, last, c.provider);
      if (ho) prompt = ho.text + '\n\n## Сообщение из очереди\n' + prompt;
    }
    const runId = runner.start({ ...c, cwd: pr.path }, item.text || '(вложения)', prompt, item.attachments);
    queue.complete(h, item.id, runId);
  } catch (e) {
    queue.fail(h, item.id, e.message);
    h.log('warn', 'queue', `${chatId}: ${e.message}`);
  }
  queueEmit(chatId);
}

const runner = new Runner({ h, hub, env: process.env, notify, root: ROOT,
  approvalEnv: chatId => ({ DEPO_URL: `http://127.0.0.1:${PORT}`, DEPO_TOKEN: APPROVAL_TOKEN, DEPO_CHAT: chatId }),
  onRateLimit: info => meters.fromEvent(info),
  quotaSnapshot: provider => meters.snapshot(provider),
  onUndelivered: (chatId, texts) => {
    for (const t of texts) queue.enqueue(h, chatId, t);
    runner.save(chatId, null, 'system', 'notice', `Агент не успел забрать ${texts.length === 1 ? 'уточнение' : 'уточнения'} до конца хода — ${texts.length === 1 ? 'оно уйдёт' : 'они уйдут'} следующим ходом.`);
    queueEmit(chatId);
  },
  onRunEnd: (chatId, runId) => {
    dropChatContext(chatId);
    const rr = h.get('SELECT provider, status, error FROM runs WHERE id=?', runId);
    if (rr && rr.status !== 'cancelled') cliUpd.reportRun(rr.provider, { ok: rr.status === 'done', error: rr.error || '' })
      .then(r => { if (r?.rolled) notify('error', { chat_id: chatId, title: 'Обновление откатено', project: '', text: `${cliUpdate.AGENTS[rr.provider].name} ${r.from} ломал ходы — Depo вернул ${r.to}.`, secs: 0 }); })
      .catch(e => h.log('warn', 'cli-update', e.message));
    for (const a of approvals.values()) if (!a.decided && a.chat_id === chatId) decide(a.id, false, 'Ход закончился.');
    snapshotLater(chatId);
    setImmediate(() => {
      try { memory.recordRun(h, runId); } catch (e) { h.log('warn', 'memory', e.message); }
      let busy = false;
      try { busy = teamOnRunEnd(chatId, runId); } catch (e) { h.log('error', 'team', e.message); }
      if (!busy) startQueued(chatId);   // пока команда работает, очередь чата ждёт её конца
    });
  },
});
const meters = new Meters({ h, hub, home: os.homedir(), notify, codexReady: () => accounts.ready('codex') && !process.env.DEPO_NO_CODEX_LIMITS });

// Обновления AI CLI. Занят — значит, у этого агента идёт ход в Depo; пока ставится новая версия,
// новые ходы этого агента не стартуют, а очередь дожидается конца обновления.
// Само расписание живёт только в боевом Depo: тестовые стенды (свой DEPO_DATA_DIR) системные CLI не трогают.
const CLI_AUTO = process.env.DEPO_CLI_AUTOUPDATE ? process.env.DEPO_CLI_AUTOUPDATE === '1'
  : !process.env.DEPO_DATA_DIR || path.resolve(process.env.DEPO_DATA_DIR) === path.join(ROOT, 'data');
let cliBusyPrev = null;
const cliUpd = cliUpdate.createManager({
  h,
  ctx: { backupDir: path.join(DATA, 'cli-backups') },
  isBusy: id => {
    const c = runner.activeChats().map(cid => h.get('SELECT title, provider FROM chats WHERE id=?', cid)).find(x => x?.provider === id);
    return c ? `${cliUpdate.AGENTS[id].name} выполняет задачу в чате «${c.title}»` : '';
  },
  authOk: id => accounts.ready(id),
  onUpdated: async id => { invalidateModels(); if (id === 'codex') gptVoice.forget(); if (id === 'kimi') await refreshKimiCatalog().catch(() => { }); hub.send('models', {}); },
  onChange: st => {
    hub.send('cliupd', st);
    if (cliBusyPrev && !st.busy)                // обновление закончилось — отпускаем очередь этого агента
      for (const r of h.all("SELECT DISTINCT chat_id FROM queued_messages WHERE status='pending'")) startQueued(r.chat_id);
    cliBusyPrev = st.busy;
  },
});
if (CLI_AUTO) cliUpd.start();
housekeeping.start(h, { log: t => h.log('info', 'storage', t) });
const cliUpdating = provider => cliUpd.isUpdating(provider) ? `${handoff.nameOf(provider)} сейчас обновляется — через пару минут можно продолжить.` : '';

// Пустые чаты (кнопка «Новый чат» без единого сообщения) не должны копиться
const dropEmpty = () => Number(h.run(
  `DELETE FROM chats WHERE turns=0 AND origin='depo' AND id NOT IN (SELECT DISTINCT chat_id FROM messages)
     AND created_at < ?`, Date.now() - 10 * 60e3).changes);
const droppedAtBoot = dropEmpty();
if (droppedAtBoot) h.log('info', 'chats', `убрано пустых чатов: ${droppedAtBoot}`);
setInterval(() => { const n = dropEmpty(); if (n) hub.send('reload', {}); }, 10 * 60e3).unref();

const interrupted = runner.reconcile();
const restoredQueue = queue.restore(h);
if (restoredQueue) h.log('info', 'queue', `после перезапуска восстановлено сообщений: ${restoredQueue}`);
if (interrupted) notify('service', { text: `перезапуск прервал ${interrupted} ход(ов), они помечены в чатах` });
meters.startLoop();
refreshKimiCatalog().then(() => hub.send('models', catalogAll())).catch(() => { });
tg.restartPolling();
tg.restarted().catch(() => { });

// ─────────────────────────── утилиты ответа ───────────────────────────
const json = (res, code, body) => {
  const s = JSON.stringify(body ?? null);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
};
const ok = (res, body) => json(res, 200, body ?? { ok: true });
const bad = (res, code, error) => json(res, code, { error });
const blank = res => { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(''); };

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
// Страница входа для тех, кто пришёл снаружи: без имени машины, без упоминаний NetBird и сертификатов.
async function serveStatic(res, file) {
  try { const data = await fsp.readFile(file); res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(data); }
  catch { blank(res); }
}
async function serveLoginOutside(res) {
  let html = await fsp.readFile(path.join(PUB, 'login.html'), 'utf8');
  html = html.replace(/<title>[^<]*<\/title>/, '<title>Вход</title>').replace('<b>Depo</b>', '<b>Вход</b>')
    .replace(/<span id="host">[^<]*<\/span>/, '<span id="host"></span>')
    .replace(/<p class="foot"[^]*?<\/p>\s*/g, '')
    .replace("document.getElementById('host').textContent = location.hostname;", '')
    .replace(/if \(location\.protocol === 'http:'\) \{[^]*?\n\}\n/, '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}
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

// значок проекта: до двух символов, эмодзи не рвём пополам (графемы, а не UTF-16)
const glyphClean = v => [...new Intl.Segmenter('ru', { granularity: 'grapheme' }).segment(String(v || '').trim())].slice(0, 2).map(x => x.segment).join('').toUpperCase();
const ipOf = req => remote.clientIp(remote.get(h), req);   // за проводником — настоящий адрес клиента

// ─────────────────────────── представление данных ───────────────────────────
const projectDTO = p => ({ ...p, short: P.shorten(p.path), archived: !!p.archived });
// Окно модели Claude Code в файл сессии не пишет. Зато оно приходит в ответе
// на наши собственные ходы — запоминаем по модели и применяем к зеркальным чатам.
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
  // Контекст принадлежит паре «чат + агент»: берём последний ход именно этого агента
  const last = h.get(
    'SELECT ctx_used, ctx_window FROM runs WHERE chat_id=? AND provider=? AND ctx_used>0 ORDER BY id DESC LIMIT 1',
    c.id, c.provider);
  let used = last?.ctx_used ?? 0, win = last?.ctx_window ?? 0, exact = !!last;

  if (c.provider === 'codex') {
    // и контекст, и окно берём из файла сессии Codex — зашитое окно врало
    const live = c.codex_thread ? codexMeta.contextFor(c.codex_thread) : null;
    if (live) { used = live.used; win = live.window || win || 400000; exact = true; }
    else win = win || 400000;
  } else if (c.provider === 'kimi') {
    used = used || c.ctx_used || 0;
    const model = kimiModels().items.find(m => m.id === (c.model || ''));
    win = win || c.ctx_window || model?.contextWindow || 0;
    exact = !!used;
  } else if (!used && c.origin === 'claude') {
    // чат подобран из Claude Code: вес промпта читаем из его файла сессии,
    // а окно модели неизвестно, пока он не пройдёт хотя бы один ход через Depo
    const pr = h.get('SELECT path FROM projects WHERE id=?', c.project_id);
    used = (pr && sessions.contextOf(pr.path, c.id)) || c.ctx_used || 0;
    win = windowOfModel(c.model);     // 0, если такую модель мы ещё не гоняли сами
    exact = false;
  }
  if (!used) return { used: 0, window: 0, pct: 0, exact: false };
  // Контекст физически не может быть больше окна. Это старое агрегированное значение
  // хода, а не живой размер промпта; его нельзя показывать как «250%».
  if (win && used > win) return { used: 0, window: 0, pct: 0, exact: false, over: true };
  return { used, window: win, pct: win ? Math.min(100, Math.round(used / win * 100)) : 0, exact };
}
const chatDTO = c => ({
  id: c.id, project_id: c.project_id, title: c.title, provider: c.provider, model: c.model,
  permission_mode: c.permission_mode, effort: c.effort ?? '', state: c.state, pinned: !!c.pinned, archived: !!c.archived, origin: c.origin ?? 'depo', unread: !!c.unread,
  team: !!c.team,
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
    queues: Object.fromEntries(chats.map(c => [c.id, queue.pending(h, c.id)]).filter(([, items]) => items.length)),
    steering: Object.fromEntries([...PROVIDERS].map(p => [p, queue.canSteer(p)])),
    team: team.config(h),
    meters: { claude: meters.snapshot('claude'), codex: meters.snapshot('codex'), kimi: meters.snapshot('kimi') },
    running: runner.activeChats(),
    runs: Object.fromEntries(chats.map(c => {
      const run = h.get('SELECT * FROM runs WHERE chat_id=? ORDER BY id DESC LIMIT 1', c.id);
      return run ? [c.id, runInfo(run)] : null;
    }).filter(Boolean)),
    approvals: [...approvals.values()].filter(a => !a.decided).map(a => ({ id: a.id, chat_id: a.chat_id, tool_name: a.tool_name, input: a.input, at: a.at })),
    models: catalogAll(), prefs: prefs(),
    host: { name: os.hostname(), home: os.homedir() },
    https: fs.existsSync(path.join(TLS, 'server.crt')) ? HTTPS_PORT : null,
    version: VERSION,
  };
}
const VERSION = '0.2.0';
const PROVIDERS = new Set(['claude', 'codex', 'kimi']);
const normProv = p => PROVIDERS.has(p) ? p : 'claude';
const DEFAULTS = { companion: companion.DEFAULT, assistant_voice: 'chatgpt', provider: 'claude', model: '', permission_mode: 'manual', mirror: '1', archive_days: '14', effort: '', tools: '0', snapshot: '1' };
const prefs = () => Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, h.setting('pref_' + k) ?? v]));

// ─────────────────────────── маршруты ───────────────────────────
const routes = [];
const route = (method, pattern, handler, open = false) => {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-z_]+/gi, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, open });
};

// --- вход ---
route('POST', '/api/login', async (req, res) => {
  const { login, password } = await body(req);
  const key = ipOf(req) + '|' + String(login).slice(0, 64);
  const t = auth.throttle(key);
  if (!t.ok) return bad(res, 429, `Слишком много попыток. Подожди ${Math.ceil(t.wait / 60)} мин.`);
  const u = auth.verify(h, String(login || ''), String(password || ''));
  if (!u) {
    h.log('warn', 'auth', `неудачный вход ${String(login).slice(0, 64)} c ${ipOf(req)}${req.outside ? ' (снаружи)' : ''}`);
    if (req.outside) {
      const r = remote.loginFailed(h, ipOf(req));
      if (r.locked) {
        h.log('warn', 'remote', `неверный пароль снаружи (${remote.maxFails(h)} из ${remote.maxFails(h)}) — удалённый доступ выключен, остался только NetBird`);
        securityAlert(`🛡 Удалённый доступ к Depo выключен: неверный пароль через ${rcfgDomain()} (с ${ipOf(req)}, логин «${String(login).slice(0, 40).replace(/[<>&]/g, '')}»). Работает только NetBird. Включить обратно — 🌐 Доступ здесь или в настройках Depo.`);
      }
      await new Promise(r2 => setTimeout(r2, 1500));   // подбор вслепую — медленно
    }
    return bad(res, 401, 'Неверный логин или пароль.');
  }
  if (req.outside) remote.loginOk(h);
  auth.resetThrottle(key);
  // Новое устройство и включено подтверждение через Телеграм — сначала код из бота
  const dev = auth.parseCookies(req.headers.cookie)[twofa.DEVICE_COOKIE];
  if (twofa.enabled(h) && !twofa.isTrusted(h, dev)) {
    const { ticket, code } = twofa.issue({ userId: u.id, agent: req.headers['user-agent'] || '', ip: ipOf(req), outside: !!req.outside });
    const ua = String(req.headers['user-agent'] || '').replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').slice(0, 90);
    const sent = tg.on ? await tg.send(`🔐 <b>Код входа в Depo: <code>${code}</code></b>\nНовое устройство: ${ua.replace(/[<>&]/g, '')}\nАдрес: ${ipOf(req)}${req.outside ? ' (из интернета)' : ' (NetBird/дом)'}\nКод живёт 5 минут. Если это не ты — жми кнопку.`,
      { force: true, buttons: [[{ text: '🚫 Это не я', callback_data: `deny:${ticket}` }]] }) : { ok: false };
    if (!sent.ok) {
      twofa.kill(ticket);
      // бот недоступен: изнутри (NetBird/дом) пускаем с предупреждением в журнале, снаружи — нет
      if (req.outside) return bad(res, 503, 'Не удалось отправить код в Телеграм. Войди через NetBird.');
      h.log('warn', 'auth', `код входа не отправлен (${sent.error || 'бот выключен'}) — вход изнутри без кода`);
    } else {
      h.log('info', 'auth', `вход ${u.login} с нового устройства — ждём код из Телеграма`);
      return ok(res, { need_code: true, ticket });
    }
  }
  finishLogin(req, res, u.id, u.login);
}, true);

// Код из Телеграма для нового устройства: верный — сессия и «доверенное устройство»
route('POST', '/api/login/code', async (req, res) => {
  const { ticket, code } = await body(req);
  const r = twofa.verify(ticket, code);
  if (!r.ok) {
    if (r.outside) {
      const l = remote.loginFailed(h, ipOf(req));
      if (l.locked) securityAlert(`🛡 Удалённый доступ к Depo выключен: неверные коды подтверждения через ${rcfgDomain()} (последний с ${ipOf(req)}). Работает только NetBird.`);
      await new Promise(r2 => setTimeout(r2, 1500));
    }
    return bad(res, 401, r.error);
  }
  const u = h.get('SELECT id, login FROM users WHERE id=?', r.userId);
  if (!u) return bad(res, 401, 'Войди заново.');
  res.setHeader('set-cookie', [twofa.deviceCookie(twofa.trust(h, req.headers['user-agent']), !!(req.outside || req.socket.encrypted))]);
  finishLogin(req, res, u.id, u.login);
}, true);

function finishLogin(req, res, userId, login) {
  const token = auth.startSession(h, userId, req.headers['user-agent']);
  const prev = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), auth.cookieHeader(token, !!(req.outside || req.socket.encrypted))]);
  h.log('info', 'auth', `вход ${login} c ${ipOf(req)}${req.outside ? ' (снаружи)' : req.socket.encrypted ? ' (https)' : ''}`);
  ok(res, { ok: true });
}
// Включить/выключить подтверждение входа через Телеграм. Включает — это устройство сразу доверенное.
route('GET', '/api/twofa', (req, res) => ok(res, { enabled: twofa.enabled(h), tg: tg.on, devices: twofa.listDevices(h),
  trusted: twofa.isTrusted(h, auth.parseCookies(req.headers.cookie)[twofa.DEVICE_COOKIE]) }));
route('POST', '/api/twofa', async (req, res) => {
  const { enabled, forget } = await body(req);
  if (forget) { twofa.forgetDevices(h); h.log('warn', 'auth', 'доверенные устройства забыты'); }
  if (enabled !== undefined) {
    if (enabled && !tg.on) return bad(res, 409, 'Сначала подключи Телеграм-бота во вкладке «Телеграм».');
    twofa.setEnabled(h, !!enabled);
    h.log('info', 'auth', `подтверждение входа через Телеграм ${enabled ? 'включено' : 'выключено'}`);
  }
  if (twofa.enabled(h) && !twofa.isTrusted(h, auth.parseCookies(req.headers.cookie)[twofa.DEVICE_COOKIE]))
    res.setHeader('set-cookie', twofa.deviceCookie(twofa.trust(h, req.headers['user-agent']), !!(req.outside || req.socket.encrypted)));
  ok(res, { enabled: twofa.enabled(h), devices: twofa.listDevices(h) });
});

route('POST', '/api/logout', async (req, res) => {
  auth.endSession(h, req);
  res.setHeader('set-cookie', auth.clearCookie());
  ok(res);
}, true);

route('POST', '/api/password', async (req, res, _p, s) => {
  const { current, next } = await body(req);
  if (!auth.verify(h, s.user.login, String(current || ''))) return bad(res, 403, 'Текущий пароль неверный.');
  if (String(next || '').length < 4) return bad(res, 400, 'Пароль слишком короткий.');
  auth.setPassword(h, s.user.id, String(next));
  res.setHeader('set-cookie', auth.clearCookie());
  ok(res, { ok: true, relogin: true });
});

// --- состояние и поток ---
route('GET', '/api/state', (req, res, _p, s) => ok(res, fullState(s.user)));
route('GET', '/api/stream', (req, res) => { hub.attach(res, req); });
route('GET', '/api/meters', async (req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const provider = normProv(q.get('provider'));
  if (provider === 'codex') return ok(res, meters.snapshot('codex'));
  await meters.refresh({ force: q.get('force') === '1' });
  ok(res, meters.snapshot(provider));
});

// --- проекты ---
route('GET', '/api/browse', (req, res) => {
  const r = P.browse(new URL(req.url, 'http://x').searchParams.get('path') || '~', h.all('SELECT path FROM projects').map(x => x.path));
  r.ok ? ok(res, r) : bad(res, 400, r.error);
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
  let imported = false;
  try { imported = memory.init({ name: nm, path: chk.abs }); }
  catch (e) { h.log('warn', 'memory', `${nm}: ${e.message}`); }
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
    sets.push(`${k}=?`); vals.push(k === 'archived' ? (b[k] ? 1 : 0) : k === 'glyph' ? glyphClean(b[k]) : b[k]);
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

// --- проверки и безопасная публикация ---
const deploying = new Set();
route('GET', '/api/projects/:id/safety', (req, res, p) => {
  const root = projectRoot(p.id);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(root, '.depo', 'last-check.json'), 'utf8')); } catch { }
  ok(res, { config: safety.readConfig(root), last, deploying: deploying.has(+p.id) });
});
route('PUT', '/api/projects/:id/safety', async (req, res, p) => {
  const b = await body(req);
  ok(res, { config: await safety.saveConfig(projectRoot(p.id), b.config ?? {}) });
});
route('POST', '/api/projects/:id/checks', async (req, res, p) => {
  const root = projectRoot(p.id);
  const result = await safety.runChecks(root);
  h.log(result.ok ? 'info' : 'warn', 'checks', `${root}: ${result.ok ? 'успешно' : 'проверки не прошли'}`);
  ok(res, result);
});
route('POST', '/api/projects/:id/deploy', async (req, res, p) => {
  const id = +p.id, root = projectRoot(id);
  if (deploying.has(id)) return bad(res, 409, 'Публикация этого проекта уже идёт.');
  deploying.add(id);
  try {
    const result = await safety.deploy(root);
    await fsp.writeFile(path.join(root, '.depo', 'last-deploy.json'), JSON.stringify({ at: Date.now(), ...result }, null, 2));
    const project = h.get('SELECT name FROM projects WHERE id=?', id)?.name ?? root;
    if (!result.ok && result.stage === 'checks') notify('deploy_blocked', { project, text: result.error || 'обязательные проверки не прошли' });
    if (result.rolledBack) notify('rollback', { project });
    h.log(result.ok ? 'info' : 'warn', 'deploy', `${project}: ${result.ok ? 'опубликовано' : (result.error || result.stage)}`);
    ok(res, result);
  } finally { deploying.delete(id); }
});

// --- чаты ---
route('POST', '/api/chats', async (req, res) => {
  const b = await body(req);
  // если в этом проекте уже висит нетронутый пустой чат — отдаём его, а не плодим новый
  const idle = h.get(`SELECT * FROM chats WHERE project_id=? AND turns=0 AND archived=0 AND origin='depo'
                      AND id NOT IN (SELECT DISTINCT chat_id FROM messages) ORDER BY created_at DESC LIMIT 1`, +b.project_id);
  if (idle && !b.force) {
    if (b.team !== undefined && !!idle.team !== !!b.team) h.run('UPDATE chats SET team=? WHERE id=?', b.team ? 1 : 0, idle.id);
    return ok(res, { chat: chatDTO(h.get('SELECT * FROM chats WHERE id=?', idle.id)), reused: true });
  }
  const pr = h.get('SELECT * FROM projects WHERE id=?', +b.project_id);
  if (!pr) return bad(res, 400, 'Проект не найден.');
  const id = crypto.randomUUID();
  const t = Date.now();
  h.run(`INSERT INTO chats(id,project_id,title,provider,model,permission_mode,effort,team,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id, pr.id, String(b.title || 'Новый чат').slice(0, 200), normProv(b.provider || prefs().provider),
    b.model ?? (prefs().model || null), b.permission_mode || prefs().permission_mode || 'manual',
    b.effort ?? (prefs().effort || ''), (b.team ?? team.config(h).default_on) ? 1 : 0, t, t);
  const c = chatDTO(h.get('SELECT * FROM chats WHERE id=?', id));
  hub.send('chat', { chat: c, created: true });
  ok(res, { chat: c });
});

route('GET', '/api/chats/:id/messages', (req, res, p) => {
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  const after = +(new URL(req.url, 'http://x').searchParams.get('after') || 0);
  // без after отдаём ПОСЛЕДНИЕ 2000: иначе в очень длинных чатах новые сообщения терялись
  const rows = after
    ? h.all(`SELECT m.*, r.provider FROM messages m LEFT JOIN runs r ON r.id = m.run_id
             WHERE m.chat_id=? AND m.id>? ORDER BY m.id LIMIT 2000`, p.id, after)
    : h.all(`SELECT m.*, r.provider FROM messages m LEFT JOIN runs r ON r.id = m.run_id
             WHERE m.chat_id=? ORDER BY m.id DESC LIMIT 2000`, p.id).reverse();
  if (c.unread && !after) { h.run('UPDATE chats SET unread=0 WHERE id=?', p.id); c.unread = 0; hub.send('chat', { patch: { unread: false }, chat_id: p.id }); }
  ok(res, { chat: chatDTO(c), messages: rows.map(msgDTO), running: runner.isRunning(p.id),
    queue: queue.pending(h, p.id), can_steer: queue.canSteer(c.provider),
    run: runInfo(h.get('SELECT * FROM runs WHERE chat_id=? ORDER BY id DESC LIMIT 1', p.id)) });
});

route('PATCH', '/api/chats/:id', async (req, res, p) => {
  const b = await body(req);
  const cur = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!cur) return bad(res, 404, 'Чат не найден.');
  const sets = [], vals = [];
  for (const k of ['title', 'provider', 'model', 'permission_mode', 'effort', 'pinned', 'archived', 'state', 'unread', 'team']) {
    if (b[k] === undefined) continue;
    const v = k === 'provider' ? normProv(b[k]) : ['pinned', 'archived', 'unread', 'team'].includes(k) ? (b[k] ? 1 : 0) : b[k];
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
  const { text, attachments, mode = 'now', force = false } = await body(req);
  const msg = String(text || '').trim();
  const atts = (Array.isArray(attachments) ? attachments : []).filter(a => a?.path?.startsWith(UPLOADS + path.sep)).slice(0, 12);
  if (!msg && !atts.length) return bad(res, 400, 'Пустое сообщение.');
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  if (!accounts.ready(c.provider)) return bad(res, 409, `${handoff.nameOf(c.provider)} отключён. Войди в аккаунт в настройках или выбери другого агента.`);
  const pr = h.get('SELECT * FROM projects WHERE id=?', c.project_id);
  if (!pr || !fs.existsSync(pr.path)) return bad(res, 400, 'Папка проекта недоступна.');

  if (runner.isRunning(p.id)) return ok(res, steerOrQueue(c, msg, atts, mode));
  // между шагами команды процесс не идёт, но задача ещё в работе — сообщение ждёт её конца
  const liveTeam = teamActive(p.id);
  if (liveTeam && liveTeam.status === 'running') { const item = queue.enqueue(h, p.id, msg, atts); queueEmit(p.id); return ok(res, { queued: true, item, reason: 'Команда ещё работает — сообщение уйдёт после неё.' }); }

  if (cliUpdating(c.provider)) return bad(res, 409, cliUpdating(c.provider));
  // Два агента, правящие одну папку одновременно, — главный источник «сломалось на соседней странице».
  // Не запрещаем (бывает осознанно), но без явного согласия владельца второй не стартует.
  const rival = !force && c.permission_mode !== 'plan' && runner.activeChats()
    .map(id => h.get('SELECT id, title, provider, permission_mode FROM chats WHERE id=? AND project_id=?', id, c.project_id))
    .find(x => x && x.id !== c.id && x.permission_mode !== 'plan');
  if (rival) return json(res, 409, {
    error: `В этом проекте уже работает ${handoff.nameOf(rival.provider)} (чат «${rival.title}»). Параллельные правки одной папки могут конфликтовать.`,
    busy: { chat_id: rival.id, title: rival.title, provider: rival.provider },
  });
  if (c.title === 'Новый чат') {
    const title = msg.replace(/\s+/g, ' ').slice(0, 72) + (msg.length > 72 ? '…' : '');
    h.run('UPDATE chats SET title=? WHERE id=?', title, p.id);
    hub.send('chat', { chat: chatDTO(h.get('SELECT * FROM chats WHERE id=?', p.id)) });
  }
  // «Запомни …» — владелец сам добавляет урок проекта; сообщение всё равно уходит агенту
  const remember = String(msg || '').match(/^\s*запомни\s*[:,—-]?\s+([\s\S]{3,300})$/i);
  if (remember) saveLessons(p.id, [remember[1].replace(/\s+/g, ' ').trim()], 'владелец');
  // Сменили провайдера посреди чата — собираем передачу, чтобы контекст не потерялся
  let prompt = msg;
  const last = handoff.lastAgent(h, p.id);
  if (last && last !== c.provider) {
    const ho = handoff.build(h, { ...c, cwd: pr.path }, last, c.provider);
    if (ho) {
      prompt = ho.text + '\n\n## Новое сообщение владельца\n' + msg;
      runner.save(p.id, null, 'handoff', 'notice',
        `Передача из ${handoff.nameOf(last)} в ${handoff.nameOf(c.provider)}: задача, ${ho.files.length} файлов и последние ходы. Скрытые рассуждения не переносятся.`,
        { files: ho.files, from: last, to: c.provider });
    }
  }

  try {
    if (c.team) {   // чат работает командой: сначала план ведущего
      const runId = teamStart(c, pr, msg, atts);
      return ok(res, { run_id: runId, team: true, run: runInfo(h.get('SELECT * FROM runs WHERE id=?', runId)) });
    }
    const runId = runner.start({ ...c, cwd: pr.path }, msg || '(вложения)', prompt || 'Посмотри вложения.', atts);
    meters.refresh({ force: true, cwd: pr.path }).catch(() => { });
    // SSE может прийти до ответа на POST. Возвращаем тот же серверный снимок,
    // чтобы клиент сразу знал started_at и не рисовал вечные 00:00:00.
    ok(res, { run_id: runId, run: runInfo(h.get('SELECT * FROM runs WHERE id=?', runId)) });
  } catch (e) { bad(res, 409, e.message); }
});

route('GET', '/api/chats/:id/queue', (req, res, p) => ok(res, { items: queue.pending(h, p.id) }));
route('PATCH', '/api/queue/:id', async (req, res, p) => {
  const b = await body(req);
  const old = queue.byId(h, p.id);
  if (!old) return bad(res, 404, 'Сообщение не найдено.');
  const item = queue.update(h, p.id, b.text);
  if (!item) return bad(res, 409, 'Сообщение уже отправлено.');
  queueEmit(old.chat_id);
  ok(res, { item });
});
route('DELETE', '/api/queue/:id', (req, res, p) => {
  const old = queue.byId(h, p.id);
  if (!old) return bad(res, 404, 'Сообщение не найдено.');
  if (!queue.remove(h, p.id)) return bad(res, 409, 'Сообщение уже отправлено.');
  queueEmit(old.chat_id);
  ok(res);
});

route('POST', '/api/chats/:id/cancel', (req, res, p) =>
  ok(res, { cancelled: runner.cancel(p.id) }));
route('GET', '/api/runs/:id', (req, res, p) => {
  const row = h.get(`SELECT r.*,c.project_id,c.title,p.path AS project_path,p.name AS project_name
                     FROM runs r JOIN chats c ON c.id=r.chat_id JOIN projects p ON p.id=c.project_id WHERE r.id=?`, +p.id);
  if (!row) return bad(res, 404, 'Ход не найден.');
  let deploy = null;
  try {
    const value = JSON.parse(fs.readFileSync(path.join(row.project_path, '.depo', 'last-deploy.json'), 'utf8'));
    if (value.at >= row.started_at && (!row.ended_at || value.at <= row.ended_at)) deploy = value;
  } catch { }
  ok(res, { run: runInfo(row), facts: memory.runFacts(h, row.id), deploy,
    diff_url: `/api/projects/${row.project_id}/diff` });
});

// --- разрешения ---
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
// Точная разбивка контекста этого чата — тем же способом, каким её показывает Claude Code
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
    // запоминаем точные цифры, чтобы чип в шапке не расходился с этой панелью
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

route('GET', '/api/models', async (req, res) => {
  // ?refresh=1 — кнопка «обновить каталог Kimi» в настройках: перечитать сразу, не ждать таймера
  if (new URL(req.url, 'http://x').searchParams.get('refresh')) { await refreshKimiCatalog().catch(() => { }); hub.send('models', catalogAll()); }
  ok(res, catalogAll());
});

// --- зеркало сессий Claude ---
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
// Разговоры из Claude Code — по требованию: список сессий проекта и подъём выбранной.
// Так можно держать постоянное зеркало выключенным и поднимать только то, что нужно продолжить.
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

setInterval(() => {                                   // фоновое зеркало: раз в 45 с, только stat файлов
  for (const pr of h.all('SELECT * FROM projects WHERE archived=0')) syncOne(pr).catch(() => { });
}, 45000).unref();

// --- файлы проекта ---
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

// --- вложения в чат (скриншоты, файлы) ---
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
  const dir = await files.insideReal(root, q.get('dir') || '.');
  const name = safeName(decodeURIComponent(req.headers['x-name'] || 'file'));
  const data = await rawBody(req, 256 << 20);
  if (!data.length) return bad(res, 400, 'Пустой файл.');
  let target = path.join(dir, name), i = 1;
  const taken = p => { try { fs.lstatSync(p); return true; } catch { return false; } };
  while (taken(target)) { const e = path.extname(name); target = path.join(dir, `${name.slice(0, name.length - e.length)}-${i++}${e}`); }
  await fsp.writeFile(target, data);
  h.log('info', 'files', `загружен ${path.relative(root, target)} в ${path.basename(root)}`);
  ok(res, { path: path.relative(root, target), size: data.length });
});
route('GET', '/api/projects/:id/raw', async (req, res, p) => {
  const rel = new URL(req.url, 'http://x').searchParams.get('path');
  if (!rel) return bad(res, 400, 'Нужен путь.');
  const abs = await files.insideReal(projectRoot(p.id), rel);
  if (!await serveFile(res, abs)) bad(res, 404, 'Нет файла.');
});

// --- аккаунты провайдеров ---
// Аккаунты агентов: кто вошёл (почта), сохранённые профили и их последние лимиты.
// Текущий вход запоминается в профиль сам — переключаться можно без «Сохранить как…».
const ACC_PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'];
const accBusy = provider => {
  const c = runner.activeChats().map(id => h.get('SELECT title, provider FROM chats WHERE id=?', id)).find(x => x?.provider === provider);
  return c ? `${handoff.nameOf(provider)} сейчас работает в чате «${c.title}» — дождись конца хода или останови его.` : '';
};
const accState = () => Object.fromEntries(ACC_PROVIDERS.map(pv => {
  try { accounts.capture(DATA, pv, { meters: pv === 'gemini' ? null : meters.snapshot(pv) }); } catch (e) { h.log('warn', 'accounts', `${pv}: ${e.message}`); }
  return [pv, { current: accounts.current(pv), profiles: accounts.list(DATA, pv),
    meters: pv === 'gemini' ? null : meters.snapshot(pv) }];
}));
route('GET', '/api/accounts', async (req, res) => { if (accounts.ready('kimi')) await accounts.refreshKimiProfile().catch(() => { }); ok(res, accState()); });
route('POST', '/api/accounts/:provider/save', async (req, res, p) => {
  const { name } = await body(req);
  try { ok(res, await accounts.save(DATA, p.provider, name)); } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/accounts/:provider/use', async (req, res, p) => {
  const { name } = await body(req);
  if (!ACC_PROVIDERS.includes(p.provider)) return bad(res, 400, 'Неизвестный агент.');
  const busy = accBusy(p.provider) || cliUpdating(p.provider);
  if (busy) return bad(res, 409, busy);
  try {
    const r = await accounts.use(DATA, p.provider, name, { meters: p.provider === 'gemini' ? null : meters.snapshot(p.provider) });
    h.log('info', 'accounts', `${p.provider} → профиль ${r.name}`);
    invalidateModels?.();
    hub.send('models', catalogAll());
    // лимиты нового аккаунта — сразу, чтобы было видно, сколько осталось
    if (p.provider === 'kimi') await accounts.refreshKimiProfile({ force: true }).catch(() => { });
    const m = p.provider === 'gemini' ? null : await meters.reset(p.provider).catch(() => null);
    if (p.provider !== 'gemini') accounts.capture(DATA, p.provider, { meters: m });
    ok(res, { ...r, meters: m, accounts: accState() });
  } catch (e) { bad(res, 400, e.message); }
});
// Добавить ещё один аккаунт: текущий уже сохранён в профиль, локальный вход убираем (без отзыва токенов),
// дальше обычный вход через браузер.
route('POST', '/api/accounts/:provider/add', async (req, res, p) => {
  if (!ACC_PROVIDERS.includes(p.provider)) return bad(res, 400, 'Неизвестный агент.');
  const busy = accBusy(p.provider) || cliUpdating(p.provider);
  if (busy) return bad(res, 409, busy);
  try {
    accounts.detach(DATA, p.provider);
    h.log('info', 'accounts', `${p.provider}: вход освобождён для нового аккаунта`);
    invalidateModels?.();
    hub.send('models', catalogAll()); ok(res);
  } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/accounts/:provider/forget', async (req, res, p) => {
  const { name } = await body(req);
  const prof = accounts.list(DATA, p.provider).find(x => x.id === name);
  if (prof?.active) return bad(res, 409, 'Это текущий аккаунт — сначала переключись на другой или выйди.');
  await accounts.remove(DATA, p.provider, name); ok(res);
});
route('POST', '/api/accounts/:provider/logout', async (req, res, p) => {
  const busy = accBusy(p.provider);
  if (busy) return bad(res, 409, busy);
  try {
    // выход через CLI отзывает токены — профиль этого аккаунта после него бесполезен, убираем и его
    const prof = accounts.list(DATA, p.provider).find(x => x.active);
    await accounts.logout(p.provider);
    if (prof) await accounts.remove(DATA, p.provider, prof.id);
    h.log('info', 'accounts', `${p.provider}: выход из аккаунта`);
    hub.send('models', catalogAll()); ok(res);
  } catch (e) { bad(res, 400, e.message); }
});

// --- Собеседник внутри чата ---
// Не исполнитель: ничего не запускает, файлов не трогает. Кем он работает — Codex, Claude
// или Gemini — выбирается в настройках. Его реплики ложатся в тот же чат отдельным ходом
// с провайдером companion, поэтому в ленте он виден как отдельный голос.
route('POST', '/api/chats/:id/companion', async (req, res, p) => {
  const who = companionOf();
  if (!companion.ready(who)) return bad(res, 400, `Собеседник (${who}) не подключён — войди в него в настройках.`);
  const c = h.get('SELECT * FROM chats WHERE id=?', p.id);
  if (!c) return bad(res, 404, 'Чат не найден.');
  const { text = '', voice = false, mode: rawMode = 'explain' } = await body(req);
  const mode = rawMode === 'draft' ? 'draft' : 'explain';
  const question = String(text).trim() || 'Что сейчас происходит в этом чате и что разумно сделать дальше?';
  // Собеседник знает ровно то, что Depo знает наверняка: статус хода и git-статус папки — без содержимого файлов.
  const pr = h.get('SELECT name, path FROM projects WHERE id=?', c.project_id);
  const run = h.get("SELECT status, phase FROM runs WHERE chat_id=? AND provider!='companion' ORDER BY id DESC LIMIT 1", c.id);
  const g = pr && fs.existsSync(pr.path) ? handoff.gitFacts(pr.path) : null;
  const facts = [
    `Проект: ${pr?.name ?? '?'}; агент чата: ${handoff.nameOf(c.provider)}.`,
    `Ход агента: ${runner.isRunning(c.id) ? `идёт сейчас (${run?.phase || 'работает'})` : run ? `последний — ${run.status}` : 'ещё не было'}.`,
    g ? `Git (ветка ${g.branch}): ${g.status.length ? `незакоммичено ${g.status.length}: ${g.status.slice(0, 15).join('; ')}` : 'чисто'}.` : 'Git: нет данных.',
  ].join('\n');

  const rows = h.all(`SELECT m.role, m.text, r.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id
                      WHERE m.chat_id=? AND m.role IN ('user','assistant') AND m.kind='text' ORDER BY m.id`, c.id);
  const t = Date.now();
  const rr = h.run('INSERT INTO runs(chat_id,provider,model,status,started_at) VALUES(?,?,?,?,?)',
    c.id, 'companion', who, 'running', t);
  const runId = Number(rr.lastInsertRowid);
  const put = (role, body2, json = null) => {
    const r2 = h.run('INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES(?,?,?,?,?,?,?)', c.id, runId, role, 'text', body2, json ? JSON.stringify(json) : null, Date.now());
    const m = h.get('SELECT m.*, r.provider FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.id=?', Number(r2.lastInsertRowid));
    hub.send('message', { chat_id: c.id, message: msgDTO(m) });
    return m;
  };
  put('user', mode === 'draft' ? `Подготовь уточнение: ${question}` : question);
  try {
    const recent = rows.slice(-24);
    const a = await companion.ask({ provider: who, question, context: companion.digest(recent), facts, voice: !!voice, mode });
    const sources = [`последние ${recent.length} реплик чата`, 'статус хода', g ? `git status (${g.status.length})` : null].filter(Boolean);
    put('assistant', a.text, { companion_mode: mode, draft: mode === 'draft', sources });
    h.run('UPDATE runs SET status=?, ended_at=? WHERE id=?', 'done', Date.now(), runId);
    h.run('UPDATE chats SET updated_at=? WHERE id=?', Date.now(), c.id);
    ok(res, { text: a.text, provider: a.provider, mode, sources });
  } catch (e) {
    h.run('UPDATE runs SET status=?, ended_at=? WHERE id=?', 'error', Date.now(), runId);
    put('error', `Собеседник: ${e.message}`);
    bad(res, 502, e.message);
  }
});
// --- копия переписки в папке проекта ---
// После хода ждём полминуты: за это время обычно прилетает ещё пара сообщений,
// и папку проекта не дёргаем на каждую реплику.
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

// --- вход в аккаунт агента прямо из браузера ---
// Отпечаток учётных данных агента: по его смене Linker понимает, что вход состоялся.
const AUTH_FILES = {
  claude: ['.claude/.credentials.json'],
  codex: ['.codex/auth.json'],
  gemini: ['.gemini/oauth_creds.json'],
  kimi: [],                                  // список credentials динамический, его собирает kimiSignature()
};
const authSig = provider => {
  // У Kimi region.json может оставаться logged-out даже после успешного OAuth,
  // поэтому следим за официальными файлами credentials, а не за этим флагом.
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
// возврат из браузера: владелец вставляет адрес, на который его перекинуло
route('POST', '/api/link/:provider/callback', async (req, res, p) => {
  const { url = '' } = await body(req);
  try { ok(res, await linker.callback(p.provider, url)); } catch (e) { bad(res, 400, e.message); }
});

// --- настройки ---
route('GET', '/api/settings', (req, res) => ok(res, { prefs: prefs(), defaults: DEFAULTS }));
route('POST', '/api/settings', async (req, res) => {
  const b = await body(req);
  for (const k of Object.keys(DEFAULTS)) if (b[k] !== undefined) h.setting('pref_' + k, String(b[k] ?? ''));
  hub.send('prefs', { prefs: prefs() });
  ok(res, { prefs: prefs() });
});

// --- доска: кто что ждёт ---
route('GET', '/api/board', (req, res) => ok(res, { items: boardItems() }));

// Главная: один агрегированный запрос вместо каскада. Лёгкие SELECT по существующим таблицам.
route('GET', '/api/dashboard', (req, res) => {
  const pend = [...approvals.values()].filter(a => !a.decided);
  const active = runner.activeChats().map(id => {
    const c = h.get('SELECT c.*, p.name AS project, p.glyph FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?', id);
    if (!c) return null;
    const run = runInfo(h.get("SELECT * FROM runs WHERE chat_id=? AND status='running' ORDER BY id DESC LIMIT 1", id));
    const last = h.get("SELECT text FROM messages WHERE chat_id=? AND kind IN ('tool_use','text') AND text IS NOT NULL ORDER BY id DESC LIMIT 1", id);
    const a = pend.find(x => x.chat_id === id);
    return { chat: chatDTO(c), project: c.project, glyph: c.glyph, run,
      last_action: (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 140), approval_id: a?.id ?? null };
  }).filter(Boolean);
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const week = Date.now() - 7 * 864e5;
  const stats = {
    done_today: h.get("SELECT COUNT(*) n FROM runs WHERE status='done' AND ended_at>=?", day.getTime()).n,
    done_week: h.get("SELECT COUNT(*) n FROM runs WHERE status='done' AND ended_at>=?", week).n,
    active_ms_week: h.get("SELECT COALESCE(SUM(ended_at-started_at-waiting_ms),0) s FROM runs WHERE status='done' AND ended_at>=?", week).s,
    projects_week: h.get('SELECT COUNT(DISTINCT c.project_id) n FROM runs r JOIN chats c ON c.id=r.chat_id WHERE r.ended_at>=?', week).n,
  };
  const projects = h.all(`SELECT p.*, (SELECT MAX(c2.updated_at) FROM chats c2 WHERE c2.project_id=p.id AND c2.archived=0) AS activity
                          FROM projects p WHERE p.archived=0 ORDER BY activity DESC LIMIT 12`)
    .map(p => {
      const last = h.get('SELECT * FROM chats WHERE project_id=? AND archived=0 ORDER BY updated_at DESC LIMIT 1', p.id);
      const working = h.get("SELECT COUNT(*) n FROM chats WHERE project_id=? AND archived=0 AND state IN ('running','attention')", p.id).n;
      return { ...projectDTO(p), activity: p.activity ?? p.created_at, last_chat: last ? chatDTO(last) : null, working };
    });
  const providers = ['claude', 'codex', 'kimi', 'gemini'].map(id => ({ id, current: accounts.current(id) }));
  ok(res, { active, stats, projects, providers, meters: meters.both(), server: serverStats(DATA), at: Date.now() });
});

// обновления AI CLI — раздел «Обновления AI» в настройках
const cliView = () => ({ ...cliUpd.states(), scheduler: CLI_AUTO,
  log: h.all("SELECT ts, level, text FROM log WHERE scope='cli-update' ORDER BY id DESC LIMIT 60") });
const cliId = id => cliUpdate.IDS.includes(id) ? id : null;
route('GET', '/api/cli-updates', (req, res) => ok(res, cliView()));
route('POST', '/api/cli-updates/check', async (req, res) => {
  const { id } = await body(req);
  if (id && !cliId(id)) return bad(res, 404, 'Нет такого агента.');
  if (id) await cliUpd.check(id); else await cliUpd.checkAll();
  ok(res, cliView());
});
route('POST', '/api/cli-updates/:id/update', async (req, res, p) => {
  if (!cliId(p.id)) return bad(res, 404, 'Нет такого агента.');
  // установка может идти минуты — ждём чуть-чуть, дальше ход виден по событиям cliupd
  const job = cliUpd.requestUpdate(p.id);
  const r = await Promise.race([job, new Promise(r2 => setTimeout(() => r2({ status: 'started' }), 1500))]);
  ok(res, { result: r, ...cliView() });
});
route('POST', '/api/cli-updates/:id/rollback', async (req, res, p) => {
  if (!cliId(p.id)) return bad(res, 404, 'Нет такого агента.');
  const r = await cliUpd.rollback(p.id);
  r.ok ? ok(res, { result: r, ...cliView() }) : bad(res, 409, r.message);
});
route('POST', '/api/cli-updates/:id/auto', async (req, res, p) => {
  if (!cliId(p.id)) return bad(res, 404, 'Нет такого агента.');
  cliUpd.setAuto(p.id, !!(await body(req)).on);
  ok(res, cliView());
});
route('POST', '/api/cli-updates/channel', async (req, res) => {
  cliUpd.setChannel(String((await body(req)).channel || ''));
  ok(res, cliView());
});

// состояние машины — карточка «Сервер» на главной; клиент опрашивает редко и только с открытым дашбордом
route('GET', '/api/server', (req, res) => ok(res, serverStats(DATA)));

// web push: публичный ключ VAPID и приём/отзыв подписок этого устройства
route('GET', '/api/push', (req, res) => ok(res, push.state(h)));
route('POST', '/api/push/subscribe', async (req, res) => {
  try { push.subscribe(h, await body(req)); ok(res); } catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/push/unsubscribe', async (req, res) => {
  push.unsubscribe(h, String((await body(req))?.endpoint || ''));
  ok(res);
});

// массовый архив старого
route('POST', '/api/projects/:id/archive-old', async (req, res, p) => {
  const { days = 7 } = await body(req);
  const cut = Date.now() - Math.max(1, +days) * 864e5;
  const r = h.run(`UPDATE chats SET archived=1 WHERE project_id=? AND archived=0 AND updated_at<? AND state NOT IN ('running','attention') AND pinned=0`, +p.id, cut);
  hub.send('reload', {});
  ok(res, { archived: Number(r.changes) });
});

// --- голос ---
route('GET', '/api/voice/status', async (req, res) => ok(res, { ...(await voice.status()), chatgpt: gptVoice.ready() }));
// Диктовка голосом ChatGPT через Codex (экспериментально): браузер шлёт SDP-оффер, сервер — ответ codex.
route('POST', '/api/voice/chatgpt/start', async (req, res) => {
  const { sdp } = await body(req, 256 << 10);
  try {
    ok(res, await gptVoice.start({ sdp, onText: d => hub.send('voice-text', d), log: t => h.log('info', 'voice', t) }));
  } catch (e) { h.log('warn', 'voice', `ChatGPT-диктовка: ${e.message}`); bad(res, 502, e.message); }
});
route('POST', '/api/voice/chatgpt/stop', async (req, res) => {
  const { id } = await body(req);
  try { ok(res, await gptVoice.stop(String(id || ''))); } catch (e) { bad(res, 410, e.message); }
});
// ─── Ассистент Depo: поговорить о проектах. scope: all | p:<id> | c:<chatId> ───
const asstScope = v => {
  const s2 = String(v || 'all');
  return s2.startsWith('p:') ? { project: +s2.slice(2) } : s2.startsWith('c:') ? { chat: s2.slice(2) } : 'all';
};
route('GET', '/api/assistant/digest', (req, res) => ok(res, assistant.digest(h, asstScope(new URL(req.url, 'http://x').searchParams.get('scope')))));
// живой голос ChatGPT (под входом Codex): браузер шлёт SDP, сводка Depo уходит в инструкции голосовой сессии
route('POST', '/api/assistant/start', async (req, res) => {
  const { sdp, scope } = await body(req, 256 << 10);
  const ins = assistant.instructions(h, asstScope(scope));
  try {
    const sc = asstScope(scope);
    const pr = sc.project ? h.get('SELECT path FROM projects WHERE id=?', sc.project)
      : sc.chat ? h.get('SELECT p.path FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?', sc.chat) : null;
    const r = await gptVoice.start({ sdp, prompt: ins.voice, assistant: true, workdir: pr?.path ?? os.homedir(), agentInstructions: ins.agent,
      onText: d => hub.send('assistant-text', d), log: t => h.log('info', 'assistant', t) });
    h.log('info', 'assistant', `голосовой разговор: ${ins.label}`);
    ok(res, { ...r, label: ins.label });
  } catch (e) { h.log('warn', 'assistant', `голос ChatGPT: ${e.message}`); bad(res, 502, e.message); }
});
route('POST', '/api/assistant/say', async (req, res) => {
  const { id, text } = await body(req);
  try { await gptVoice.appendText(String(id || ''), text); ok(res); } catch (e) { bad(res, 410, e.message); }
});
route('POST', '/api/assistant/stop', async (req, res) => { const { id } = await body(req); gptVoice.close(String(id || '')); ok(res); });
// текстом (или когда живой голос недоступен): ответ выбранного собеседника, озвучивает браузер
route('POST', '/api/assistant/ask', async (req, res) => {
  const { text, scope, history = [] } = await body(req);
  const q = String(text || '').trim();
  if (!q) return bad(res, 400, 'Пустой вопрос.');
  const who = companionOf();
  if (!companion.ready(who)) return bad(res, 400, `Собеседник (${who}) не подключён — выбери другого в настройках.`);
  const sc = asstScope(scope);
  const ins = assistant.instructions(h, sc);
  const pr = sc.project ? h.get('SELECT path FROM projects WHERE id=?', sc.project)
    : sc.chat ? h.get('SELECT p.path FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?', sc.chat) : null;
  const ctx = (Array.isArray(history) ? history : []).slice(-8).map(m => `${m.role === 'user' ? 'Владелец' : 'Ассистент'}: ${String(m.text || '').slice(0, 600)}`).join('\n');
  try {
    // отвечает агент в папке проекта (только чтение) — может сам заглянуть в файлы, git, таймеры
    const a = await companion.ask({ provider: who, question: q, context: ctx, facts: ins.facts, role: assistant.ROLE, cwd: pr?.path ?? os.homedir() });
    ok(res, { text: a.text, provider: a.provider, label: ins.label });
  } catch (e) { bad(res, 502, e.message); }
});
route('POST', '/api/voice/chatgpt/cancel', async (req, res) => { const { id } = await body(req); gptVoice.close(String(id || '')); ok(res); });
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

// --- телеграм ---
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

// --- резервные копии ---
route('GET', '/api/remote', async (req, res) => {
  const nb = remote.netbirdIp();
  const peer = await remote.detectRelayPeer(h).catch(() => null);
  ok(res, { ...remote.get(h), netbird_ip: nb, port: PORT, https_port: HTTPS_PORT, relay: peer, login_path: remote.loginPath(h), max_fails: remote.maxFails(h),
    compose: remote.relayCompose({ target: nb || 'NETBIRD_IP_DEPO', port: PORT, httpsPort: HTTPS_PORT }), via: remote.viaRelay(remote.get(h), req) });
});
route('POST', '/api/remote', async (req, res) => {
  const b = await body(req);
  try {
    if (b.login_path !== undefined) remote.setLoginPath(h, b.login_path);
    if (b.max_fails !== undefined) h.setting('remote_max_fails', String(Math.max(1, Math.min(5, +b.max_fails || 1))));
  } catch (e) { return bad(res, 400, e.message); }
  // выключать доступ, сидя через этот же доступ, можно — но предупреждаем в интерфейсе; включать — только изнутри
  try {
    const v = remote.set(h, b);
    h.log('info', 'remote', `удалённый доступ: ${v.enabled ? 'включён' : 'выключен'} · ${v.domain || 'без домена'} · ${v.relay_ip || 'IP не задан'}`);
    await syncRemote();
    ok(res, remote.get(h));
  }
  catch (e) { bad(res, 400, e.message); }
});
route('POST', '/api/remote/check', async (req, res) => ok(res, await remote.check(remote.get(h), { version: VERSION, httpsPort: HTTPS_PORT, caFile: path.join(TLS, 'ca.crt'), probe: remote.probeToken(h) })));
// «Это точно я?» — проверка снаружи по секрету; без секрета — пустой 404
route('GET', '/api/remote/probe', (req, res) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t') || '';
  t && t === remote.probeToken(h) ? ok(res, { ok: true }) : blank(res);
}, true);
route('GET', '/api/team/config', (req, res) => ok(res, { config: team.config(h), suggest: null }));
route('POST', '/api/team/config', async (req, res) => {
  let cfg;
  try { cfg = team.save(h, await body(req)); } catch (e) { return bad(res, 400, e.message); }
  hub.send('team-config', { config: cfg });
  h.log('info', 'team', 'настройки команды сохранены');
  ok(res, { config: cfg });
});
route('POST', '/api/team/:id/start', (req, res, p) => {
  const t = teamGet(p.id);
  if (!t || t.status !== 'await') return bad(res, 409, 'План уже запущен или отменён.');
  teamSave(t, { status: 'running', step: -1 });
  teamStep(t.id);
  ok(res);
});
route('POST', '/api/team/:id/cancel', (req, res, p) => {
  const t = teamGet(p.id);
  if (!t || !['planning', 'await', 'running'].includes(t.status)) return bad(res, 409, 'Задача уже закончена.');
  if (runner.isRunning(t.chat_id)) runner.cancel(t.chat_id);   // ход остановится — команда отметит «остановлено»
  else { teamSave(t, { status: 'stopped', error: 'Отменено владельцем.' }); startQueued(t.chat_id); }
  ok(res);
});
route('GET', '/api/storage', (req, res) => ok(res, housekeeping.usage(h, DATA)));
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

// ─────────────────────────── сервер ───────────────────────────
const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  try {
    // пришли через проводник, а удалённый доступ выключен — не пускаем дальше ни на что
    // Защитные заголовки — всегда; снаружи (через проводник) ещё и строже.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    const rcfg = remote.get(h), outside = remote.viaRelay(rcfg, req);
    if (outside) {
      res.setHeader('strict-transport-security', 'max-age=31536000');
      // Выключен удалённый доступ — снаружи просто пустая страница: ни ошибки, ни имени, ни версии.
      // До входа снаружи видно только страницу входа и то, что нужно ей самой.
      if (!rcfg.enabled) return blank(res);
      const lp = remote.loginPath(h), hasSession = !!auth.readSession(h, req);
      if (!hasSession && req.method === 'GET') {
        // снаружи без входа: на главной — сайт, вход — только по секретному адресу
        if (pathname === '/' || pathname === '/index.html') return serveStatic(res, path.join(PUB, 'site', 'index.html'));
        if (pathname === lp) return serveLoginOutside(res);
        if (pathname.startsWith('/site/')) {
          const f = path.join(PUB, 'site', path.basename(pathname));
          return fs.existsSync(f) ? serveStatic(res, f) : blank(res);
        }
      }
      if (!remote.relayPublic(pathname, lp) && !hasSession) {
        // приложению нужно понять «сессия кончилась» — пустой 401 без подробностей; остальное — пустой 404
        if (pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{}'); }
        return blank(res);
      }
    }
    req.outside = outside;
    const m = routes.find(r => r.method === req.method && r.rx.test(pathname));
    if (m) {
      const session = auth.readSession(h, req);
      if (!m.open && !session) return bad(res, 401, 'Нужен вход.');
      const vals = pathname.match(m.rx).slice(1);
      const params = Object.fromEntries(m.keys.map((k, i) => [k, vals[i]]));
      return await m.handler(req, res, params, session);
    }
    if (pathname.startsWith('/api/')) return bad(res, 404, 'Нет такого метода.');

    // статика
    if (req.method !== 'GET') return bad(res, 405, 'Метод не поддерживается.');
    const session = auth.readSession(h, req);
    if (pathname === '/' || pathname === '/index.html') {
      res.setHeader('x-depo-page', session ? 'app' : 'login');   // service worker не кладёт страницу входа в кэш оболочки
      if (!session && req.outside) return serveLoginOutside(res);
      return void await serveFile(res, path.join(PUB, session ? 'app.html' : 'login.html'), { store: false });
    }
    if (pathname === '/ca.crt') {                       // корневой сертификат — поставить на телефон один раз
      try {
        const pem = await fsp.readFile(path.join(TLS, 'ca.crt'));
        res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="depo-ca.crt"' });
        return res.end(pem);
      } catch { return bad(res, 404, 'Сертификата нет. Запусти scripts/make-cert.sh.'); }
    }
    if (pathname === '/login') {
      if (session) { res.writeHead(302, { location: '/' }); return res.end(); }
      if (req.outside) return serveLoginOutside(res);
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

// Проводник и имена https: раз в 5 минут находим проводник в NetBird и следим, чтобы сертификат Depo
// покрывал имя машины в NetBird и IP проводника (вход по https://IP:4621 и отпечаток по имени NetBird).
async function syncRemote() {
  try {
    const peer = await remote.detectRelayPeer(h);
    const st = await remote.netbirdStatus();
    const cfg = remote.get(h);
    const names = [remote.netbirdIp(), st?.fqdn, cfg.relay_ip].filter(Boolean);
    if (tls && await tlscert.ensureSans(TLS, names)) {
      tls.setSecureContext({ key: fs.readFileSync(path.join(TLS, 'server.key')), cert: fs.readFileSync(path.join(TLS, 'server.crt')) });
      h.log('info', 'tls', `сертификат перевыпущен: ${names.join(', ')}`);
    }
    return peer;
  } catch (e) { h.log('warn', 'remote', e.message); return null; }
}
setTimeout(syncRemote, 5000).unref?.();
setInterval(syncRemote, 5 * 60e3).unref?.();

// Остановка: отменить ходы, закрыть сервер. code ≠ 0 — systemd поднимет нас снова (перезапуск из телеграма).
let stopping = false;
function shutdown(why, code = 0) {
  if (stopping) return;
  stopping = true;
  h.log('info', 'server', `остановка: ${why}`);
  for (const id of runner.activeChats()) runner.cancel(id);
  server.close(() => process.exit(code)); tls?.close();
  setTimeout(() => process.exit(code), 3000);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(`по ${sig}`));
process.on('unhandledRejection', e => h.log('error', 'server', `необработанный отказ: ${e?.stack || e}`));
