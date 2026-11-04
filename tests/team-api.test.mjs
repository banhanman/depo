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

test('HTTP: настройки команды (модель, раздумья, указания Kimi) сохраняются и перечитываются', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.team-api-test-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(bin);
  // фоновые вызовы CLI (каталог Kimi и т.п.) завершаются мгновенно и не переживают тест
  for (const name of ['kimi', 'claude', 'codex', 'gemini']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  }
  const db = open(data); const h = helpers(db); auth.createUser(h, 'test', 'test-password'); db.close();

  const port = 20000 + Math.floor(Math.random() * 10000);
  const env = { ...process.env, HOME: home, DEPO_DATA_DIR: data, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1', HTTPS_PORT: String(port + 1) };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    for (let i = 0; i < 10 && fs.existsSync(root); i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { await new Promise(r => setTimeout(r, 200)); }
    }
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

  const cfg = (await call('/api/team/config')).value.config;
  const roles = cfg.roles.map(r => r.id === 'test'
    ? { ...r, model: 'kimi-code/k3', effort: 'high', instructions: 'Гоняй npm test дважды.\n\nПиши по-русски.' }
    : r);
  const saved = await call('/api/team/config', 'POST', { ...cfg, roles });
  assert.equal(saved.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.config.roles.find(r => r.id === 'test').instructions, 'Гоняй npm test дважды.\n\nПиши по-русски.');

  // перечитали после сохранения: значения на месте
  const testRole = (await call('/api/team/config')).value.config.roles.find(r => r.id === 'test');
  assert.equal(testRole.provider, 'kimi');
  assert.equal(testRole.model, 'kimi-code/k3');
  assert.equal(testRole.effort, 'high');
  assert.equal(testRole.instructions, 'Гоняй npm test дважды.\n\nПиши по-русски.');

  // мусор в указаниях отсекается при сохранении
  const dirty = await call('/api/team/config', 'POST', {
    ...cfg, roles: cfg.roles.map(r => r.id === 'test' ? { ...r, instructions: '  лишние пробелы\r\nи \r возвраты каретки  ' } : r),
  });
  assert.equal(dirty.status, 200, JSON.stringify(dirty.value));
  assert.equal(dirty.value.config.roles.find(r => r.id === 'test').instructions, 'лишние пробелы\nи  возвраты каретки');
});
