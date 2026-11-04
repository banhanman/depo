import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import * as memory from '../lib/memory.mjs';
import * as handoff from '../lib/handoff.mjs';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-memory-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { id: 1, name: 'Test', path: root };
}

test('память создаёт полный набор и не переписывает исходные инструкции', t => {
  const p = project(t);
  fs.writeFileSync(path.join(p.path, 'README.md'), '# Test\n\nСобственный проект.\n');
  fs.writeFileSync(path.join(p.path, 'AGENTS.md'), 'Не удалять пользовательские данные.\n');
  const result = memory.init(p);
  assert.equal(result.sources.includes('README.md'), true);
  for (const name of memory.FILES) assert.ok(fs.existsSync(path.join(p.path, '.depo', 'memory', name)), name);
  assert.match(fs.readFileSync(path.join(p.path, 'AGENTS.md'), 'utf8'), /^Не удалять пользовательские данные\./);
  assert.match(fs.readFileSync(path.join(p.path, 'AGENTS.md'), 'utf8'), /DEPO:MEMORY/);
  assert.match(fs.readFileSync(path.join(p.path, '.depo', 'memory', 'PROJECT_CONTEXT.md'), 'utf8'), /Собственный проект/);
});

test('повторный импорт не дублирует управляемый блок, сводка компактна', t => {
  const p = project(t);
  memory.init(p); memory.init(p);
  const agents = fs.readFileSync(path.join(p.path, 'AGENTS.md'), 'utf8');
  assert.equal(agents.match(/DEPO:MEMORY START/g).length, 1);
  const compact = memory.contextFor(p, 'исправь runner');
  assert.ok(compact.length <= 7000);
  assert.match(compact, /CURRENT_STATE\.md/);
  assert.match(compact, /AGENT_RULES\.md/);
});

test('в память попадают наблюдаемые файлы и результат теста, а не обещания агента', t => {
  const p = project(t);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-memory-db-'));
  const db = open(tmp);
  const h = helpers(db);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  h.run('INSERT INTO projects(id,name,path,glyph,created_at) VALUES(?,?,?,?,?)', p.id, p.name, p.path, 'TE', 1);
  h.run('INSERT INTO chats(id,project_id,title,provider,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'chat', p.id, 'Задача', 'claude', 1, 1);
  h.run("INSERT INTO runs(id,chat_id,provider,status,started_at,ended_at) VALUES(1,'chat','claude','done',1000,5000)");
  h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES('chat',1,'tool','tool_use','Edit a.js',?,2)", JSON.stringify({ id: 'edit', name: 'Edit', input: { file_path: 'a.js' } }));
  h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES('chat',1,'tool','tool_use','Bash npm test',?,3)", JSON.stringify({ id: 'test', name: 'Bash', input: { command: 'npm test' } }));
  h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES('chat',1,'tool','tool_result','ok',?,4)", JSON.stringify({ tool_use_id: 'test', is_error: false }));
  h.run("INSERT INTO queued_messages(chat_id,text,created_at,updated_at) VALUES('chat','Следующая задача',1,1)");
  memory.recordRun(h, 1);
  memory.recordRun(h, 1);
  const state = fs.readFileSync(path.join(p.path, '.depo', 'memory', 'CURRENT_STATE.md'), 'utf8');
  const worklog = fs.readFileSync(path.join(p.path, '.depo', 'memory', 'WORKLOG.md'), 'utf8');
  assert.match(state, /a\.js/);
  assert.match(state, /npm test — успешно/);
  assert.equal(state.match(/Следующая задача/g).length, 1);
  assert.match(worklog, /Задача/);
  assert.match(fs.readFileSync(path.join(p.path, 'AGENTS.md'), 'utf8'), /a\.js/);
});

test('передача другому агенту содержит общую память без скрытых рассуждений', t => {
  const p = project(t);
  memory.init(p);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-handoff-memory-'));
  const db = open(tmp);
  const h = helpers(db);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', p.name, p.path, 'TE', 1);
  h.run('INSERT INTO chats(id,project_id,created_at,updated_at) VALUES(?,?,?,?)', 'chat', 1, 1, 1);
  h.run("INSERT INTO messages(chat_id,role,kind,text,ts) VALUES('chat','user','text','Продолжи',1)");
  const text = handoff.build(h, { id: 'chat', cwd: p.path }, 'claude', 'kimi').text;
  assert.match(text, /Общая память проекта/);
  assert.doesNotMatch(text, /thinking/);
});
