import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const FILES = ['PROJECT_CONTEXT.md', 'ARCHITECTURE.md', 'DECISIONS.md', 'WORKLOG.md', 'CURRENT_STATE.md', 'DEPLOYMENT.md', 'AGENT_RULES.md'];
const DIR = path.join('.depo', 'memory');
const START = '<!-- DEPO:MEMORY START -->';
const END = '<!-- DEPO:MEMORY END -->';
const SOURCES = ['README.md', 'README.ru.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'ARCHITECTURE.md', 'DEPLOYMENT.md', 'CONTRIBUTING.md'];
const clip = (s, n = 1800) => String(s || '').trim().slice(0, n);
const read = (root, name, n = 12000) => {
  try { return fs.readFileSync(path.join(root, name), 'utf8').slice(0, n); } catch { return ''; }
};
const writeNew = (root, name, text) => {
  const file = path.join(root, DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
};
const plain = text => text.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').trim();
const replaceManaged = (text, body) => {
  const block = `${START}\n${body.trim()}\n${END}`;
  const re = new RegExp(`${START.replace(/[.*]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*]/g, '\\$&')}`);
  return re.test(text) ? text.replace(re, block) : text.trimEnd() + (text.trim() ? '\n\n' : '') + block + '\n';
};

function gitLog(root) {
  try {
    return execFileSync('git', ['-C', root, 'log', '-8', '--pretty=format:%h %s'], { timeout: 5000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch { return ''; }
}

function syncAgents(project) {
  const memoryText = (name, limit) => clip(read(project.path, path.join(DIR, name)).replaceAll(START, '').replaceAll(END, ''), limit);
  const body = [
    '## Общая память Depo',
    memoryText('PROJECT_CONTEXT.md', 800),
    memoryText('AGENT_RULES.md', 1200),
    memoryText('CURRENT_STATE.md', 2000),
    memoryText(LESSONS, 2600),
    'Подробности в .depo/memory читай выборочно. Исходные инструкции сохраняют силу; при противоречии проверяй текущий код и отмечай спорное.',
  ].filter(Boolean).join('\n\n');
  const agents = read(project.path, 'AGENTS.md', 200000);
  fs.writeFileSync(path.join(project.path, 'AGENTS.md'), replaceManaged(agents, body));
  // Claude Code читает CLAUDE.md: если он в проекте есть — подключаем ту же память импортом, текст владельца не трогаем
  const claude = read(project.path, 'CLAUDE.md', 200000);
  if (claude && !/^@AGENTS\.md\b/m.test(claude.replace(new RegExp(`${START}[\\s\\S]*?${END}`), '')))
    fs.writeFileSync(path.join(project.path, 'CLAUDE.md'), replaceManaged(claude, '@AGENTS.md — общая память Depo для всех агентов (обновляется автоматически).'));
}

// ─────────── уроки: что команда и владелец просили помнить в этом проекте ───────────
export const LESSONS = 'LESSONS.md';
const MAX_LESSONS = 40;
const lessonKey = t => t.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();

// Из ответа агента: блок «УРОКИ:» и до трёх строк-пунктов после него. «нет»/«—» — уроков нет.
export function parseLessons(text) {
  const m = String(text || '').match(/(?:^|\n)\s*\**УРОКИ\**\s*:\s*([^\n]*)((?:\n[ \t]*(?:[-•*]|\d+[.)])[^\n]*)*)/i);
  if (!m) return [];
  return [m[1], ...m[2].split('\n')]
    .map(x => x.replace(/^[\s*•-]*(?:\d+[.)]\s*)?/, '').replace(/\s+/g, ' ').trim())
    .filter(x => x && !/^(нет|—|-|ничего|пусто)\.?$/i.test(x))
    .slice(0, 3).map(x => x.slice(0, 300));
}
const lessonLines = root => read(root, path.join(DIR, LESSONS), 100000).split('\n').filter(x => x.startsWith('- '));
export function addLessons(project, lines, who = 'команда', now = new Date()) {
  const add = (lines || []).map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!add.length) return 0;
  ensure(project);
  const have = lessonLines(project.path);
  const seen = new Set(have.map(x => lessonKey(x.replace(/^- [^:]*?: /, ''))));
  const date = now.toISOString().slice(0, 10);
  let n = 0;
  for (const t of add) { const k = lessonKey(t); if (!k || seen.has(k)) continue; seen.add(k); have.push(`- ${date} · ${who}: ${t}`); n++; }
  if (!n) return 0;
  fs.writeFileSync(path.join(project.path, DIR, LESSONS),
    '# Уроки проекта\n\nЧто владелец и команда попросили помнить. Новые — внизу, старше ' + MAX_LESSONS + ' строк вытесняются.\n\n' + have.slice(-MAX_LESSONS).join('\n') + '\n');
  syncAgents(project);
  return n;
}

export function init(project) {
  const root = project.path;
  fs.mkdirSync(path.join(root, DIR), { recursive: true });
  const ignore = path.join(root, '.depo', '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');

  const found = SOURCES.filter(name => read(root, name));
  const overview = found.map(name => `### ${name}\n${clip(plain(read(root, name)), name === 'README.md' || name === 'README.ru.md' ? 1200 : 500)}`).join('\n\n');
  let pkg = null;
  try { pkg = JSON.parse(read(root, 'package.json', 100000)); } catch { }
  const top = fs.readdirSync(root, { withFileTypes: true }).filter(x => !x.name.startsWith('.') && !['node_modules', 'data'].includes(x.name)).slice(0, 30).map(x => x.name + (x.isDirectory() ? '/' : ''));
  const scripts = Object.keys(pkg?.scripts ?? {});
  const history = gitLog(root);

  writeNew(root, 'PROJECT_CONTEXT.md', `# Контекст проекта\n\nПроект: ${project.name}. Папка: ${root}.\n\n${overview || 'Исходная документация не найдена; сведения нужно подтверждать кодом.'}\n`);
  writeNew(root, 'ARCHITECTURE.md', `# Архитектура\n\nПодтверждено содержимым папки на момент импорта:\n\n${top.map(x => `- ${x}`).join('\n') || '- папка пуста'}\n\nПодробности читать в текущем коде; этот импорт не заменяет его.\n`);
  writeNew(root, 'DECISIONS.md', `# Решения\n\n## История Git для первичного изучения\n\nСтарые записи не считать автоматически актуальными.\n\n${history || 'История недоступна.'}\n\nПодтверждённые решения и их причины добавляются после изменений, а не по намерениям агента.\n`);
  writeNew(root, 'WORKLOG.md', '# История существенных изменений\n\nЗаписываются только завершённые наблюдаемые ходы Depo.\n');
  writeNew(root, 'CURRENT_STATE.md', `# Текущее состояние\n\n${START}\nАктивных задач при импорте не записано. Проверяй текущий Git-статус и код.\n${END}\n`);
  writeNew(root, 'DEPLOYMENT.md', `# Проверка и публикация\n\n${scripts.length ? `Команды package.json: ${scripts.map(x => `\`${x}\``).join(', ')}.` : 'package.json не найден.'}\n\nПубликация только после успешной сборки, тестов и проверки связанных маршрутов. Проектные команды задаются в .depo/checks.json.\n`);
  writeNew(root, 'AGENT_RULES.md', `# Общие правила агентов\n\n- Не ломать работающее и не переписывать архитектуру без необходимости.\n- Перед изменением проверять зависимости, Git-статус и существующие тесты.\n- Не перезаписывать чужие изменения и не удалять пользовательские данные.\n- После изменения выполнять профильные и общие проверки.\n- Подробности: PROJECT_CONTEXT.md, ARCHITECTURE.md, DECISIONS.md, DEPLOYMENT.md; читать только при необходимости.\n${found.filter(x => /^(AGENTS|CLAUDE|GEMINI)\.md$/.test(x)).map(x => `- Исходные инструкции сохранены: ${x}`).join('\n')}\n`);

  syncAgents(project);
  return { path: path.join(root, DIR), sources: found };
}

export const ensure = project => fs.existsSync(path.join(project.path, DIR))
  ? { path: path.join(project.path, DIR), sources: [] } : init(project);

export function contextFor(project, task = '') {
  ensure(project);
  const parts = [
    ['PROJECT_CONTEXT.md', 1600],
    ['AGENT_RULES.md', 1500],
    ['CURRENT_STATE.md', 2200],
    [LESSONS, 2000],
  ].map(([name, limit]) => `## ${name}\n${clip(read(project.path, path.join(DIR, name)), limit)}`);
  const lower = String(task).toLowerCase();
  for (const name of ['ARCHITECTURE.md', 'DECISIONS.md', 'DEPLOYMENT.md']) {
    const text = read(project.path, path.join(DIR, name));
    const words = name.split('.')[0].toLowerCase();
    if ((lower.includes('deploy') || lower.includes('публ')) && name === 'DEPLOYMENT.md'
      || (lower.includes('архитект') || lower.includes('структур')) && name === 'ARCHITECTURE.md'
      || lower.includes(words)) parts.push(`## ${name}\n${clip(text, 900)}`);
  }
  return `# Общая память проекта\n\nЭто локальные сведения Depo. Проверяй их по коду; подробности читай в указанных файлах выборочно.\n\n${parts.join('\n\n')}`.slice(0, 7000);
}

export function runFacts(h, runId) {
  const messages = h.all('SELECT role,kind,text,json FROM messages WHERE run_id=? ORDER BY id', runId);
  const files = new Set(), tests = new Map();
  for (const m of messages) {
    let j = {}; try { j = m.json ? JSON.parse(m.json) : {}; } catch { }
    if (m.kind === 'tool_use') {
      if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(j.name || '')) {
        const file = j.input?.file_path || j.input?.path;
        if (file) files.add(file);
      }
      const command = j.input?.command || '';
      if (/(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test|node\s+--test|pytest|go\s+test|cargo\s+test/.test(command)) tests.set(j.id || command, { command, result: null });
    } else if (m.kind === 'tool_result' && tests.has(j.tool_use_id)) {
      tests.get(j.tool_use_id).result = j.is_error ? 'ошибка' : 'успешно';
    }
  }
  return { files: [...files].slice(0, 30), tests: [...tests.values()] };
}

export function recordRun(h, runId) {
  const run = h.get(`SELECT r.*,c.title,c.project_id,p.name AS project_name,p.path AS project_path
                     FROM runs r JOIN chats c ON c.id=r.chat_id JOIN projects p ON p.id=c.project_id WHERE r.id=?`, runId);
  if (!run || !fs.existsSync(run.project_path)) return null;
  const project = { id: run.project_id, name: run.project_name, path: run.project_path };
  ensure(project);
  const facts = runFacts(h, runId);
  const stamp = new Date(run.ended_at || Date.now()).toLocaleString('ru-RU');
  const testText = facts.tests.length ? facts.tests.map(t => `- ${t.command} — ${t.result || 'результат не подтверждён'}`).join('\n') : '- Тесты в событиях хода не наблюдались.';
  const pending = h.all("SELECT text FROM queued_messages WHERE chat_id IN (SELECT id FROM chats WHERE project_id=?) AND status='pending' ORDER BY id LIMIT 10", project.id);
  const queueText = pending.length ? `\n\n## Очередь задач\n${pending.map(x => `- ${clip(x.text, 200)}`).join('\n')}` : '';
  const body = `## Последний ход: ${stamp}\n\n- Задача: ${run.title}\n- Агент: ${run.provider}; результат: ${run.status}\n- Изменённые файлы (по событиям инструментов):\n${facts.files.length ? facts.files.map(x => `  - ${x}`).join('\n') : '  - не зафиксированы'}\n- Проверки:\n${testText}\n${run.error ? `- Ошибка: ${clip(run.error, 500)}` : ''}${queueText}`;
  const currentFile = path.join(project.path, DIR, 'CURRENT_STATE.md');
  fs.writeFileSync(currentFile, replaceManaged(read(project.path, path.join(DIR, 'CURRENT_STATE.md'), 100000), body));
  syncAgents(project);

  const entry = `\n## ${stamp} · ${run.title}\n\n- Результат: ${run.status}; агент: ${run.provider}.\n${facts.files.length ? `- Файлы: ${facts.files.join(', ')}.\n` : ''}${facts.tests.length ? `- Проверки: ${facts.tests.map(t => `${t.command} (${t.result || 'не подтверждено'})`).join('; ')}.\n` : ''}${run.error ? `- Ошибка: ${clip(run.error, 300)}.\n` : ''}`;
  const worklog = path.join(project.path, DIR, 'WORKLOG.md');
  fs.appendFileSync(worklog, entry);
  const content = fs.readFileSync(worklog, 'utf8');
  if (content.length > 40000) fs.writeFileSync(worklog, '# История существенных изменений\n' + content.slice(-36000));
  return facts;
}
