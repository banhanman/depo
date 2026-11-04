import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as tf from '../lib/twofa.mjs';

test('код из Телеграма: верный пускает, три неверных — заново; доверенное устройство запоминается', () => {
  const m = new Map(), h = { setting: (k, v) => v === undefined ? m.get(k) : m.set(k, v) };
  const a = tf.issue({ userId: 1, outside: true });
  assert.match(a.code, /^\d{6}$/);
  assert.equal(tf.verify(a.ticket, '000000' === a.code ? '111111' : '000000').ok, false);
  assert.deepEqual(tf.verify(a.ticket, a.code).ok, true);
  assert.equal(tf.verify(a.ticket, a.code).ok, false, 'код одноразовый');
  const b = tf.issue({ userId: 1 });
  const bad = b.code === '123456' ? '654321' : '123456';
  tf.verify(b.ticket, bad); tf.verify(b.ticket, bad);
  const r = tf.verify(b.ticket, bad);
  assert.equal(r.dead, true);
  assert.equal(tf.verify(b.ticket, b.code).ok, false, 'после трёх ошибок даже верный не принимается');
  const dev = tf.trust(h, 'Android Chrome');
  assert.equal(tf.isTrusted(h, dev), true);
  assert.equal(tf.isTrusted(h, 'чужое'), false);
  assert.ok(!JSON.stringify(tf.listDevices(h)).includes(dev), 'в базе только хэш');
  tf.forgetDevices(h);
  assert.equal(tf.isTrusted(h, dev), false);
});
