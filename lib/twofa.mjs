// Подтверждение входа через Телеграм: с нового устройства после верного пароля в бота приходит
// 6-значный код. Устройство, подтвердившее код, запоминается (cookie depo_device + хэш в базе) —
// дальше код не спрашивается. Коды живут 5 минут, три попытки, хранятся только хэшами.
import crypto from 'node:crypto';

export const DEVICE_COOKIE = 'depo_device';
const TTL = 5 * 60e3, TRIES = 3;
const tickets = new Map();   // ticket -> { userId, codeHash, exp, tries, agent, ip, outside }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

export const enabled = h => h.setting('tg_2fa') === '1';
export const setEnabled = (h, on) => h.setting('tg_2fa', on ? '1' : '0');

function devices(h) { try { return JSON.parse(h.setting('trusted_devices') || '[]'); } catch { return []; } }
const saveDevices = (h, list) => h.setting('trusted_devices', JSON.stringify(list.slice(-30)));
export const listDevices = h => devices(h).map(d => ({ id: d.id.slice(0, 8), agent: d.agent, at: d.at, last: d.last }));

export function isTrusted(h, deviceId) {
  if (!deviceId) return false;
  const list = devices(h), d = list.find(x => x.id === sha(deviceId));
  if (!d) return false;
  if (Date.now() - (d.last || 0) > 3600e3) { d.last = Date.now(); saveDevices(h, list); }
  return true;
}
// новое доверенное устройство: возвращает значение cookie
export function trust(h, agent = '') {
  const raw = crypto.randomBytes(24).toString('base64url');
  saveDevices(h, [...devices(h), { id: sha(raw), agent: String(agent).slice(0, 120), at: Date.now(), last: Date.now() }]);
  return raw;
}
export const forgetDevices = h => saveDevices(h, []);
export const deviceCookie = (raw, secure) =>
  `${DEVICE_COOKIE}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${secure ? '; Secure' : ''}`;

export function issue({ userId, agent, ip, outside }) {
  for (const [k, t] of tickets) if (t.exp < Date.now()) tickets.delete(k);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const ticket = crypto.randomBytes(18).toString('base64url');
  tickets.set(ticket, { userId, codeHash: sha(code), exp: Date.now() + TTL, tries: 0, agent, ip, outside });
  return { ticket, code };
}

// { ok, userId } | { ok:false, error, dead }
export function verify(ticket, code) {
  const t = tickets.get(String(ticket || ''));
  if (!t || t.exp < Date.now()) { tickets.delete(ticket); return { ok: false, dead: true, error: 'Код устарел — войди заново.' }; }
  const good = crypto.timingSafeEqual(Buffer.from(sha(String(code || '').trim())), Buffer.from(t.codeHash));
  if (good) { tickets.delete(ticket); return { ok: true, userId: t.userId, outside: t.outside }; }
  if (++t.tries >= TRIES) { tickets.delete(ticket); return { ok: false, dead: true, error: 'Три неверных кода — войди заново.', outside: t.outside }; }
  return { ok: false, error: `Неверный код. Осталось попыток: ${TRIES - t.tries}.`, outside: t.outside };
}
export const kill = ticket => tickets.delete(String(ticket || ''));
export const pending = ticket => tickets.get(String(ticket || ''));
