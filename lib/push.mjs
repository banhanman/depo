// Web Push без внешних зависимостей: VAPID-подпись (ES256) и шифрование aes128gcm (RFC 8291) на node:crypto.
// Подписки лежат в таблице push_subs, ключи VAPID — в settings (генерируются один раз).
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const fromB64u = s => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Пара ключей VAPID для этого сервера. Приватный наружу не уходит — в браузер отдаём только publicKey.
export function ensureKeys(h) {
  let pub = h.setting('vapid_pub');
  if (pub && h.setting('vapid_priv')) return { publicKey: pub };
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.privateKey.export({ format: 'jwk' });
  pub = b64u(Buffer.concat([Buffer.from([0x04]), fromB64u(jwk.x), fromB64u(jwk.y)]));
  h.setting('vapid_pub', pub);
  h.setting('vapid_priv', JSON.stringify(jwk));
  return { publicKey: pub };
}

// JWT для заголовка Authorization: vapid t=<jwt>,k=<pub>. aud — origin push-сервиса, жить должен меньше суток.
export function vapidJwt(endpoint, privJwk) {
  const data = [
    b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })),
    b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:depo@localhost' })),
  ].join('.');
  const sig = crypto.sign('sha256', Buffer.from(data), { key: crypto.createPrivateKey({ key: privJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64u(sig)}`;
}

// Шифрование тела по RFC 8291 (aes128gcm): ECDH P-256 с ключом подписки, HKDF на HMAC-SHA-256, AES-128-GCM.
export function encrypt(sub, payload) {
  const uaPub = fromB64u(sub.keys.p256dh);
  const auth = fromB64u(sub.keys.auth);
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPub = as.getPublicKey();
  const prkKey = hmac(auth, as.computeSecret(uaPub));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);  // 0x02 — последняя запись без padding
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, enc]);
}

// Одна доставка. 404/410 — подписка мертва, удаляем; остальные ошибки просто логируем.
export async function sendOne(h, row, payload) {
  const { publicKey } = ensureKeys(h);
  const res = await fetch(row.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      'Content-Encoding': 'aes128gcm',
      Authorization: `vapid t=${vapidJwt(row.endpoint, JSON.parse(h.setting('vapid_priv')))},k=${publicKey}`,
    },
    body: encrypt({ keys: JSON.parse(row.keys) }, payload),
  });
  if (res.status === 404 || res.status === 410) h.run('DELETE FROM push_subs WHERE endpoint=?', row.endpoint);
  else if (res.status >= 400) throw new Error(`push-сервис ответил HTTP ${res.status}`);
}

// Фан-аут по всем подпискам. Fire-and-forget: уведомление не должно тормозить ход агента.
export function broadcast(h, msg) {
  const subs = h.all('SELECT endpoint, keys FROM push_subs');
  if (!subs.length) return;
  const payload = JSON.stringify(msg);
  for (const row of subs) sendOne(h, row, payload).catch(e => h.log('warn', 'push', e.message));
}

export function state(h) {
  return { key: ensureKeys(h).publicKey, subs: h.get('SELECT COUNT(*) n FROM push_subs').n };
}

export function subscribe(h, sub) {
  const endpoint = String(sub?.endpoint || '');
  const keys = { p256dh: String(sub?.keys?.p256dh || ''), auth: String(sub?.keys?.auth || '') };
  if (!/^https:\/\/[\w.-]+(?::\d+)?\//.test(endpoint) || endpoint.length > 2000) throw new Error('Некорректный endpoint подписки.');
  if (fromB64u(keys.p256dh).length !== 65 || fromB64u(keys.auth).length !== 16) throw new Error('Некорректные ключи подписки.');
  h.run('INSERT INTO push_subs(endpoint,keys,created_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys',
    endpoint, JSON.stringify(keys), Date.now());
}

export function unsubscribe(h, endpoint) {
  if (endpoint) h.run('DELETE FROM push_subs WHERE endpoint=?', endpoint);
}
