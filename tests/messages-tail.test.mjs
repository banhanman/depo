import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { open, helpers } from '../lib/db.mjs';
import * as auth from '../lib/auth.mjs';

const waitFor = async (fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Не дождались результата');
};

test('история отдаёт ПОСЛЕДНИЕ сообщения, а не первые 2000', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.tail-test-'));
  const home = path.join(root, 'home'), project = path.join(home, 'project'), data = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin);
  // пробы лимитов не должны ходить в настоящие CLI — они переживают сервер и пишут в HOME
  fs.writeFileSync(path.join(bin, 'kimi'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });

  const db = open(data); const h = helpers(db); auth.createUser(h, 'test', 'test-password');
  h.run("INSERT INTO projects(name,path,glyph,created_at) VALUES('T',?,'Т',1)", project);
  const cid = crypto.randomUUID();
  h.run("INSERT INTO chats(id,project_id,title,created_at,updated_at) VALUES(?,1,'Длинный',1,1)", cid);
  for (let i = 0; i < 2100; i++) h.run("INSERT INTO messages(chat_id,role,kind,text,ts) VALUES(?,?,'text',?,?)", cid, i % 2 ? 'assistant' : 'user', 'сообщение ' + i, i + 1);
  db.close();

  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, HOME: home, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1', HTTPS_PORT: String(port + 1) };
  const server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
  t.after(async () => {
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
    // внучатые пробы лимитов могут дописать ~/.kimi-code уже после гибели сервера
    for (let i = 0; i < 15 && fs.existsSync(root); i++) {
      fs.rmSync(root, { recursive: true, force: true });
      if (fs.existsSync(root)) await new Promise(r => setTimeout(r, 200));
    }
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test', password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const res = await fetch(`${base}/api/chats/${cid}/messages`, { headers: { cookie } });
  const d = await res.json();
  assert.equal(d.messages.length, 2000, log);
  assert.equal(d.messages.at(-1).text, 'сообщение 2099');
  assert.equal(d.messages[0].text, 'сообщение 100');
  // порядок по возрастанию id сохранён
  assert.ok(d.messages[0].id < d.messages.at(-1).id);

  // дочитка хвоста через after работает как раньше
  const tail = await (await fetch(`${base}/api/chats/${cid}/messages?after=${d.messages.at(-2).id}`, { headers: { cookie } })).json();
  assert.deepEqual(tail.messages.map(m => m.text), ['сообщение 2099']);
});
