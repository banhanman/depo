import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import { resumable } from '../lib/resume.mjs';

test('после перезапуска продолжаются только свежие оборванные ходы, без цикла и без команд', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = helpers(open(dir));
  const now = Date.now();
  h.run("INSERT INTO projects(name,path,glyph,created_at) VALUES('P','/tmp','П',1)");
  const chat = (id, extra = '') => h.run(`INSERT INTO chats(id,project_id,provider,created_at,updated_at${extra ? ',' + extra.split('=')[0] : ''}) VALUES(?,1,'claude',1,1${extra ? ',' + extra.split('=')[1] : ''})`, id);
  let t0 = now - 3600e3;
  const run = (id, status, ended = now - 60e3) => h.run('INSERT INTO runs(chat_id,provider,status,started_at,ended_at) VALUES(?,?,?,?,?)', id, 'claude', status, t0 += 1000, ended);

  chat('fresh'); run('fresh', 'done'); run('fresh', 'interrupted'); run('fresh', 'context');
  chat('again'); run('again', 'interrupted'); run('again', 'done');
  chat('old'); run('old', 'interrupted', now - 13 * 3600e3);
  chat('loop'); run('loop', 'interrupted'); run('loop', 'interrupted'); run('loop', 'interrupted');
  chat('second'); run('second', 'interrupted'); run('second', 'interrupted');
  chat('team', 'team=1'); run('team', 'interrupted');
  chat('arch', 'archived=1'); run('arch', 'interrupted');
  chat('queued'); run('queued', 'interrupted');
  h.run("INSERT INTO queued_messages(chat_id,text,attachments,created_at,updated_at) VALUES('queued','дальше','[]',1,1)");

  const got = Object.fromEntries(resumable(h, { now }).map(x => [x.id, x.queued]));
  assert.deepEqual(got, { fresh: false, second: false, queued: true });
});
