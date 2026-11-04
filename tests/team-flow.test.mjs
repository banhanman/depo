// Команда агентов от начала до конца на подставных CLI:
// план Claude → утверждение → визуал Codex → тесты Kimi (упали) → исправление Codex → тесты (прошли) → ревью Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, helpers } from '../lib/db.mjs';
import * as auth from '../lib/auth.mjs';

const waitFor = async (fn, ms = 25000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('не дождались');
};

test('команда агентов: план, шаги по ролям, возврат после упавших тестов, итог', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.team-flow-'));
  const home = path.join(root, 'home'), project = path.join(home, 'project'), data = path.join(root, 'data'), bin = path.join(root, 'bin'), kimiHome = path.join(root, 'kimi');
  for (const d of [project, bin, path.join(home, '.claude'), path.join(home, '.codex'), path.join(kimiHome, 'credentials')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x'.repeat(20) } }));
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { account_id: '1' } }));
  fs.writeFileSync(path.join(kimiHome, 'credentials', 't.json'), JSON.stringify({ access_token: 'test-only' }));
  const log = path.join(root, 'calls.log');
  // claude: stream-json разговор; план — если просят планировать
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';const a=process.argv.slice(2);
if(!a.includes('--input-format')){console.log(JSON.stringify({result:''}));process.exit(0)}
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;
 const m=JSON.parse(l);const txt=m.message.content[0].text;console.log(JSON.stringify({type:'user',message:m.message}));
 const plan=/только ПЛАНИРУЕШЬ/.test(txt);fs.appendFileSync(process.env.CALLS,'claude '+(plan?'plan '+a[a.indexOf('--permission-mode')+1]:'step')+'\\n');
 const out=plan?'План такой.\\n\`\`\`json\\n{"steps":[{"role":"ui","title":"Карточка","do":"сверстать"},{"role":"test","title":"Тесты","do":"прогнать"},{"role":"lead","title":"Ревью","do":"итог"}]}\\n\`\`\`':'Ревью: всё сделано.';
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:out}]}}));console.log(JSON.stringify({type:'result',usage:{},is_error:false}));}});
process.stdin.on('end',()=>process.exit(0));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
import fs from 'node:fs';let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{
 fs.appendFileSync(process.env.CALLS,'codex '+(/Исправить по итогам/.test(p)?'fix':'ui')+'\\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:'th1'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Визуал готов.'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'kimi'), `#!${process.execPath}
import fs from 'node:fs';const a=process.argv.slice(2);
if(!a.includes('-p')){console.log('No session yet');process.stdin.on('data',()=>{console.log('5h limit 1% used resets in 1h');process.exit(0)})}
else{const n=(fs.existsSync(process.env.CALLS)?fs.readFileSync(process.env.CALLS,'utf8').match(/^kimi/gm)||[]:[]).length;
fs.appendFileSync(process.env.CALLS,'kimi test\\n');
setTimeout(()=>{console.log(JSON.stringify({role:'assistant',content:n===0?'Упал тест карточки.\\nИТОГ: ПРОВАЛЕНО':'Все 14 тестов прошли.\\nИТОГ: ПРОЙДЕНО'}));process.exit(0)},100);}
`, { mode: 0o755 });
  const db = open(data); const h = helpers(db); auth.createUser(h, 'test', 'test-password'); db.close();
  const port = 4900 + Math.floor(Math.random() * 300);
  const env = { ...process.env, HOME: home, KIMI_CODE_HOME: kimiHome, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1', HTTPS_PORT: String(port + 1), CALLS: log, DEPO_NO_CODEX_LIMITS: '1', DEPO_CLI_AUTOUPDATE: '0' };
  let out = '';
  const server = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { out += d; }); server.stderr.on('data', d => { out += d; });
  t.after(async () => { if (server.exitCode === null) { const e = once(server, 'exit'); server.kill('SIGTERM'); await e; } fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } });
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test', password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, value: await r.json().catch(() => ({})) };
  };
  const pr = await call('/api/projects', 'POST', { name: 'P', path: project, create: true });
  assert.equal(pr.status, 200, JSON.stringify(pr.value) + out);
  const chat = (await call('/api/chats', 'POST', { project_id: pr.value.project.id, provider: 'claude', permission_mode: 'acceptEdits', force: true, team: true })).value.chat;
  assert.equal(chat.team, true);
  const sent = await call(`/api/chats/${chat.id}/send`, 'POST', { text: 'Сделай карточку бэкапов' });
  assert.equal(sent.status, 200, JSON.stringify(sent.value) + out);
  assert.equal(sent.value.team, true);
  const card = async () => (await call(`/api/chats/${chat.id}/messages`)).value.messages.filter(m => m.kind === 'team_plan').at(-1)?.json;
  let plan;
  try { plan = await waitFor(async () => { const j = await card(); return j?.status === 'await' ? j : null; }); }
  catch (e) {
    const ms = (await call(`/api/chats/${chat.id}/messages`)).value.messages.map(m => `${m.role}/${m.kind}: ${(m.text || '').slice(0, 120)} ${m.json ? JSON.stringify(m.json).slice(0, 200) : ''}`);
    throw new Error('план не пришёл\n' + ms.join('\n') + '\nCALLS: ' + (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '—') + '\nOUT: ' + out.slice(-1500));
  }
  assert.deepEqual(plan.steps.map(s => s.role), ['ui', 'test', 'lead']);
  assert.equal((await call(`/api/team/${plan.task_id}/start`, 'POST', {})).status, 200);
  const done = await waitFor(async () => { const j = await card(); return ['done', 'error', 'stopped'].includes(j?.status) ? j : null; }, 40000);
  assert.equal(done.status, 'done', JSON.stringify(done) + out.slice(-2000));
  assert.deepEqual(done.steps.map(s => `${s.role}:${s.provider}:${s.status}`),
    ['ui:codex:done', 'test:kimi:failed', 'ui:codex:done', 'test:kimi:done', 'lead:claude:done']);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['claude plan plan', 'codex ui', 'kimi test', 'codex fix', 'kimi test', 'claude step']);
  const runs = (await call(`/api/chats/${chat.id}/messages`)).value.messages.filter(m => m.role === 'user' && m.kind === 'text');
  assert.equal(runs.length, 1, 'в ленте одна реплика владельца — шаги команды без лишних «сообщений от тебя»');
});
