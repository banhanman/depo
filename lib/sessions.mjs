// Импорт и зеркало сессий Claude Code. Claude кладёт каждую сессию в
// ~/.claude/projects/<путь-с-дефисами>/<uuid>.jsonl. Depo читает эти файлы
// и показывает их как чаты проекта — поэтому то, что ты делал в терминале
// или через Remote Control, видно здесь, и наоборот.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const MAX_TEXT = 4000;
const ARCHIVE_AFTER_DAYS = 14;   // при первом импорте старое уходит в архив сразу

export const slugOf = abs => abs.replace(/[/.]/g, '-');
export const sessionsDir = abs => path.join(CLAUDE_PROJECTS, slugOf(abs));

// Что лежит в папке проекта у Claude: id, размер, время
export function listSessions(projectPath) {
  const dir = sessionsDir(projectPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
    try {
      const st = fs.statSync(path.join(dir, n));
      if (st.size < 200) continue;
      out.push({ id: n.slice(0, -6), file: path.join(dir, n), size: st.size, mtime: st.mtimeMs });
    } catch { }
  }
  return out;
}

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
const isNoise = t => !t || t.startsWith('<') || /^\/[a-z]/i.test(t.trim()) || /^\[Request interrupted/.test(t);
// служебные ответы CLI на слэш-команды — не часть разговора
const SERVICE = /^(No response requested\.?|\(no content\)|Context Usage)/i;

// Читает файл с позиции offset, возвращает разобранные сообщения и новую позицию
export async function readSession(file, offset = 0) {
  const st = fs.statSync(file);
  if (st.size <= offset) return { messages: [], offset: st.size, meta: null };
  const stream = fs.createReadStream(file, { start: offset, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const messages = [];
  const meta = { prompts: 0, model: null, firstPrompt: null, lastTs: 0, cost: 0, ctxUsed: 0 };
  let consumed = offset, lastLineEnd = offset;

  for await (const line of rl) {
    consumed += Buffer.byteLength(line, 'utf8') + 1;
    const t = line.trim();
    if (!t.startsWith('{')) { lastLineEnd = consumed; continue; }
    let d; try { d = JSON.parse(t); } catch { continue; }     // недописанная строка — остановимся до неё
    lastLineEnd = consumed;
    if (d.isSidechain) continue;                               // субагенты не показываем
    const ts = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (ts) meta.lastTs = Math.max(meta.lastTs, ts);

    if (d.type === 'user') {
      const c = d.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') {
            const txt = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
            messages.push({ role: 'tool', kind: 'tool_result', text: txt.slice(0, MAX_TEXT),
              json: { tool_use_id: b.tool_use_id, is_error: !!b.is_error, truncated: txt.length > MAX_TEXT }, ts });
          } else if (b.type === 'text' && !isNoise(b.text)) {
            meta.prompts++; meta.firstPrompt ??= b.text;
            messages.push({ role: 'user', kind: 'text', text: b.text, ts });
          }
        }
      } else if (typeof c === 'string' && !isNoise(c)) {
        meta.prompts++; meta.firstPrompt ??= c;
        messages.push({ role: 'user', kind: 'text', text: c, ts });
      }
    } else if (d.type === 'assistant') {
      // в сессиях попадаются служебные ответы с model "<synthetic>" — это не модель
      if (d.message?.model && !d.message.model.startsWith('<')) meta.model = d.message.model;
      // сколько весил промпт этого ответа — это и есть контекст разговора на тот момент
      const u = d.message?.usage;
      if (u) {
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (used > 0) meta.ctxUsed = used;
      }
      for (const b of d.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim() && !SERVICE.test(b.text.trim()))
          messages.push({ role: 'assistant', kind: 'text', text: b.text, ts });
        else if (b.type === 'tool_use') messages.push({ role: 'tool', kind: 'tool_use', text: toolLabel(b),
          json: { id: b.id, name: b.name, input: b.input }, ts });
      }
    }
  }
  return { messages, offset: lastLineEnd, meta };
}

function toolLabel(b) {
  const i = b.input ?? {};
  const one = i.file_path || i.path || i.command || i.pattern || i.url || i.prompt || i.description;
  return `${b.name}${one ? '  ' + String(one).replace(/\s+/g, ' ').slice(0, 180) : ''}`;
}

// Сколько весил промпт последнего ответа — это и есть контекст разговора.
// Читаем только хвост файла и ничего не импортируем: нужно для чатов,
// которые Depo подобрал из Claude Code и сам ещё не запускал.
const ctxCache = new Map();
export function contextOf(projectPath, chatId) {
  const file = path.join(sessionsDir(projectPath), chatId + '.jsonl');
  let st; try { st = fs.statSync(file); } catch { return 0; }
  const hit = ctxCache.get(chatId);
  if (hit && hit.size === st.size) return hit.used;

  const from = Math.max(0, st.size - 512 * 1024);
  let text = '';
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    text = buf.toString('utf8');
  } finally { fs.closeSync(fd); }
  if (from) text = text.slice(text.indexOf('\n') + 1);

  let used = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain) continue;
    const u = d.message?.usage; if (!u) continue;
    const n = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (n > 0) used = n;
  }
  ctxCache.set(chatId, { size: st.size, used });
  return used;
}

export function deleteChat(h, id) {
  h.run('INSERT INTO deleted_chats(id,deleted_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING', id, Date.now());
  h.run('DELETE FROM chats WHERE id=?', id);
}

// Синхронизирует проект: новые сессии заводит как чаты, у известных дочитывает хвост.
// Список сессий Claude Code этого проекта — для ручного «поднять разговор с ноутбука».
// Читаем только свежие: разбор файла целиком стоит дороже, чем просто список.
export async function previewSessions(h, project, { limit = 25 } = {}) {
  const found = listSessions(project.path).filter(s => !h.get('SELECT 1 FROM deleted_chats WHERE id=?', s.id))
    .sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  const out = [];
  for (const s of found) {
    const chat = h.get('SELECT id, title, turns, archived FROM chats WHERE id=?', s.id);
    if (chat) { out.push({ id: s.id, title: chat.title, turns: chat.turns, mtime: s.mtime, imported: true, archived: !!chat.archived }); continue; }
    try {
      const { meta } = await readSession(s.file, 0);
      if (!meta || !meta.prompts) continue;
      out.push({
        id: s.id, title: meta.firstPrompt.replace(/\s+/g, ' ').slice(0, 72), turns: meta.prompts,
        model: meta.model, mtime: s.mtime, imported: false,
      });
    } catch { }
  }
  return out;
}

export async function syncProject(h, project, { emit, archiveDays = ARCHIVE_AFTER_DAYS, skip = () => false, only = null } = {}) {
  const found = listSessions(project.path).filter(s => (!only || only.includes(s.id)) && !h.get('SELECT 1 FROM deleted_chats WHERE id=?', s.id));
  let added = 0, updated = 0;
  for (const s of found) {
    const chat = h.get('SELECT id, import_offset, title, turns, model, origin FROM chats WHERE id=?', s.id);
    if (chat && chat.import_offset >= s.size) continue;           // ничего нового
    if (chat && skip(chat.id)) continue;                          // ход идёт через Depo — поток уже пишет сам

    const { messages, offset, meta } = await readSession(s.file, chat?.import_offset ?? 0);
    if (!chat) {
      if (!meta || meta.prompts === 0) continue;                   // служебные запуски вроде /usage
      const title = meta.firstPrompt.replace(/\s+/g, ' ').slice(0, 72) + (meta.firstPrompt.length > 72 ? '…' : '');
      const t = meta.lastTs || s.mtime;
      const old = !only && Date.now() - t > archiveDays * 864e5;
      h.run(`INSERT INTO chats(id,project_id,title,provider,model,permission_mode,state,claude_started,turns,origin,import_offset,archived,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        s.id, project.id, title, 'claude', meta.model, 'manual', 'idle', 1, meta.prompts, 'claude', offset, old ? 1 : 0,
        Math.min(...messages.map(m => m.ts).filter(Boolean), t) || t, t);
      if (meta.ctxUsed) h.run('UPDATE chats SET ctx_used=? WHERE id=?', meta.ctxUsed, s.id);
      insertAll(h, s.id, messages);
      added++;
      emit?.('chat', { chat: h.get('SELECT * FROM chats WHERE id=?', s.id), created: true });
    } else {
      if (messages.length) {
        insertAll(h, s.id, messages);
        const t = meta.lastTs || s.mtime;
        h.run(`UPDATE chats SET turns=turns+?, model=COALESCE(?,model), updated_at=MAX(updated_at,?), import_offset=?,
               ctx_used=CASE WHEN ?>0 THEN ? ELSE ctx_used END WHERE id=?`,
          meta.prompts, meta.model, t, offset, meta.ctxUsed, meta.ctxUsed, s.id);
        updated++;
        emit?.('chat', { chat: h.get('SELECT * FROM chats WHERE id=?', s.id) });
        emit?.('chat-appended', { chat_id: s.id, count: messages.length });
      } else {
        h.run('UPDATE chats SET import_offset=? WHERE id=?', offset, s.id);
      }
    }
  }
  return { added, updated, total: found.length };
}

function insertAll(h, chatId, messages) {
  const ins = h.run.bind(h);
  for (const m of messages)
    ins('INSERT INTO messages(chat_id,role,kind,text,json,ts) VALUES(?,?,?,?,?,?)',
      chatId, m.role, m.kind, m.text ?? null, m.json ? JSON.stringify(m.json) : null, m.ts || Date.now());
}

// После хода Depo сам дописал файл — сдвигаем указатель, чтобы не прочитать своё же дважды
export function markOwnProgress(h, chat, projectPath) {
  try {
    const st = fs.statSync(path.join(sessionsDir(projectPath), chat.id + '.jsonl'));
    h.run('UPDATE chats SET import_offset=? WHERE id=?', st.size, chat.id);
  } catch { }
}
