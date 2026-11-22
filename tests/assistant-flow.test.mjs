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

test('HTTP: ассистент по просьбе владельца отправляет ТЗ в чат, без просьбы — нет', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.asst-test-'));
  const home = path.join(root, 'home'), project = path.join(home, 'project'), data = path.join(root, 'data');
  const bin = path.join(root, 'bin'), kimiHome = path.join(root, 'kimi'), answer = path.join(root, 'answer'), prompts = path.join(root, 'prompts');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(bin); fs.mkdirSync(path.join(kimiHome, 'credentials'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
  fs.writeFileSync(path.join(kimiHome, 'credentials', 'test.json'), JSON.stringify({ access_token: 'test-only' }));
  const db = open(data); auth.createUser(helpers(db), 'test', 'test-password'); db.close();

  fs.writeFileSync(path.join(bin, 'kimi'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);\nif(a.includes('-p')){fs.appendFileSync(process.env.ASST_PROMPTS,a[a.indexOf('-p')+1]+'\\n---\\n');console.log(JSON.stringify({role:'assistant',content:'принял'}));}\nelse{process.stdin.on('data',()=>process.exit(0));}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nimport fs from 'node:fs';\nif(process.argv[2]!=='exec')process.exit(1);\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:fs.readFileSync(process.env.ASST_ANSWER,'utf8')}}));});\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconsole.log(JSON.stringify({result:''}));\n`, { mode: 0o755 });

  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, HOME: home, KIMI_CODE_HOME: kimiHome, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1',
    HTTPS_PORT: String(port + 1), DEPO_APPROVAL_TOKEN: 'test-approval-token', DEPO_NO_CODEX_LIMITS: '1', DEPO_CLI_AUTOUPDATE: '0', ASST_ANSWER: answer, ASST_PROMPTS: prompts };
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

  const projectId = (await call('/api/projects', 'POST', { name: 'Бот', path: project })).value.project.id;
  const chat = (await call('/api/chats', 'POST', { project_id: projectId, provider: 'kimi' })).value.chat;
  const digest = (await call(`/api/assistant/digest?scope=c:${chat.id}`)).value.text;
  assert.match(digest, new RegExp(`\\[чат ${chat.id.slice(0, 8)}\\]`), 'в сводке есть адрес чата для отправки');
  fs.writeFileSync(answer, `Отправляю ТЗ в этот чат.\n<<<SEND chat=${chat.id.slice(0, 8)}>>>\nСделай локальный дашборд для бота.\n<<<END>>>`);

  const quiet = await call('/api/assistant/ask', 'POST', { text: 'что сейчас в проекте?', scope: `c:${chat.id}` });
  assert.equal(quiet.status, 200, JSON.stringify(quiet.value));
  assert.deepEqual(quiet.value.sent, [], 'без просьбы владельца ничего не уходит');
  assert.doesNotMatch(quiet.value.text, /<<<SEND/, 'служебный блок владельцу не показываем');

  const asked = await call('/api/assistant/ask', 'POST', { text: 'ок, отправь это ТЗ в этот чат', scope: `c:${chat.id}` });
  assert.equal(asked.status, 200, JSON.stringify(asked.value));
  assert.equal(asked.value.sent.length, 1);
  assert.equal(asked.value.sent[0].ok, true, JSON.stringify(asked.value.sent));
  assert.equal(asked.value.sent[0].chat_id, chat.id);
  assert.match(asked.value.text, /Отправил ТЗ в чат/);
  await waitFor(() => fs.existsSync(prompts) && fs.readFileSync(prompts, 'utf8').includes('Сделай локальный дашборд для бота.'));
  const msgs = await waitFor(async () => { const m = (await call(`/api/chats/${chat.id}/messages`)).value; return !m.running && m.messages.some(x => x.role === 'assistant') && m; });
  assert.ok(msgs.messages.some(x => x.role === 'user' && x.text === 'Сделай локальный дашборд для бота.'), 'ТЗ в ленте — как сообщение владельца');
  assert.ok(msgs.messages.some(x => /ассистент Depo/.test(x.text || '')), 'видно, что ТЗ прислал ассистент');
  assert.notEqual(msgs.chat.title, 'Новый чат', 'пустой чат получил название по ТЗ');
});
