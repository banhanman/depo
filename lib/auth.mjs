import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const SESSION_DAYS = 30;
const COOKIE = 'depo_session';

const hash = (pass, salt) =>
  crypto.scryptSync(pass, Buffer.from(salt, 'hex'), SCRYPT.keylen, SCRYPT).toString('hex');

export function createUser(h, login, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  h.run('INSERT INTO users(login,pass_hash,salt,created_at) VALUES(?,?,?,?)',
    login, hash(password, salt), salt, Date.now());
  return h.get('SELECT * FROM users WHERE login=?', login);
}

export function setPassword(h, userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  h.run('UPDATE users SET pass_hash=?, salt=? WHERE id=?', hash(password, salt), salt, userId);
  h.run('DELETE FROM sessions WHERE user_id=?', userId);
}

export function verify(h, login, password) {
  const u = h.get('SELECT * FROM users WHERE login=?', login);
  const probe = hash(password, u ? u.salt : '00'.repeat(16));
  if (!u) return null;
  const a = Buffer.from(probe, 'hex'), b = Buffer.from(u.pass_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

export function startSession(h, userId, agent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = Date.now();
  h.run('INSERT INTO sessions(token,user_id,created_at,last_seen,agent) VALUES(?,?,?,?,?)',
    token, userId, t, t, (agent || '').slice(0, 200));
  return token;
}

export function readSession(h, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const s = h.get('SELECT * FROM sessions WHERE token=?', token);
  if (!s) return null;
  if (Date.now() - s.created_at > SESSION_DAYS * 864e5) { h.run('DELETE FROM sessions WHERE token=?', token); return null; }
  if (Date.now() - s.last_seen > 60e3) h.run('UPDATE sessions SET last_seen=? WHERE token=?', Date.now(), token);
  return { ...s, user: h.get('SELECT id,login FROM users WHERE id=?', s.user_id) };
}

export const endSession = (h, req) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) h.run('DELETE FROM sessions WHERE token=?', token);
};

export const cookieHeader = (token, secure) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function parseCookies(raw) {
  const out = {};
  for (const part of (raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const attempts = new Map();
export function throttle(key) {
  const t = Date.now(), e = attempts.get(key);
  if (!e || t - e.first > 15 * 60e3) { attempts.set(key, { first: t, n: 1 }); return { ok: true }; }
  e.n++;
  if (e.n > 10) return { ok: false, wait: Math.ceil((e.first + 15 * 60e3 - t) / 1000) };
  return { ok: true };
}
export const resetThrottle = key => attempts.delete(key);
