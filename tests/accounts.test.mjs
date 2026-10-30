import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { current, kimiEnv, kimiReady, kimiSignature, logoutKimi } from '../lib/accounts.mjs';

test('Kimi: состояние входа читается из KIMI_CODE_HOME', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-kimi-'));
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  try {
    assert.equal(kimiReady(), false);
    assert.equal(current('kimi').ok, false);
    fs.writeFileSync(path.join(root, 'region.json'), JSON.stringify({ authState: 'logged-in', region: 'global' }));
    assert.equal(kimiReady(), true);
    assert.equal(current('kimi').ok, 'аккаунт Kimi');
    fs.writeFileSync(path.join(root, 'region.json'), JSON.stringify({ authState: 'logged-out', region: 'global' }));
    assert.equal(kimiReady(), false);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi: credentials важнее устаревшего logged-out в region.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-kimi-'));
  const previous = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  try {
    fs.mkdirSync(path.join(root, 'credentials'));
    fs.writeFileSync(path.join(root, 'region.json'), JSON.stringify({ authState: 'logged-out' }));
    const credential = path.join(root, 'credentials', 'kimi.json');
    fs.writeFileSync(credential, JSON.stringify({ refresh_token: 'test' }));
    assert.equal(kimiReady(), true);
    const before = kimiSignature();
    fs.appendFileSync(credential, ' ');
    assert.notEqual(kimiSignature(), before);
    fs.rmSync(credential);
    assert.equal(kimiReady(), false);
  } finally {
    if (previous === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi: отдельный прокси добавляется только в окружение Kimi', () => {
  const previous = process.env.DEPO_KIMI_PROXY;
  process.env.DEPO_KIMI_PROXY = 'http://127.0.0.1:2080';
  try {
    assert.deepEqual(kimiEnv({ PATH: '/bin' }), {
      PATH: '/bin', HTTP_PROXY: 'http://127.0.0.1:2080', HTTPS_PROXY: 'http://127.0.0.1:2080',
    });
    assert.equal(kimiEnv({}, 'low').KIMI_MODEL_THINKING_EFFORT, 'low');
  } finally {
    if (previous === undefined) delete process.env.DEPO_KIMI_PROXY;
    else process.env.DEPO_KIMI_PROXY = previous;
  }
});

test('Kimi: повторный выход не запускает CLI, если входа уже нет', async () => {
  let spawned = false;
  const result = await logoutKimi({ isReady: () => false, spawnFn: () => { spawned = true; } });
  assert.deepEqual(result, { ok: true });
  assert.equal(spawned, false);
});

test('Kimi: выход отправляет /logout и ждёт подтверждения CLI', async () => {
  let loggedIn = true;
  const writes = [];
  const child = new EventEmitter();
  child.stdin = { write: text => writes.push(text) };
  child.kill = () => { };
  const result = logoutKimi({
    isReady: () => loggedIn,
    spawnFn: () => child,
    startDelay: 5, pollMs: 2, timeoutMs: 200,
  });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(writes.includes('/logout\r'));
  loggedIn = false;
  assert.deepEqual(await result, { ok: true });
});
