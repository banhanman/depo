import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kimiArgs } from '../lib/runner.mjs';
import { kimiEnv } from '../lib/accounts.mjs';

test('Kimi: модель, сессия и режим плана уходят аргументами CLI', () => {
  const a = kimiArgs({ model: 'k3', permission_mode: 'plan' }, 'задача');
  assert.deepEqual(a.slice(0, 2), ['-m', 'k3']);
  assert.ok(a.includes('--plan'));
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.deepEqual(a.slice(-2), ['-p', 'задача']);

  const plain = kimiArgs({}, 'x');
  assert.ok(!plain.includes('-m'));
  assert.ok(!plain.includes('--plan'));

  const resumed = kimiArgs({ kimi_session: 'sess-1', model: 'k5' }, 'x');
  assert.deepEqual(resumed.slice(0, 2), ['-S', 'sess-1']);
  assert.deepEqual(resumed.slice(2, 4), ['-m', 'k5']);
});

test('Kimi: раздумья уходят в KIMI_MODEL_THINKING_EFFORT', () => {
  assert.equal(kimiEnv({}, 'high').KIMI_MODEL_THINKING_EFFORT, 'high');
  assert.equal(kimiEnv({}, '').KIMI_MODEL_THINKING_EFFORT, undefined, 'без раздумья переменная не появляется');

  const old = process.env.DEPO_KIMI_PROXY;
  process.env.DEPO_KIMI_PROXY = 'http://127.0.0.1:7890';
  try {
    const proxied = kimiEnv({}, '');
    assert.equal(proxied.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(proxied.HTTPS_PROXY, 'http://127.0.0.1:7890');
  } finally {
    if (old === undefined) delete process.env.DEPO_KIMI_PROXY; else process.env.DEPO_KIMI_PROXY = old;
  }
});
