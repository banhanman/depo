import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { open, helpers } from '../lib/db.mjs';

process.env.DEPO_BG_GRACE_MS = '150';
const { Runner, phaseForTool } = await import('../lib/runner.mjs');

const waitFor = async (fn, ms = 4000) => {
  for (let i = 0; i < ms / 20; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Не дождались');
};

const fakeClaude = bin => fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const out = o => console.log(JSON.stringify(o));
let buf = '', q = [], busy = false, bg = null;
const BG_MS = +process.env.FAKE_BG_MS;
const bgEnd = status => {
  out({ type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: status === 'stopped' ? 'killed' : 'completed', end_time: Date.now() } });
  out({ type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'tu1', status, summary: 'итог разбора', usage: { total_tokens: 1234, tool_uses: 1 } });
  out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
};
const turn = () => {
  if (busy || !q.length) return;
  busy = true;
  const m = q.shift();
  if (!m.notify) out({ type: 'user', isReplay: true, message: m.message });
  const text = m.notify ? '' : m.message.content[0].text;
  setTimeout(() => {
    if (m.notify) out({ type: 'assistant', message: { content: [{ type: 'text', text: 'фон готов' }] } });
    else if (text.startsWith('START')) {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Разбор', run_in_background: true } }] } });
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'Разбор' }] });
      out({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'tu1', description: 'Разбор', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Async agent launched' }] } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'запустил' }] } });
      bg = setTimeout(() => { bg = null; bgEnd('completed'); q.unshift({ notify: true }); turn(); }, BG_MS);
      setTimeout(() => {
        out({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'Субагент думает вслух' }, { type: 'tool_use', id: 's1', name: 'Edit', input: { file_path: 'a.txt' } }, { type: 'tool_use', id: 's2', name: 'Bash', input: { command: 'npm test' } }] } });
        out({ type: 'user', parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'промпт помощника' }] } });
        out({ type: 'user', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'ok' }, { type: 'tool_result', tool_use_id: 's2', content: 'pass 3' }] } });
        out({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'Running npm test', last_tool_name: 'Bash', usage: { total_tokens: 900, tool_uses: 2 } });
        out({ type: 'user', isReplay: false, message: { content: [{ type: 'text', text: 'служебное сообщение CLI' }] } });
      }, 30);
    } else out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ответ на: ' + text }] } });
    out({ type: 'result', usage: {}, is_error: false });
    busy = false; turn();
  }, 40);
};
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l) continue;
    const m = JSON.parse(l);
    if (m.type === 'control_request') {
      if (bg) { clearTimeout(bg); bg = null; bgEnd('stopped'); }
      out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
      continue;
    }
    q.push(m); turn();
  }
});
process.stdin.on('end', () => { const w = setInterval(() => { if (!busy && !q.length && !bg) { clearInterval(w); process.exit(0); } }, 20); });
`, { mode: 0o755 });

const setup = (t, bgMs) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bg-tasks-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fakeClaude(bin);
  const db = open(path.join(root, 'data')), h = helpers(db);
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', root, 'TE', 1);
  const id = crypto.randomUUID();
  h.run('INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES(?,?,?,?,?)', id, 1, 'claude', 1, 1);
  const events = [];
  const runner = new Runner({ h, hub: { send: (type, d) => events.push({ type, ...d }) }, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_BG_MS: String(bgMs) }, root });
  t.after(() => { runner.cancel(id); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  runner.start({ id, provider: 'claude', cwd: root, permission_mode: 'acceptEdits' }, 'START');
  const texts = () => h.all("SELECT text FROM messages WHERE chat_id=? AND role='assistant' AND kind='text' ORDER BY id", id).map(r => r.text);
  return { h, id, runner, events, texts };
};

test('фон: после ответа вход открыт — сообщение уходит агенту сразу, а не в очередь после помощников', async t => {
  const { h, id, runner, events, texts } = setup(t, 700);
  await waitFor(() => texts().includes('запустил'));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(runner.canWrite(id), true, 'пока фон идёт, писать можно');
  assert.equal(h.get('SELECT phase FROM runs WHERE chat_id=?', id).phase, 'Работают фоновые задачи');
  const m = runner.save(id, null, 'user', 'text', 'Вопрос', { steer: 'sent' });
  assert.equal(runner.write(id, 'Вопрос', [], { msgId: m.id }), true);
  await waitFor(() => texts().includes('ответ на: Вопрос'), 600);
  assert.equal(runner.isRunning(id), true);
  const after = events.slice(events.findIndex(e => e.type === 'message-patch' && e.id === m.id));
  assert.ok(after.some(e => e.type === 'run-progress' && e.run?.phase === 'Анализирует код'), 'агент снова работает — фаза ожидания снята');
  await waitFor(() => !runner.isRunning(id));
  assert.deepEqual(texts(), ['запустил', 'ответ на: Вопрос', 'фон готов']);
  assert.equal(JSON.parse(h.get('SELECT json FROM messages WHERE id=?', m.id).json).steer, 'accepted');
  assert.equal(h.get('SELECT status FROM runs WHERE chat_id=?', id).status, 'done');
});

test('фон: шаги помощника не становятся репликами главного агента и видны в карточке задачи', async t => {
  const { h, id, runner, events, texts } = setup(t, 300);
  await waitFor(() => !runner.isRunning(id));
  assert.ok(!texts().includes('Субагент думает вслух'));
  const lists = events.filter(e => e.type === 'tasks').map(e => e.tasks);
  const sub = h.all("SELECT json FROM messages WHERE chat_id=? AND role='tool'", id).map(r => JSON.parse(r.json)).filter(j => j.parent === 'tu1');
  assert.deepEqual(sub.map(j => j.name ?? 'result:' + j.tool_use_id), ['Edit', 'Bash', 'result:s2'], 'вызовы помощника — с пометкой parent; из результатов храним только тесты');
  assert.ok(lists.flat().filter(x => x.id === 't1').every(x => x.desc === 'Разбор'), 'прогресс не переписывает название задачи');
  const done = lists.flat().findLast(x => x.id === 't1' && x.status === 'done');
  assert.ok(done, 'задача дошла до «готово»');
  assert.equal(done.summary, 'итог разбора');
  assert.equal(done.agent, 'general-purpose');
  assert.ok(!('tool_use_id' in done));
  assert.ok(lists.flat().some(x => x.id === 't1' && /Субагент думает вслух|Edit|npm test|Bash/.test(x.last || '')), 'последнее действие помощника видно в карточке');
  assert.deepEqual(lists.at(-1), [], 'ход кончился — список очищен');
  assert.deepEqual(runner.tasks(id), []);
});

test('фон: остановка одной задачи; без нового хода процесс отпускается сам', async t => {
  const { h, id, runner, events, texts } = setup(t, 20000);
  await waitFor(() => texts().includes('запустил'));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(runner.tasks(id)[0].status, 'running');
  assert.equal(runner.stopTask(id, 'нет-такой'), false);
  assert.equal(runner.stopTask(id, 't1'), true);
  await waitFor(() => !runner.isRunning(id), 3000);
  assert.ok(events.some(e => e.type === 'tasks' && e.tasks.some(x => x.id === 't1' && x.status === 'stopped')));
  assert.equal(h.get('SELECT status FROM runs WHERE chat_id=?', id).status, 'done');
});

test('фаза: вызов помощников называется понятно', () => {
  assert.equal(phaseForTool({ name: 'Agent' }), 'Работают помощники');
  assert.equal(phaseForTool({ name: 'Workflow' }), 'Работают помощники');
  assert.equal(phaseForTool({ name: 'Read' }), 'Изучает проект');
});
