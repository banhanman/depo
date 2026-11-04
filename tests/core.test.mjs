import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { open, helpers } from '../lib/db.mjs';
import * as auth from '../lib/auth.mjs';
import * as P from '../lib/projects.mjs';
import { parseUsage, parseContext } from '../lib/usage.mjs';
import * as handoff from '../lib/handoff.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-test-'));
const h = helpers(open(tmp));

test('пароль проверяется и не подходит чужой', () => {
  const u = auth.createUser(h, 'owner', 'secret123');
  assert.ok(auth.verify(h, 'owner', 'secret123'));
  assert.equal(auth.verify(h, 'owner', 'secret124'), null);
  assert.equal(auth.verify(h, 'other', 'secret123'), null);
  auth.setPassword(h, u.id, 'next');
  assert.ok(auth.verify(h, 'owner', 'next'));
  assert.equal(auth.verify(h, 'owner', 'secret123'), null);
});

test('сессия живёт в куке и гасится выходом', () => {
  const u = h.get('SELECT * FROM users WHERE login=?', 'owner');
  const token = auth.startSession(h, u.id, 'test');
  const req = { headers: { cookie: `depo_session=${token}` } };
  assert.equal(auth.readSession(h, req).user.login, 'owner');
  auth.endSession(h, req);
  assert.equal(auth.readSession(h, req), null);
});

test('перебор пароля притормаживается', () => {
  const key = 'ip|login|' + Math.random();
  for (let i = 0; i < 10; i++) assert.ok(auth.throttle(key).ok);
  assert.equal(auth.throttle(key).ok, false);
});

test('за пределы дома проект не пускают', () => {
  assert.equal(P.checkPath('/etc').ok, false);
  assert.equal(P.checkPath('~/.claude').ok, false);
  assert.equal(P.checkPath('~/.ssh/keys').ok, false);
  assert.ok(P.checkPath('~/my-project').ok);
  assert.equal(P.checkPath('~/my-project').abs, path.join(os.homedir(), 'my-project'));
});

test('значок проекта не повторяется', () => {
  assert.equal(P.glyphFor('Space Port'), 'SP');
  assert.notEqual(P.glyphFor('Space Port', ['SP']), 'SP');
  assert.equal(P.glyphFor('Депо'), 'ДЕ');
});

test('лимиты разбираются из ответа /usage', () => {
  const u = parseUsage([
    'Current session: 11% used · resets Oct 28, 8:29pm (Europe/Moscow)',
    'Current week (all models): 36% used · resets Nov 2, 12:59am (Europe/Moscow)',
    'Last 24h · 1105 requests · 26 sessions',
  ].join('\n'));
  assert.equal(u.limits.length, 2);
  assert.equal(u.limits[0].pct, 11);
  assert.equal(u.limits[0].label, 'Сессия · 5 ч');
  assert.match(u.limits[1].resets, /2 нояб\.?, 00:59/);   // даты из /usage приводим к русскому виду
  assert.equal(u.today.requests, 1105);
});

test('контекст разбирается из ответа /context', () => {
  const c = parseContext(`**Model:** claude-sonnet-5
**Tokens:** 25.5k / 1m (3%)
### Estimated usage by category
| Category | Tokens | Percentage |
|---|---|---|
| System prompt | 8.6k | 0.9% |
| Messages | 138.7k | 13.9% |
### MCP Tools`);
  assert.equal(c.model, 'claude-sonnet-5');
  assert.equal(c.used, 25500);
  assert.equal(c.window, 1000000);
  assert.deepEqual(c.rows.map(r => r.label), ['Системный промпт', 'Сообщения']);
  assert.equal(c.rows[1].tokens, 138700);
});

test('передача между провайдерами собирает задачу и файлы', () => {
  h.run('INSERT INTO projects(name,path,glyph,position,created_at) VALUES(?,?,?,?,?)',
    'T', path.join(tmp, 'proj'), 'T1', 1, Date.now());
  const pid = h.get('SELECT id FROM projects').id;
  const cid = 'c-1';
  h.run('INSERT INTO chats(id,project_id,created_at,updated_at) VALUES(?,?,?,?)', cid, pid, 1, 1);
  const add = (role, kind, text, json) => h.run(
    'INSERT INTO messages(chat_id,role,kind,text,json,ts) VALUES(?,?,?,?,?,?)',
    cid, role, kind, text, json ? JSON.stringify(json) : null, Date.now());
  add('user', 'text', 'Почини вёрстку каталога');
  add('tool', 'tool_use', 'Edit  src/a.css', { name: 'Edit', input: { file_path: 'src/a.css' } });
  add('tool', 'tool_use', 'Read  src/b.css', { name: 'Read', input: { file_path: 'src/b.css' } });
  add('assistant', 'text', 'Поправил минимум в гриде');

  const ho = handoff.build(h, { id: cid }, 'claude', 'codex');
  assert.deepEqual(ho.files, ['src/a.css']);          // Read не считается правкой
  assert.match(ho.text, /Почини вёрстку каталога/);
  assert.match(ho.text, /от Claude Code к Codex/);
  assert.match(ho.text, /Поправил минимум/);
});

test('пустой чат передавать нечего', () => {
  h.run('INSERT INTO chats(id,project_id,created_at,updated_at) VALUES(?,?,?,?)', 'c-2',
    h.get('SELECT id FROM projects').id, 1, 1);
  assert.equal(handoff.build(h, { id: 'c-2' }, 'claude', 'codex'), null);
});

test('сессии Claude: путь → папка, разбор jsonl с позиции', async () => {
  const { slugOf, readSession } = await import('../lib/sessions.mjs');
  assert.equal(slugOf('/home/owner/my-project'), '-home-owner-my-project');
  assert.equal(slugOf('/home/owner/a/.worktrees/T1'), '-home-owner-a--worktrees-T1');
  const f = path.join(tmp, 's.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-28T10:00:00Z', message: { role: 'user', content: 'Почини кнопку' } },
    { type: 'assistant', timestamp: '2026-10-28T10:00:05Z', message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }] } },
    { type: 'user', timestamp: '2026-10-28T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'субагент, не показывать' } },
    { type: 'assistant', timestamp: '2026-10-28T10:00:09Z', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'Готово' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(f, lines);
  const r = await readSession(f, 0);
  assert.equal(r.meta.prompts, 1);
  assert.equal(r.meta.firstPrompt, 'Почини кнопку');
  assert.equal(r.meta.model, 'claude-opus-5');
  assert.deepEqual(r.messages.map(m => m.kind), ['text', 'tool_use', 'tool_result', 'text']);
  assert.equal(r.offset, Buffer.byteLength(lines));
  fs.appendFileSync(f, JSON.stringify({ type: 'user', timestamp: '2026-10-28T10:01:00Z', message: { role: 'user', content: 'Ещё' } }) + '\n');
  const r2 = await readSession(f, r.offset);
  assert.equal(r2.messages.length, 1);
  assert.equal(r2.messages[0].text, 'Ещё');
});
