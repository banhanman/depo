// Копия переписки в самой папке проекта.
//
// Смысл: база Depo и ночной архив живут отдельно от кода, а владелец хочет, чтобы разговор
// лежал рядом с проектом — открыл папку и прочитал, чем кончилось, без Depo и без базы.
// Пишем обычный markdown: только реплики (кто что сказал), без простыней команд.
//
// Папка `.depo` внутри проекта получает свой `.gitignore` со звёздочкой, поэтому копия
// никогда не попадает в коммиты и не мозолит глаза в `git status`.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DIR = '.depo';
const stamp = ts => new Date(Number(ts)).toLocaleString('ru-RU');
const slug = s => String(s || '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'без названия';
const who = (m, provider) => m.role === 'user' ? 'Владелец'
  : m.role === 'assistant' ? ({ codex: 'Codex', kimi: 'Kimi', gemini: 'Gemini' }[m.provider || provider] ?? 'Claude')
    : m.role === 'handoff' ? 'Передача' : 'Система';

function chatMarkdown(h, chat, project) {
  // автор реплики — провайдер того хода, в котором она родилась (в самих сообщениях его нет)
  const msgs = h.all(
    `SELECT m.role, m.kind, m.text, r.provider AS provider, m.ts
       FROM messages m LEFT JOIN runs r ON r.id = m.run_id
      WHERE m.chat_id=? AND m.role IN ('user','assistant','handoff') AND m.kind IN ('text','')
      ORDER BY m.id`, chat.id);
  const head = [
    `# ${chat.title}`, '',
    `_Проект:_ ${project.name} (${project.path})  `,
    `_Агент:_ ${chat.provider}${chat.model ? ' · ' + chat.model : ''}  `,
    `_Ходов:_ ${chat.turns ?? 0}${chat.cost_usd ? ` · $${Number(chat.cost_usd).toFixed(3)}` : ''}  `,
    `_Обновлён:_ ${stamp(chat.updated_at)}  `,
    `_Копия снята:_ ${stamp(Date.now())}`, '',
    '---', '',
  ];
  const body = msgs.map(m => `### ${who(m, chat.provider)} · ${stamp(m.ts)}\n\n${(m.text || '').trim()}\n`);
  return head.join('\n') + (body.join('\n') || '_Пока ни одной реплики._\n');
}

// Одна папка проекта — один проход: пишем только то, что изменилось с прошлого раза.
export async function snapshotProject(h, project) {
  if (!project?.path || !fs.existsSync(project.path)) return { skipped: 'нет папки' };
  const root = path.join(project.path, DIR);
  const chatsDir = path.join(root, 'chats');
  await fsp.mkdir(chatsDir, { recursive: true });
  // звёздочка прячет копию от git, включая сам .gitignore
  await fsp.writeFile(path.join(root, '.gitignore'), '*\n');

  const chats = h.all('SELECT * FROM chats WHERE project_id=? ORDER BY updated_at DESC', project.id);
  const index = [];
  let written = 0;
  const keep = new Set();
  for (const c of chats) {
    const file = `${slug(c.title)} · ${String(c.id).slice(0, 8)}.md`;
    keep.add(file);
    index.push({ id: c.id, title: c.title, provider: c.provider, turns: c.turns, archived: !!c.archived, updated_at: c.updated_at, file });
    const full = path.join(chatsDir, file);
    const md = chatMarkdown(h, c, project);
    let old = null;
    try { old = await fsp.readFile(full, 'utf8'); } catch { }
    // «копия снята» меняется каждый раз — сравниваем всё, кроме этой строки
    const strip = s => String(s).replace(/^_Копия снята:_.*$/m, '');
    if (old !== null && strip(old) === strip(md)) continue;
    await fsp.writeFile(full, md);
    written++;
  }
  // чаты, удалённые в Depo, не должны оставаться в папке навсегда
  for (const f of await fsp.readdir(chatsDir).catch(() => [])) {
    if (f.endsWith('.md') && !keep.has(f)) await fsp.rm(path.join(chatsDir, f), { force: true });
  }
  await fsp.writeFile(path.join(root, 'index.json'), JSON.stringify({ project: project.name, path: project.path, at: Date.now(), chats: index }, null, 2));
  await fsp.writeFile(path.join(root, 'README.md'),
    `# Копия чатов Depo\n\nЗдесь лежит переписка по проекту **${project.name}**: по файлу на чат, только реплики.\n` +
    `Папку делает сам Depo после каждого хода; править её руками бессмысленно — перезапишет.\n` +
    `Git её не видит: рядом лежит .gitignore со звёздочкой.\n`);
  return { chats: chats.length, written };
}
