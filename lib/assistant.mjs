import fs from 'node:fs';
import { redact } from './companion.mjs';
import { gitFacts, nameOf } from './handoff.mjs';
import { runFacts } from './memory.mjs';

const flat = s => redact(String(s || '')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const when = ts => {
  if (!ts) return '—';
  const d = Date.now() - ts, day = 864e5;
  const t = new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return d < 3600e3 ? `${Math.max(1, Math.round(d / 60e3))} мин назад` : d < day ? `${Math.round(d / 3600e3)} ч назад (${t})` : `${Math.round(d / day)} дн. назад (${t})`;
};
const STATUS = { done: 'закончен', error: 'упал', cancelled: 'остановлен', running: 'идёт сейчас' };

function chatBrief(h, c, { turns = 2, per = 400 } = {}) {
  const runs = h.all(`SELECT * FROM runs WHERE chat_id=? AND provider!='companion' AND status!='context' ORDER BY id DESC LIMIT ?`, c.id, turns);
  const lines = [`  • Чат «${clip(flat(c.title) || 'без названия', 70)}» [чат ${c.id.slice(0, 8)}] — ${nameOf(c.provider)}, ${when(c.updated_at)}${c.state === 'attention' ? ', ЖДЁТ ОТВЕТА владельца' : ''}`];
  for (const r of runs.reverse()) {
    const ask = h.get(`SELECT text FROM messages WHERE run_id=? AND role='user' AND kind='text' ORDER BY id LIMIT 1`, r.id)?.text;
    const ans = h.get(`SELECT text FROM messages WHERE run_id=? AND role='assistant' AND kind='text' ORDER BY id DESC LIMIT 1`, r.id)?.text;
    let files = [];
    try { files = runFacts(h, r.id).files; } catch { }
    lines.push(`    – ход ${when(r.started_at)}: ${STATUS[r.status] ?? r.status}${r.error ? ` (${clip(flat(r.error), 120)})` : ''}` +
      (files.length ? `; правки: ${files.slice(0, 6).map(f => f.split('/').slice(-2).join('/')).join(', ')}${files.length > 6 ? ` и ещё ${files.length - 6}` : ''}` : ''));
    if (ask) lines.push(`      просьба: ${clip(flat(ask), per)}`);
    if (ans) lines.push(`      итог агента: ${clip(flat(ans), per)}`);
  }
  const q = h.get(`SELECT COUNT(*) n FROM queued_messages WHERE chat_id=? AND status='pending'`, c.id)?.n;
  if (q) lines.push(`    – в очереди ещё ${q} сообщ.`);
  return lines.join('\n');
}

function projectBrief(h, p, { chats = 3, turns = 2, per = 400, git = true } = {}) {
  const list = h.all(`SELECT * FROM chats WHERE project_id=? AND archived=0 ORDER BY updated_at DESC LIMIT ?`, p.id, chats);
  const head = `■ Проект «${p.name}» [проект ${p.id}] (${p.path.replace(/^\/home\/[^/]+/, '~')})`;
  if (!list.length) return `${head}: чатов пока нет.`;
  const out = [`${head} — последняя активность ${when(list[0].updated_at)}`];
  if (git && fs.existsSync(p.path)) {
    const g = gitFacts(p.path);
    if (g) out.push(`  git (${g.branch}): ${g.status.length ? `незакоммичено ${g.status.length} файл(ов)` : 'всё закоммичено'}${g.log[0] ? `; последний коммит: ${clip(g.log[0], 90)}` : ''}`);
  }
  for (const c of list) out.push(chatBrief(h, c, { turns, per }));
  return out.join('\n');
}

export function digest(h, scope = 'all', { max = 9000 } = {}) {
  let text, label;
  if (scope?.chat) {
    const c = h.get('SELECT * FROM chats WHERE id=?', scope.chat);
    const p = c && h.get('SELECT * FROM projects WHERE id=?', c.project_id);
    if (!c || !p) return { text: 'Чат не найден.', label: 'чат' };
    label = `чат «${clip(c.title, 40)}»`;
    text = `Разговор про один чат проекта «${p.name}».\n` + chatBrief(h, c, { turns: 5, per: 900 });
  } else if (scope?.project) {
    const p = h.get('SELECT * FROM projects WHERE id=?', scope.project);
    if (!p) return { text: 'Проект не найден.', label: 'проект' };
    label = p.name;
    text = projectBrief(h, p, { chats: 6, turns: 3, per: 600 });
  } else {
    label = 'все проекты';
    const ps = h.all(`SELECT p.*, (SELECT MAX(updated_at) FROM chats c WHERE c.project_id=p.id AND c.archived=0) act
                      FROM projects p WHERE p.archived=0 ORDER BY act DESC NULLS LAST`);
    const running = h.all(`SELECT c.title, p.name FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.state='running'`);
    const waiting = h.all(`SELECT c.title, p.name FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.state='attention' AND c.archived=0`);
    const head = [`Сейчас ${new Date().toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`,
      running.length ? `Работают сейчас: ${running.map(r => `${r.name} — «${clip(r.title, 50)}»`).join('; ')}.` : 'Сейчас ни один агент не работает.',
      waiting.length ? `Ждут ответа владельца: ${waiting.map(r => `${r.name} — «${clip(r.title, 50)}»`).join('; ')}.` : ''].filter(Boolean);
    const blocks = ps.map((p, i) => projectBrief(h, p, i < 4 ? { chats: 3, turns: 2, per: 350 } : { chats: 1, turns: 1, per: 200, git: i < 8 }));
    text = [...head, '', ...blocks].join('\n');
  }
  if (text.length > max) text = text.slice(0, max - 40) + '\n…(дальше сокращено)';
  return { text, label };
}

const SEND_RULE = `Отправить задачу в чат ты можешь, но ТОЛЬКО когда владелец прямо попросил отправить, передать или поставить задачу
(«отправь в этот чат», «закинь ТЗ в чат про бота», «поставь задачу в новый чат проекта»). Тогда сформулируй ТЗ от лица владельца,
как будто он сам пишет агенту: цель, что сделать по шагам, ограничения, как проверить результат, — по существу разговора, без воды.
Добавь в конец ответа блок (адрес бери из сводки: [чат xxxxxxxx] — существующий чат, [проект N] — новый чат в проекте):
<<<SEND chat=xxxxxxxx>>>
текст ТЗ
<<<END>>>
или для нового чата: <<<SEND project=N>>> … <<<END>>>. «Этот чат» — тот, про который разговор. Вне блока одной фразой скажи, куда отправляешь.
Если непонятно, в какой чат, — не отправляй, а переспроси. Без прямой просьбы владельца блок не добавляй никогда.`;

export const ROLE = `Ты — ассистент Depo, панели, через которую владелец ведёт проекты с агентами Claude Code, Codex и Kimi.
Отвечаешь на его вопросы о проектах: что сделано, что осталось, как что устроено, что где настроено.
Сначала опирайся на сводку Depo ниже — это факты о ходах агентов. Если ответа в ней нет — ищи сам в проекте:
читай файлы (README, AGENTS.md, .depo/memory, конфиги, скрипты), смотри git log/status, systemd-таймеры и службы,
crontab, docker-compose — всё, что поможет ответить. Ты работаешь ТОЛЬКО НА ЧТЕНИЕ: ничего не меняй, не правь файлы,
не коммить, не перезапускай службы, не устанавливай пакеты.
Отвечай по-русски, коротко и по делу — ответ будет прочитан вслух: две-пять фраз, без списков, разметки и длинных путей.
Если и в проекте ответа нет — честно скажи, что не нашёл, и где стоит посмотреть. Не предлагай что-то поменять сам — ты только рассказываешь.
${SEND_RULE}`;

export const VOICE_ROLE = `Ты — голосовой ассистент Depo. Владелец говорит с тобой по-русски о своих проектах.
Говори по-русски, тепло и коротко. На приветствия и простые реплики отвечай сам.
На ЛЮБОЙ вопрос о проектах, коде, настройках, бэкапах, серверах, задачах, «что сделано / что осталось» — не гадай:
сразу передай вопрос агенту (делегируй) и скажи владельцу одной короткой фразой, что смотришь. Агент видит сводку Depo
и файлы проекта на чтение. Когда придёт его ответ — перескажи его своими словами, коротко и живо, без чтения путей и кода.
Ты сам ничего не меняешь и не запускаешь — и не предлагай «могу поменять»: ты рассказываешь, а менять владелец попросит агента в чате.
Если владелец просит отправить, передать или поставить задачу (ТЗ) в чат — тоже передай это агенту, дословно и вместе с тем,
о чём договорились в разговоре: он сформулирует ТЗ, а Depo отправит его в чат. Служебный блок <<<SEND …>>> в ответе агента
никогда не зачитывай — просто скажи, в какой чат ушла задача.`;

export function instructions(h, scope) {
  const d = digest(h, scope);
  const facts = `Тема разговора: ${d.label}.\n\nСводка Depo:\n${d.text}`;
  return {
    label: d.label,
    voice: `${VOICE_ROLE}\n\n${facts}`,
    agent: `${ROLE}\n\n${facts}`,
    facts,
  };
}

const SEND_RE = /<<<SEND\s+(chat|project)=([\w-]+)\s*>>>\n?([\s\S]*?)\n?<<<END>>>/g;
export function extractSends(text) {
  const sends = [];
  const rest = String(text || '').replace(SEND_RE, (_, kind, addr, task) => {
    const t = task.trim().slice(0, 12000);
    if (t && sends.length < 3) sends.push({ chat: kind === 'chat' ? addr : null, project: kind === 'project' ? +addr || null : null, task: t });
    return '';
  });
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), sends };
}

export const wantsSend = text => /отправ|передай|перешли|закинь|скинь|кинь|поставь\s+задач|дай\s+задач|отдай|в\s+(?:этот|тот|новый|другой)\s+чат/i.test(String(text || ''));

export function resolveTarget(h, short) {
  const k = String(short || '').toLowerCase();
  if (!/^[0-9a-f-]{8,36}$/.test(k)) return null;
  const rows = h.all("SELECT id FROM chats WHERE id LIKE ? AND archived=0", k + '%');
  return rows.length === 1 ? rows[0].id : null;
}
