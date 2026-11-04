import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { open, helpers } from '../lib/db.mjs';
import { Runner } from '../lib/runner.mjs';

const waitFor = async fn => {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Не дождались завершения Claude');
};

test('Claude получает уточнение в stdin того же процесса', async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.claude-steering-'));
  const bin = path.join(root, 'bin'), capture = path.join(root, 'input.json');
  fs.mkdirSync(bin);
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nlet text='',timer;\nprocess.stdin.on('data',d=>{text+=d;const lines=text.split('\\n').filter(Boolean);fs.writeFileSync(process.env.CLAUDE_CAPTURE,JSON.stringify(lines));if(lines.length===2){clearTimeout(timer);console.log(JSON.stringify({type:'result',usage:{},is_error:false}));process.exit(0)}});\nprocess.stdin.on('end',()=>{if(!text)process.exit(1)});\ntimer=setTimeout(()=>{},10000);\n`, { mode: 0o755 });
  const db = open(path.join(root, 'data')), h = helpers(db);
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', root, 'TE', 1);
  const id = crypto.randomUUID();
  h.run('INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES(?,?,?,?,?)', id, 1, 'claude', 1, 1);
  const runner = new Runner({ h, hub: { send() {} }, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CAPTURE: capture }, root });
  t.after(() => { runner.cancel(id); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  runner.start({ id, provider: 'claude', cwd: root, permission_mode: 'acceptEdits' }, 'Первая задача');
  assert.equal(runner.write(id, 'Уточнение на ходу'), true);
  await waitFor(() => !runner.isRunning(id));
  const input = JSON.parse(fs.readFileSync(capture, 'utf8')).map(line => JSON.parse(line));
  assert.equal(input.length, 2);
  assert.equal(input[1].message.content[0].text, 'Уточнение на ходу');
  assert.equal(h.get('SELECT status FROM runs WHERE chat_id=?', id).status, 'done');
});

// Фейковый Claude по протоколу 2.1.x: каждое сообщение из stdin — отдельный ход;
// с --replay-user-messages эхо приходит, когда сообщение забрано в работу.
const fakeClaude = (bin, { echo = true, turnMs = 150 } = {}) => {
  const fake = path.join(bin, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}
let buf='', queue=[], busy=false;
const turn=()=>{ if(busy||!queue.length) return; busy=true; const m=queue.shift();
  ${echo ? "console.log(JSON.stringify({type:'user',message:m.message}));" : ''}
  setTimeout(()=>{ console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'ответ на: '+m.message.content[0].text}]}}));
    console.log(JSON.stringify({type:'result',usage:{},is_error:false})); busy=false; turn(); }, ${turnMs}); };
process.stdin.on('data',d=>{ buf+=d; let i; while((i=buf.indexOf('\\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1); if(l) { queue.push(JSON.parse(l)); turn(); } } });
process.stdin.on('end',()=>{ const wait=setInterval(()=>{ if(!busy&&!queue.length){ clearInterval(wait); process.exit(0); } },20); });
`, { mode: 0o755 });
};
const setup = (t, opts, extra = {}) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.claude-steering-'));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fakeClaude(bin, opts);
  const db = open(path.join(root, 'data')), h = helpers(db);
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', root, 'TE', 1);
  const id = crypto.randomUUID();
  h.run('INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES(?,?,?,?,?)', id, 1, 'claude', 1, 1);
  const events = [];
  const runner = new Runner({ h, hub: { send: (type, d) => events.push({ type, ...d }) }, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, root, ...extra });
  t.after(() => { runner.cancel(id); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { h, id, runner, root, events };
};

test('Claude: уточнение на ходу подтверждается эхом и обрабатывается тем же процессом', async t => {
  const { h, id, runner, root, events } = setup(t);
  runner.start({ id, provider: 'claude', cwd: root, permission_mode: 'acceptEdits' }, 'Первая задача');
  const m = runner.save(id, null, 'user', 'text', 'Уточнение', { steer: 'sent' });
  assert.equal(runner.write(id, 'Уточнение', [], { msgId: m.id }), true);
  await waitFor(() => !runner.isRunning(id));
  assert.equal(JSON.parse(h.get('SELECT json FROM messages WHERE id=?', m.id).json).steer, 'accepted');
  assert.ok(events.some(e => e.type === 'message-patch' && e.id === m.id && e.json.steer === 'accepted'));
  const answers = h.all("SELECT text FROM messages WHERE chat_id=? AND role='assistant'", id).map(r => r.text);
  assert.deepEqual(answers, ['ответ на: Первая задача', 'ответ на: Уточнение']);
});

test('Claude: после закрытия stdin запись честно не принимается', async t => {
  const { id, runner, root } = setup(t, { turnMs: 400 });
  runner.start({ id, provider: 'claude', cwd: root, permission_mode: 'acceptEdits' }, 'Задача');
  await waitFor(() => runner.active.get(id)?.inputClosed);
  assert.equal(runner.canWrite(id), false);
  assert.equal(runner.write(id, 'поздно'), false);
  await waitFor(() => !runner.isRunning(id));
});

test('Claude: незабранное уточнение возвращается в очередь, а не теряется', async t => {
  const lost = [];
  const { h, id, runner, root } = setup(t, { echo: false, turnMs: 50 }, { onUndelivered: (chat, texts) => lost.push(...texts) });
  runner.start({ id, provider: 'claude', cwd: root, permission_mode: 'acceptEdits' }, 'Задача');
  const m = runner.save(id, null, 'user', 'text', 'Не дошло', { steer: 'sent' });
  runner.write(id, 'Не дошло', [], { msgId: m.id });
  await waitFor(() => runner.isRunning(id) && runner.active.get(id)?.sawResult);
  runner.cancel(id);
  await waitFor(() => !runner.isRunning(id));
  assert.deepEqual(lost, ['Не дошло']);
  assert.equal(JSON.parse(h.get('SELECT json FROM messages WHERE id=?', m.id).json).steer, 'requeued');
});
