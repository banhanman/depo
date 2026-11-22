import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

test('HTTP: архив проекта, защита от повторного подключения его папки, возврат', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.arch-test-'));
  const home = path.join(root, 'home'), project = path.join(home, 'vpn-bot'), data = path.join(root, 'data'), bin = path.join(root, 'bin');
  const kimiHome = path.join(root, 'kimi');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(kimiHome, 'credentials', 'test.json'), JSON.stringify({ access_token: 'test-only' }));
  fs.symlinkSync(project, path.join(home, 'vpn-link'));
  const db = open(data); auth.createUser(helpers(db), 'test', 'test-password'); db.close();
  fs.writeFileSync(path.join(bin, 'kimi'), `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a.includes('-p')){setTimeout(()=>{console.log(JSON.stringify({role:'assistant',content:'готово'}));process.exit(0)},1500);}\nelse{process.stdin.on('data',()=>process.exit(0));}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({result:''}));\n`, { mode: 0o755 });
  for (const b of ['codex', 'gemini']) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, HOME: home, KIMI_CODE_HOME: kimiHome, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1',
    HTTPS_PORT: String(port + 1), DEPO_APPROVAL_TOKEN: 'test-approval-token', DEPO_NO_CODEX_LIMITS: '1', DEPO_CLI_AUTOUPDATE: '0' };
  let log = '';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test', password: 'test-password' }) });
  assert.equal(login.status, 200, log);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  };

  const pr = (await call('/api/projects', 'POST', { name: 'VPN-BOT', path: project })).value.project;
  const chat = (await call('/api/chats', 'POST', { project_id: pr.id, provider: 'kimi' })).value.chat;
  assert.equal((await call(`/api/chats/${chat.id}/send`, 'POST', { text: 'Сделай бота' })).status, 200);

  const busy = await call(`/api/projects/${pr.id}`, 'PATCH', { archived: true });
  assert.equal(busy.status, 409, 'пока агент работает, проект в архив не уходит');
  assert.match(busy.value.error, /работает/);
  await waitFor(async () => (await call(`/api/chats/${chat.id}/messages`)).value.running === false);

  const arch = await call(`/api/projects/${pr.id}`, 'PATCH', { archived: true });
  assert.equal(arch.status, 200);
  assert.equal(arch.value.project.archived, true);
  assert.ok(arch.value.project.archived_at > 0, 'запомнили, когда убран');
  assert.ok(fs.existsSync(project), 'папка осталась на месте');

  for (const again of [project, project + '/', path.join(home, 'vpn-link')]) {
    const dup = await call('/api/projects', 'POST', { name: 'VPN-BOT 2', path: again });
    assert.equal(dup.status, 409, `${again}: второй проект на ту же папку не заводим`);
    assert.equal(dup.value.archived?.id, pr.id, 'отдаём архивный проект, чтобы предложить вернуть');
    assert.match(dup.value.error, /в архиве/);
  }
  const listed = (await call('/api/browse?path=~')).value.dirs.find(d => d.name === 'vpn-bot');
  assert.equal(listed.connected, true);
  assert.equal(listed.archived, pr.id, 'в выборе папки видно, что это проект в архиве');

  const back = await call(`/api/projects/${pr.id}`, 'PATCH', { archived: false });
  assert.equal(back.value.project.archived, false);
  assert.equal(back.value.project.archived_at, null);
  const st = (await call('/api/state')).value;
  assert.ok(st.chats.some(c => c.id === chat.id), 'чаты вернулись вместе с проектом');
  const active = await call('/api/projects', 'POST', { name: 'Ещё раз', path: project });
  assert.equal(active.status, 409);
  assert.equal(active.value.archived, undefined);
  assert.equal(active.value.project_id, pr.id);
});
