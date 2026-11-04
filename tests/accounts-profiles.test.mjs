// Несколько аккаунтов на агента: снимок текущего входа, добавление, переключение — на подставном HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-acc-'));
process.env.HOME = home;
process.env.KIMI_CODE_HOME = path.join(home, '.kimi-code');
const acc = await import('../lib/accounts.mjs');
const data = path.join(home, 'data');
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const write = (rel, obj) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
const loginClaude = (email, token) => {
  write('.claude/.credentials.json', { claudeAiOauth: { accessToken: token, subscriptionType: 'max' } });
  const cj = fs.existsSync(path.join(home, '.claude.json')) ? JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) : { numStartups: 7 };
  cj.oauthAccount = { emailAddress: email, displayName: email.split('@')[0] };
  write('.claude.json', cj);
};

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('почта видна у всех агентов', () => {
  loginClaude('a@x.ru', 'tok-a');
  write('.codex/auth.json', { tokens: { id_token: jwt({ email: 'c@x.ru', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }), account_id: '1' } });
  write('.gemini/oauth_creds.json', { refresh_token: 'r'.repeat(20) });
  write('.gemini/google_accounts.json', { active: 'g@x.ru', old: [] });
  write('.kimi-code/credentials/k.json', { access_token: jwt({ user_id: 'user-123456' }) });
  assert.equal(acc.current('claude').email, 'a@x.ru');
  assert.equal(acc.current('codex').email, 'c@x.ru');
  assert.equal(acc.current('codex').plan, 'plus');
  assert.equal(acc.current('gemini').email, 'g@x.ru');
  assert.equal(acc.current('kimi').name, 'id 123456');
});

test('Claude: добавить второй аккаунт и переключаться без потери токенов и почты', async () => {
  assert.equal(acc.capture(data, 'claude'), 'a@x.ru');
  acc.detach(data, 'claude');
  assert.equal(acc.ready('claude'), false);
  loginClaude('b@x.ru', 'tok-b');
  acc.capture(data, 'claude');
  let list = acc.list(data, 'claude');
  assert.deepEqual(list.map(p => [p.email, p.active]), [['b@x.ru', true], ['a@x.ru', false]]);

  // CLI тем временем обновил токен у b — при переключении свежий токен должен сохраниться
  write('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'tok-b2', subscriptionType: 'max' } });
  await acc.use(data, 'claude', 'a@x.ru', { meters: { limits: [{ label: 'Сессия · 5 ч', pct: 40 }] } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'tok-a');
  const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.equal(cj.oauthAccount.emailAddress, 'a@x.ru');
  assert.equal(cj.numStartups, 7, 'остальной .claude.json не трогаем');
  list = acc.list(data, 'claude');
  const b = list.find(p => p.email === 'b@x.ru');
  assert.equal(b.meters.limits[0].pct, 40, 'у ушедшего аккаунта остались последние лимиты');

  await acc.use(data, 'claude', 'b@x.ru');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/.credentials.json'), 'utf8')).claudeAiOauth.accessToken, 'tok-b2');
});

test('Gemini и Kimi тоже переключаются', async () => {
  acc.capture(data, 'gemini');
  acc.detach(data, 'gemini');
  write('.gemini/oauth_creds.json', { refresh_token: 's'.repeat(20) });
  write('.gemini/google_accounts.json', { active: 'h@x.ru', old: [] });
  await acc.use(data, 'gemini', 'g@x.ru');
  assert.equal(acc.current('gemini').email, 'g@x.ru');

  acc.capture(data, 'kimi');
  acc.detach(data, 'kimi');
  assert.equal(acc.ready('kimi'), false);
  write('.kimi-code/credentials/other.json', { access_token: jwt({ user_id: 'user-999999' }) });
  await acc.use(data, 'kimi', 'user-123456');
  assert.deepEqual(fs.readdirSync(path.join(home, '.kimi-code/credentials')), ['k.json']);
  assert.equal(acc.current('kimi').name, 'id 123456');
});

test('профиль не может писать вне файлов входа', async () => {
  const f = path.join(data, 'accounts', 'codex', 'evil.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ v: 2, files: { '.bashrc': 'rm -rf ~' } }));
  await assert.rejects(acc.use(data, 'codex', 'evil'), /повреждён/);
  assert.equal(fs.existsSync(path.join(home, '.bashrc')), false);
});
