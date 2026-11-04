import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { open, helpers } from '../lib/db.mjs';
import * as push from '../lib/push.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-push-'));
const h = helpers(open(tmp));

const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Подписчик со своей парой P-256 и auth-секретом — как настоящий браузер.
function makeSubscriber(endpoint = 'https://push.example/sub/1') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  return {
    ua,
    auth: crypto.randomBytes(16),
    sub: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: '' } },
  };
}
const withAuth = s => (s.sub.keys.auth = b64u(s.auth), s);

// Расшифровка aes128gcm на стороне «браузера» — зеркало push.encrypt.
function decrypt(sub, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const enc = body.subarray(21 + idlen);
  const prkKey = hmac(sub.auth, sub.ua.computeSecret(asPub));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(enc.subarray(enc.length - 16));
  const plain = Buffer.concat([d.update(enc.subarray(0, enc.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString();
}

test('ключи VAPID генерируются один раз и сохраняются', () => {
  const a = push.ensureKeys(h);
  assert.equal(fromB64u(a.publicKey).length, 65);
  assert.equal(fromB64u(a.publicKey)[0], 4);
  assert.equal(push.ensureKeys(h).publicKey, a.publicKey);
});

test('VAPID JWT подписан ES256 и проверяется публичным ключом', () => {
  push.ensureKeys(h);
  const jwt = push.vapidJwt('https://fcm.googleapis.com/fcm/send/abc', JSON.parse(h.setting('vapid_priv')));
  const [head, pay, sig] = jwt.split('.');
  assert.deepEqual(JSON.parse(fromB64u(head).toString()), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(fromB64u(pay).toString());
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  const pub = crypto.createPublicKey({ key: JSON.parse(h.setting('vapid_priv')), format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${pay}`), { key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(sig)));
});

test('шифрование aes128gcm расшифровывается подписчиком', () => {
  const s = withAuth(makeSubscriber());
  const body = push.encrypt(s.sub, JSON.stringify({ title: 'Depo', body: 'привет' }));
  assert.equal(body.length > 16 + 4 + 1 + 65 + 16, true);
  assert.equal(decrypt(s, body), JSON.stringify({ title: 'Depo', body: 'привет' }));
});

test('подписка сохраняется, отзывается и валидируется', () => {
  const s = withAuth(makeSubscriber());
  push.subscribe(h, s.sub);
  assert.equal(push.state(h).subs, 1);
  push.subscribe(h, s.sub); // повтор — не дубль
  assert.equal(push.state(h).subs, 1);
  push.unsubscribe(h, s.sub.endpoint);
  assert.equal(push.state(h).subs, 0);
  assert.throws(() => push.subscribe(h, { endpoint: 'http://evil.example/x', keys: s.sub.keys }));
  assert.throws(() => push.subscribe(h, { endpoint: 'https://push.example/x', keys: { p256dh: 'qq', auth: 'qq' } }));
});

test('мёртвая подписка (410) удаляется, живая получает тело', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url === '/dead' ? 410 : 201).end();
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    for (const name of ['live', 'dead']) {
      const s = withAuth(makeSubscriber(`http://127.0.0.1:${port}/${name}`));
      h.run('INSERT INTO push_subs(endpoint,keys,created_at) VALUES(?,?,?)', s.sub.endpoint, JSON.stringify(s.sub.keys), Date.now());
      await push.sendOne(h, { endpoint: s.sub.endpoint, keys: JSON.stringify(s.sub.keys) }, '{}');
    }
    assert.equal(got.length, 2);
    assert.equal(got[0].headers['content-encoding'], 'aes128gcm');
    assert.match(got[0].headers.authorization, /^vapid t=.+,k=.+/);
    const rows = h.all('SELECT endpoint FROM push_subs');
    assert.equal(rows.length, 1);
    assert.match(rows[0].endpoint, /\/live$/);
  } finally {
    srv.close();
    h.run('DELETE FROM push_subs');
  }
});

test('недоступный push-сервис не роняет broadcast', async () => {
  h.run('INSERT INTO push_subs(endpoint,keys,created_at) VALUES(?,?,?)',
    'http://127.0.0.1:1/x', JSON.stringify(withAuth(makeSubscriber()).sub.keys), Date.now());
  push.broadcast(h, { title: 'Depo', body: 'тест' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(push.state(h).subs, 1); // не 404/410 — подписку оставили
  h.run('DELETE FROM push_subs');
});
