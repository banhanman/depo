const MAX_TAIL = 14;
const MAX_CHARS = 7000;

export function build(h, chat, fromProvider, toProvider) {
  const rows = h.all(
    `SELECT role,kind,text,json FROM messages WHERE chat_id=? AND role IN ('user','assistant','tool') ORDER BY id`, chat.id);
  if (!rows.length) return null;

  const task = rows.find(r => r.role === 'user')?.text ?? '';
  const files = new Set();
  for (const r of rows) {
    if (r.kind !== 'tool_use' || !r.json) continue;
    try {
      const j = JSON.parse(r.json);
      if (!/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(j.name || '')) continue;
      const f = j.input?.file_path || j.input?.path;
      if (f) files.add(f);
    } catch { }
  }

  const tail = [];
  for (const r of rows.slice(-MAX_TAIL)) {
    if (r.kind === 'thinking') continue;
    const who = r.role === 'user' ? 'Владелец' : r.role === 'assistant' ? nameOf(fromProvider) : 'Инструмент';
    const body = (r.text || '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    tail.push(`${who}: ${body.slice(0, 700)}`);
  }

  let block = [
    `# Передача задачи от ${nameOf(fromProvider)} к ${nameOf(toProvider)}`,
    ``,
    `Этот разговор начал другой агент. Его скрытые рассуждения не переносятся — ниже всё, что есть.`,
    ``,
    `## Исходная задача`,
    task.slice(0, 1200) || '(не записана)',
  ];
  if (files.size) {
    block.push(``, `## Файлы, которые уже правились`, ...[...files].slice(0, 30).map(f => `- ${f}`));
  }
  block.push(``, `## Последние ходы`, ...tail);
  block.push(``, `## Что делать дальше`, 'Продолжи с этого места. Если чего-то не хватает — сначала посмотри файлы сам, не переспрашивай по мелочам.');

  let text = block.join('\n');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…(передача урезана)';
  return { text, files: [...files], turns: rows.filter(r => r.role === 'user').length };
}

export const nameOf = p => (p === 'codex' ? 'Codex' : 'Claude Code');
