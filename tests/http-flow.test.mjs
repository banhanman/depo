import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, helpers } from '../lib/db.mjs';
import * as queue from '../lib/queue.mjs';
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

test('HTTP: очередь Kimi, общая память и итог хода работают вместе', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.flow-test-'));
  const home = path.join(root, 'home'), project = path.join(home, 'project'), data = path.join(root, 'data');
  const bin = path.join(root, 'bin'), kimiHome = path.join(root, 'kimi');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# Flow project\n\nПроверка общей памяти.\n');
  fs.writeFileSync(path.join(kimiHome, 'credentials', 'test.json'), JSON.stringify({ access_token: 'test-only' }));
  const db = open(data); const h = helpers(db); auth.createUser(h, 'test', 'test-password'); db.close();

  const fake = path.join(bin, 'kimi');
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('-p')){\n const prompt=args[args.indexOf('-p')+1];\n fs.appendFileSync(process.env.FLOW_PROMPTS,prompt+'\\n---\\n');\n const count=fs.existsSync(process.env.FLOW_COUNT)?+fs.readFileSync(process.env.FLOW_COUNT,'utf8'):0;\n fs.writeFileSync(process.env.FLOW_COUNT,String(count+1));\n setTimeout(()=>{console.log(JSON.stringify({role:'assistant',content:'ok '+count}));process.exit(0)},300);\n}else{\n console.log('No session yet');\n process.stdin.on('data',()=>{console.log('5h limit 10% used resets in 1h');console.log('Context window 1% (1k / 100k)');process.exit(0)});\n}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({result:''}));\n`, { mode: 0o755 });

  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, HOME: home, KIMI_CODE_HOME: kimiHome, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1', HTTPS_PORT: String(port + 1), FLOW_COUNT: path.join(root, 'count'), FLOW_PROMPTS: path.join(root, 'prompts') };
  let log = '';
  const start = () => {
    const server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => { log += d; }); server.stderr.on('data', d => { log += d; });
    return server;
  };
  let child = start();
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test', password: 'test-password' }) });
  assert.equal(login.status, 200, log);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json();
    return { status: response.status, value };
  };

  const created = await call('/api/projects', 'POST', { name: 'Flow', path: project });
  assert.equal(created.status, 200, JSON.stringify(created.value));
  const projectId = created.value.project.id;
  assert.ok(fs.existsSync(path.join(project, '.depo', 'memory', 'CURRENT_STATE.md')));
  assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /DEPO:MEMORY/);

  // симлинк за пределы проекта не должен ни отдавать, ни принимать файлы
  const outsideDir = path.join(root, 'outside'); fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'секрет');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(project, 'link.txt'));
  fs.symlinkSync(outsideDir, path.join(project, 'linkdir'));
  const rawEscape = await fetch(`${base}/api/projects/${projectId}/raw?path=link.txt`, { headers: { cookie } });
  assert.match((await rawEscape.json()).error, /За пределы проекта/);
  assert.match((await call(`/api/projects/${projectId}/file?path=link.txt`)).value.error, /За пределы проекта/);
  assert.match((await call(`/api/projects/${projectId}/files?path=linkdir`)).value.error, /За пределы проекта/);
  const upEscape = await fetch(`${base}/api/projects/${projectId}/upload?dir=linkdir`, { method: 'POST', headers: { cookie, 'x-name': 'x.txt' }, body: 'данные' });
  assert.match((await upEscape.json()).error, /За пределы проекта/);
  const upOk = await fetch(`${base}/api/projects/${projectId}/upload?dir=.`, { method: 'POST', headers: { cookie, 'x-name': 'hello.txt' }, body: 'данные' });
  assert.equal((await upOk.json()).path, 'hello.txt');
  assert.equal(fs.readFileSync(path.join(project, 'hello.txt'), 'utf8'), 'данные');
  assert.equal(fs.readFileSync(path.join(outsideDir, 'secret.txt'), 'utf8'), 'секрет');

  const chat = await call('/api/chats', 'POST', { project_id: projectId, provider: 'kimi' });
  const chatId = chat.value.chat.id;
  const started = await call(`/api/chats/${chatId}/send`, 'POST', { text: 'Первая задача' });
  assert.equal(started.status, 200);
  assert.equal(started.value.run.status, 'running');
  assert.ok(started.value.run.started_at > 0);
  // Kimi не читает ввод посреди хода: «сейчас» не отклоняется и не выдаётся за доставку — уходит в очередь
  const unsupported = await call(`/api/chats/${chatId}/send`, 'POST', { text: 'Сейчас', mode: 'now' });
  assert.equal(unsupported.status, 200);
  assert.equal(unsupported.value.queued, true);
  assert.equal(unsupported.value.fallback, 'nosteer');
  assert.ok(!unsupported.value.steered);
  const queued = await call(`/api/chats/${chatId}/send`, 'POST', { text: 'Вторая задача', mode: 'after' });
  assert.equal(queued.value.queued, true);
  const queueId = queued.value.item.id;
  assert.equal((await call(`/api/queue/${queueId}`, 'PATCH', { text: 'Вторая задача изменена' })).status, 200);
  await waitFor(() => fs.existsSync(path.join(root, 'count')) && fs.readFileSync(path.join(root, 'count'), 'utf8') === '3');
  await waitFor(async () => (await call(`/api/chats/${chatId}/messages`)).value.running === false);
  const messages = await call(`/api/chats/${chatId}/messages`);
  assert.equal(messages.value.queue.length, 0);
  assert.equal(messages.value.run.phase, 'Завершено');
  assert.ok(messages.value.run.active_ms >= 0);
  assert.ok(messages.value.messages.some(x => x.text === 'Вторая задача изменена'));
  const summary = await call(`/api/runs/${messages.value.run.id}`);
  assert.equal(summary.status, 200);
  assert.ok(Array.isArray(summary.value.facts.files));
  const prompts = fs.readFileSync(path.join(root, 'prompts'), 'utf8');
  assert.ok(prompts.indexOf('Первая задача') < prompts.indexOf('Сейчас'));
  assert.ok(prompts.indexOf('Сейчас') < prompts.indexOf('Вторая задача изменена'));

  const durable = open(data); queue.enqueue(helpers(durable), chatId, 'После перезапуска'); durable.close();
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  child = start();
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  const relogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test', password: 'test-password' }) });
  cookie = relogin.headers.get('set-cookie').split(';')[0];
  const restored = await call(`/api/chats/${chatId}/queue`);
  assert.deepEqual(restored.value.items.map(x => x.text), ['После перезапуска']);
  assert.ok(fs.existsSync(path.join(project, '.depo', 'memory', 'WORKLOG.md')));
  assert.match(fs.readFileSync(path.join(project, '.depo', 'memory', 'WORKLOG.md'), 'utf8'), /Первая задача/);
});
