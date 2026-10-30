import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-sessions-test-'));
const oldHome = process.env.HOME;
process.env.HOME = tmp;
const sessions = await import('../lib/sessions.mjs');
process.env.HOME = oldHome;

test('удалённый зеркалируемый чат не возвращается при следующей синхронизации', async t => {
  const db = open(path.join(tmp, 'data'));
  const h = helpers(db);
  t.after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const projectPath = path.join(tmp, 'project');
  fs.mkdirSync(projectPath);
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', projectPath, 'TE', Date.now());
  const project = h.get('SELECT * FROM projects WHERE path=?', projectPath);
  const id = '12345678-1234-1234-1234-123456789abc';
  const dir = sessions.sessionsDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: `Удали этот чат навсегда. ${'x'.repeat(220)}` },
  }) + '\n');

  assert.equal((await sessions.syncProject(h, project)).added, 1);
  sessions.deleteChat(h, id);
  assert.equal(h.get('SELECT id FROM chats WHERE id=?', id), undefined);

  await sessions.syncProject(h, project);
  assert.equal(h.get('SELECT id FROM chats WHERE id=?', id), undefined);
  assert.deepEqual(await sessions.previewSessions(h, project), []);
  assert.ok(fs.existsSync(file));
});
