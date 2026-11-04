// Передача чата между агентами: свежие ходы не теряются, «собеседник» сменой агента не считается.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import * as handoff from '../lib/handoff.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-handoff-'));
const db = open(tmp);
const h = helpers(db);
test.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
h.run('INSERT INTO projects(name,path,glyph,position,created_at) VALUES(?,?,?,?,?)', 'P', tmp, 'P', 1, 1);
const pid = h.get('SELECT id FROM projects').id;
let n = 0;
const chat = () => {
  const id = 'h-' + ++n;
  h.run('INSERT INTO chats(id,project_id,created_at,updated_at) VALUES(?,?,?,?)', id, pid, 1, 1);
  const add = (role, kind, text, json) => h.run('INSERT INTO messages(chat_id,role,kind,text,json,ts) VALUES(?,?,?,?,?,?)',
    id, role, kind, text, json ? JSON.stringify(json) : null, Date.now());
  const run = provider => h.run("INSERT INTO runs(chat_id,provider,status,started_at) VALUES(?,?,'done',?)", id, provider, Date.now());
  return { id, add, run };
};

test('последняя просьба и итог агента попадают в передачу даже за лавиной вызовов инструментов', () => {
  const c = chat();
  c.add('user', 'text', 'Первая задача');
  c.add('assistant', 'text', 'Сделал первое');
  c.add('user', 'text', 'ПОСЛЕДНЯЯ-ПРОСЬБА: допили мобильную шапку');
  for (let i = 0; i < 40; i++) {
    c.add('tool', 'tool_use', `Bash  ls ${i}`, { name: 'Bash', input: { command: 'ls ' + i } });
    c.add('tool', 'tool_result', 'x'.repeat(900), null);
  }
  c.add('assistant', 'text', 'ИТОГ-АГЕНТА: шапка в одну строку');
  const ho = handoff.build(h, { id: c.id }, 'kimi', 'codex');
  assert.match(ho.text, /ПОСЛЕДНЯЯ-ПРОСЬБА/);
  assert.match(ho.text, /ИТОГ-АГЕНТА/);
});

test('при урезании по длине теряется старое, а не свежее', () => {
  const c = chat();
  c.add('user', 'text', 'Исходная задача ' + 'а'.repeat(3000));
  for (let i = 0; i < 30; i++) {
    c.add('user', 'text', `вопрос ${i} ` + 'б'.repeat(600));
    c.add('assistant', 'text', `ответ ${i} ` + 'в'.repeat(600));
  }
  c.add('user', 'text', 'САМОЕ-СВЕЖЕЕ');
  const ho = handoff.build(h, { id: c.id }, 'claude', 'kimi');
  assert.ok(ho.text.length <= 8000, `передача ${ho.text.length} символов`);
  assert.match(ho.text, /САМОЕ-СВЕЖЕЕ/);
  assert.match(ho.text, /Что делать дальше/);       // инструкция в конце не отрезана
});

test('правки Codex (changes[].path) и Kimi (path) считаются тронутыми файлами', () => {
  const c = chat();
  c.add('user', 'text', 'Задача');
  c.add('tool', 'tool_use', 'Edit', { name: 'Edit', input: { type: 'file_change', changes: [{ path: '/p/a.css', kind: 'update' }, { path: '/p/b.js', kind: 'add' }] } });
  c.add('tool', 'tool_use', 'Edit', { name: 'Edit', input: { path: '/p/c.html', old_string: 'a', new_string: 'b' } });
  const ho = handoff.build(h, { id: c.id }, 'codex', 'kimi');
  assert.deepEqual(ho.files.sort(), ['/p/a.css', '/p/b.js', '/p/c.html']);
});

test('агент последнего хода: «собеседник» и замеры контекста сменой агента не считаются', () => {
  const c = chat();
  c.run('kimi');
  h.run("INSERT INTO runs(chat_id,provider,status,started_at) VALUES(?,?,'context',?)", c.id, 'claude', Date.now());
  c.run('companion');
  assert.equal(handoff.lastAgent(h, c.id), 'kimi');
  c.run('codex');
  assert.equal(handoff.lastAgent(h, c.id), 'codex');
  assert.equal(handoff.lastAgent(h, chat().id), null);
});

test('имена всех четырёх агентов', () => {
  assert.deepEqual(['claude', 'codex', 'kimi', 'gemini'].map(handoff.nameOf), ['Claude Code', 'Codex', 'Kimi Code', 'Gemini CLI']);
});

test('передача: задача не «(вложения)», а Git проверен по факту', async () => {
  const { open, helpers } = await import('../lib/db.mjs');
  const { build } = await import('../lib/handoff.mjs');
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-git-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'первый коммит']);
    fs.writeFileSync(path.join(root, 'new.txt'), 'x');
    const db = open(path.join(root, '.data')), h = helpers(db);
    h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'P', root, 'P', 1);
    h.run("INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES('c',1,'kimi',1,1)");
    h.run("INSERT INTO messages(chat_id,role,kind,text,ts) VALUES('c','user','text','(вложения)',1)");
    h.run("INSERT INTO messages(chat_id,role,kind,text,ts) VALUES('c','user','text','Почини вход',2)");
    const ho = build(h, { id: 'c', cwd: root }, 'kimi', 'claude');
    db.close();
    assert.match(ho.text, /## Исходная задача\nПочини вход/);
    assert.match(ho.text, /Фактическое состояние Git/);
    assert.match(ho.text, /\?\? new\.txt/);
    assert.match(ho.text, /первый коммит/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('передача работает и с Kimi: его правки (Edit/Write с path) попадают в сводку', async () => {
  const { open, helpers } = await import('../lib/db.mjs');
  const { build, lastAgent } = await import('../lib/handoff.mjs');
  const fs = await import('node:fs'), path = await import('node:path'), os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-kimi-'));
  try {
    const db = open(dir), h = helpers(db);
    h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'P', dir, 'P', 1);
    h.run("INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES('k',1,'codex',1,1)");
    h.run("INSERT INTO runs(id,chat_id,provider,status,started_at) VALUES(1,'k','kimi','done',1)");
    h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,ts) VALUES('k',1,'user','text','Почини меню',1)");
    h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES('k',1,'tool','tool_use','Edit  src/menu.js',?,2)", JSON.stringify({ name: 'Edit', input: { path: 'src/menu.js' } }));
    h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES('k',1,'tool','tool_use','Write  src/new.js',?,3)", JSON.stringify({ name: 'Write', input: { path: 'src/new.js', content: 'x' } }));
    h.run("INSERT INTO messages(chat_id,run_id,role,kind,text,ts) VALUES('k',1,'assistant','text','Меню поправил',4)");
    assert.equal(lastAgent(h, 'k'), 'kimi');
    const ho = build(h, { id: 'k', cwd: dir }, 'kimi', 'codex');
    assert.match(ho.text, /от Kimi Code к Codex/);
    assert.deepEqual(ho.files, ['src/menu.js', 'src/new.js']);
    assert.match(ho.text, /Kimi Code: Меню поправил/);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('команду выключили и дальше пишут одному Codex: передача от последнего агента команды, с уроками проекта', async () => {
  const { addLessons } = await import('../lib/memory.mjs');
  addLessons({ name: 'P', path: tmp }, ['УРОК-ПРОЕКТА: гонять npm test']);
  const c = chat();
  c.add('user', 'text', 'Задача командой');
  c.run('claude'); c.add('assistant', 'text', 'План');
  c.run('codex'); c.add('assistant', 'text', 'Вёрстка готова');
  c.run('kimi'); c.add('assistant', 'text', 'ИТОГ-ТЕСТОВ: всё зелёное');
  const last = handoff.lastAgent(h, c.id);
  assert.equal(last, 'kimi');                       // ≠ codex — значит, Depo соберёт передачу
  const ho = handoff.build(h, { id: c.id, project_id: pid, cwd: tmp }, last, 'codex');
  assert.match(ho.text, /ИТОГ-ТЕСТОВ/);
  assert.match(ho.text, /УРОК-ПРОЕКТА/);
});
