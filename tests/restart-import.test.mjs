import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-restart-test-'));
const oldHome = process.env.HOME;
process.env.HOME = tmp;
const sessions = await import('../lib/sessions.mjs');
const { Runner } = await import('../lib/runner.mjs');
process.env.HOME = oldHome;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const line = (role, content) => JSON.stringify({ type: role, timestamp: new Date().toISOString(), message: { role, content } }) + '\n';
const HINT = '\n\n---\nОтвет показывается владельцу в Depo. Чтобы он увидел результат, не выходя из чата:\n- картинка — ...\nПути пиши относительно папки проекта.\n- Поле description у Bash пиши по-русски.';

test('после аварийного перезапуска хвост хода Claude не импортируется второй раз, «Продолжить» остаётся последним', async () => {
  const h = helpers(open(path.join(tmp, 'data1')));
  const projectPath = path.join(tmp, 'p1'); fs.mkdirSync(projectPath);
  h.run("INSERT INTO projects(name,path,glyph,created_at) VALUES('P',?,'П',1)", projectPath);
  const id = '11111111-1111-1111-1111-111111111111';
  h.run("INSERT INTO chats(id,project_id,provider,state,claude_started,origin,import_offset,created_at,updated_at) VALUES(?,1,'claude','running',1,'claude',0,1,1)", id);
  const dir = sessions.sessionsDir(projectPath); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), line('user', 'Сделай кнопку' + HINT) + line('assistant', [{ type: 'text', text: 'Делаю.' }]));
  h.run("INSERT INTO runs(chat_id,provider,status,started_at) VALUES(?,'claude','running',?)", id, Date.now());

  const runner = new Runner({ h, hub: { send() {} }, env: {} });
  assert.equal(runner.reconcile(), 1);
  await sessions.syncProject(h, h.get('SELECT * FROM projects WHERE id=1'));
  const last = h.get('SELECT role, kind, text FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT 1', id);
  assert.match(last.text, /Продолжить/);
  assert.equal(h.get('SELECT count(*) n FROM messages WHERE chat_id=?', id).n, 1);
});

test('импорт сессии Claude: служебная приписка Depo в сообщениях владельца не показывается', async () => {
  const h = helpers(open(path.join(tmp, 'data2')));
  const projectPath = path.join(tmp, 'p2'); fs.mkdirSync(projectPath);
  h.run("INSERT INTO projects(name,path,glyph,created_at) VALUES('P',?,'П',1)", projectPath);
  const id = '22222222-2222-2222-2222-222222222222';
  const dir = sessions.sessionsDir(projectPath); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), line('user', 'Почини Telegram' + HINT) + line('user', [{ type: 'text', text: 'И ещё кнопку' + HINT }]));
  await sessions.syncProject(h, h.get('SELECT * FROM projects WHERE id=1'));
  const texts = h.all("SELECT text FROM messages WHERE chat_id=? AND role='user' ORDER BY id", id).map(m => m.text);
  assert.deepEqual(texts, ['Почини Telegram', 'И ещё кнопку']);
  assert.equal(h.get('SELECT title FROM chats WHERE id=?', id).title, 'Почини Telegram');
});
