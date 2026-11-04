// Передача чата между провайдерами. Транскрипт наш, поэтому пересобираем
// контекст сами: задача, что уже сделано, какие файлы тронуты, последние ходы.
// Честно: скрытые размышления провайдера не переносятся — их никто не отдаёт.
import { execFileSync } from 'node:child_process';
import { contextFor } from './memory.mjs';

const MAX_CHARS = 7500;      // вся передача целиком
const MAX_TALK = 10;         // последних реплик диалога (без вызовов инструментов)
const MAX_ACTIONS = 8;       // последних действий агента одной строкой
const EDIT_TOOLS = /^(Edit|Write|NotebookEdit|MultiEdit|StrReplaceFile|WriteFile|apply_patch)$/;

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

// Кто работал в чате последним. «Собеседник» (companion) и замеры контекста — не ходы агента:
// после них передача не нужна, иначе контекст пересылается зря и с неверным «от кого».
export function lastAgent(h, chatId) {
  return h.get(`SELECT provider FROM runs WHERE chat_id=? AND provider!='companion' AND status!='context'
                ORDER BY id DESC LIMIT 1`, chatId)?.provider ?? null;
}

function editedFiles(j) {
  if (!EDIT_TOOLS.test(j.name || '')) return [];
  const i = j.input || {};
  if (Array.isArray(i.changes)) return i.changes.map(c => c?.path).filter(Boolean);   // Codex: file_change
  return [i.file_path || i.path].filter(Boolean);
}

// Факты из самой папки, а не со слов прошлого агента: что реально изменено и закоммичено.
export function gitFacts(cwd) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    const status = git('status', '--short', '--untracked-files=normal').split('\n').filter(Boolean);
    const log = git('log', '--oneline', '-3').split('\n').filter(Boolean);
    return { branch, status, log };
  } catch { return null; }
}

export function build(h, chat, fromProvider, toProvider) {
  const rows = h.all(
    `SELECT role,kind,text,json FROM messages WHERE chat_id=? AND role IN ('user','assistant','tool') ORDER BY id`, chat.id);
  if (!rows.length) return null;

  // «(вложения)» — заглушка для хода без текста, это не задача
  const task = rows.find(r => r.role === 'user' && flat(r.text) && !/^\(вложения\)$/.test(flat(r.text)))?.text ?? '';
  const files = new Set();
  const actions = [];
  for (const r of rows) {
    if (r.kind !== 'tool_use') continue;
    let j = null;
    try { j = r.json ? JSON.parse(r.json) : null; } catch { }
    if (j) for (const f of editedFiles(j)) files.add(f);
    const line = flat(r.text);
    if (line) actions.push(line);
  }

  // Диалог отдельно от инструментов: у агентов на одну реплику приходятся десятки вызовов,
  // и «последние N строк» легко состоят из одних ls — без последней просьбы владельца.
  const who = r => r.role === 'user' ? 'Владелец' : nameOf(fromProvider);
  const talk = rows.filter(r => r.kind === 'text' && (r.role === 'user' || r.role === 'assistant') && flat(r.text))
    .slice(-MAX_TALK);

  const head = [
    `# Передача задачи от ${nameOf(fromProvider)} к ${nameOf(toProvider)}`,
    ``,
    `Этот разговор начал другой агент. Его скрытые рассуждения не переносятся — ниже всё, что есть.`,
    ``,
    `## Исходная задача`,
    clip(task, 1000) || '(не записана)',
  ];
  if (chat.cwd) head.push(``, `## Общая память проекта`, clip(contextFor({ path: chat.cwd }, task), 1800));
  if (files.size) {
    const list = [...files];
    head.push(``, `## Файлы, которые уже правились`, ...list.slice(-20).map(f => `- ${f}`));
    if (list.length > 20) head.push(`- …и ещё ${list.length - 20}`);
  }
  const g = chat.cwd ? gitFacts(chat.cwd) : null;
  if (g) {
    head.push(``, `## Фактическое состояние Git (проверено Depo сейчас, ветка ${g.branch})`);
    head.push(g.status.length ? `Незакоммичено (${g.status.length}):` : 'Рабочее дерево чистое.');
    head.push(...g.status.slice(0, 25).map(l => `    ${l}`));
    if (g.status.length > 25) head.push(`    …и ещё ${g.status.length - 25}`);
    if (g.log.length) head.push(`Последние коммиты: ${g.log.map(l => clip(l, 90)).join(' · ')}`);
    head.push(`Сверь это со списком правок выше: верь Git, а не пересказу. Чужие незакоммиченные изменения не откатывай.`);
  }
  if (actions.length) head.push(``, `## Последние действия ${nameOf(fromProvider)}`, ...actions.slice(-MAX_ACTIONS).map(a => `- ${clip(a, 160)}`));
  const tail = [``, `## Что делать дальше`, 'Продолжи с этого места. Если чего-то не хватает — сначала посмотри файлы сам, не переспрашивай по мелочам.'];

  // Бюджет на диалог — то, что осталось; заполняем от свежего к старому, урезается только старое.
  let budget = MAX_CHARS - head.join('\n').length - tail.join('\n').length - 40;
  const lines = [];
  for (let i = talk.length - 1; i >= 0 && budget > 80; i--) {
    const r = talk[i];
    const line = `${who(r)}: ${clip(flat(r.text), Math.min(i === talk.length - 1 ? 1500 : 900, budget - 2))}`;
    lines.unshift(line);
    budget -= line.length + 1;
  }
  if (lines.length < talk.length) lines.unshift('…(более ранние реплики опущены)');

  const text = [...head, ``, `## Последние ходы`, ...lines, ...tail].join('\n');
  return { text, files: [...files], turns: rows.filter(r => r.role === 'user').length };
}

export const nameOf = p => ({ codex: 'Codex', kimi: 'Kimi Code', gemini: 'Gemini CLI' }[p] ?? 'Claude Code');
