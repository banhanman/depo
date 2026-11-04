// Удалённый доступ через «проводник» — арендованный сервер с NetBird и обратным прокси.
//
//   телефон (обычный интернет) ──https──▶ depo.example.ru (VPS: Nginx Proxy Manager, Let's Encrypt)
//        ──▶ пересыльщик на VPS ──туннель NetBird (WireGuard)──▶ Depo на этой машине :4620
//
// Depo знает свой домен и сам решает, пускать ли через него: запросы, пришедшие на домен проводника,
// при выключенном доступе получают 403 — выключатель работает, даже если проводник ещё жив.
// Адрес клиента для ограничения попыток входа берём из X-Forwarded-For только от проводника.
import os from 'node:os';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY = 'remote';
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function get(h) {
  let v = {}; try { v = JSON.parse(h.setting(KEY) || '{}'); } catch { }
  return { enabled: !!v.enabled, domain: v.domain || '', relay_ip: v.relay_ip || '', relay_peer: v.relay_peer || '', locked_at: v.locked_at || null };
}

// Проводник в NetBird — узел с именем depo-relay*. Его адрес в туннеле — главный признак «пришло снаружи»:
// заголовок Host можно подделать, адрес отправителя в WireGuard-туннеле — нет.
export function netbirdStatus() {
  return new Promise(res => execFile('netbird', ['status', '--json'], { timeout: 8000 }, (e, out) => {
    try { res(e ? null : JSON.parse(out)); } catch { res(null); }
  }));
}
export async function detectRelayPeer(h, { status = netbirdStatus } = {}) {
  const st = await status();
  const peer = (st?.peers?.details ?? []).find(p => /^depo-relay[.-]/.test(p.fqdn || ''));
  const ip = peer?.netbirdIp?.split('/')[0];
  if (!ip) return null;
  const cur = get(h);
  if (cur.relay_peer !== ip) h.setting(KEY, JSON.stringify({ ...cur, relay_peer: ip }));
  return { ip, fqdn: peer.fqdn, status: peer.status, self: st.fqdn ?? null };
}

export function set(h, { enabled, domain, relay_ip } = {}) {
  const cur = get(h);
  const d = domain === undefined ? cur.domain : String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const ip = relay_ip === undefined ? cur.relay_ip : String(relay_ip || '').trim();
  if (d && !DOMAIN_RE.test(d)) throw new Error('Домен выглядит неправильно — нужно вида depo.example.ru');
  if (ip && !(IP_RE.test(ip) && ip.split('.').every(n => +n <= 255))) throw new Error('IP сервера-проводника — четыре числа через точку');
  const on = enabled === undefined ? cur.enabled : !!enabled;
  if (on && !d) throw new Error('Сначала укажи домен.');
  const next = { enabled: on, domain: d, relay_ip: ip, relay_peer: cur.relay_peer, locked_at: on ? null : cur.locked_at };
  if (on && !cur.enabled) h.setting('remote_fails', '[]');   // включили осознанно — счётчик неверных паролей с нуля
  h.setting(KEY, JSON.stringify(next));
  return next;
}

const hostOf = req => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
const peerOf = req => (req.socket.remoteAddress || '').replace('::ffff:', '');
export const viaRelay = (cfg, req) => {
  if (cfg.relay_peer && peerOf(req) === cfg.relay_peer) return true;
  const host = hostOf(req);
  return !!host && (host === cfg.domain || host === cfg.relay_ip);
};

// ─── защита от подбора пароля снаружи ───
// Три неверных пароля через проводник (за сутки) — удалённый доступ выключается сам, остаётся только NetBird.
// Включить обратно — изнутри (настройки Depo по NetBird) или из Телеграма.
export const MAX_FAILS = 1;          // по умолчанию: неверный пароль снаружи — сразу выключаем
export const maxFails = h => Math.max(1, Math.min(5, +(h.setting('remote_max_fails') || MAX_FAILS)));
// Секретный адрес входа снаружи (сайт на домене — маскировка): по умолчанию /enter (поменяйте в настройках «Доступ»)
export const loginPath = h => {
  const p = String(h.setting('remote_login_path') || '/enter').trim();
  return /^\/[a-z0-9_-]{2,40}$/i.test(p) ? p : '/enter';
};
export function setLoginPath(h, p) {
  const v = '/' + String(p || '').trim().replace(/^\/+/, '');
  if (!/^\/[a-z0-9_-]{2,40}$/i.test(v)) throw new Error('Адрес входа — латиница, цифры, - и _, от 2 до 40 символов.');
  if (/^\/(api|site|icons|login|proto|app|sw|manifest|health|ca)/i.test(v)) throw new Error('Этот адрес занят самим Depo — выбери другой.');
  h.setting('remote_login_path', v);
  return v;
}
export function loginFailed(h, ip) {
  const cur = get(h);
  let f = []; try { f = JSON.parse(h.setting('remote_fails') || '[]'); } catch { }
  f = f.filter(x => Date.now() - x.at < 24 * 3600e3);
  f.push({ at: Date.now(), ip });
  h.setting('remote_fails', JSON.stringify(f.slice(-20)));
  if (f.length >= maxFails(h) && cur.enabled) {
    h.setting(KEY, JSON.stringify({ ...cur, enabled: false, locked_at: Date.now() }));
    return { locked: true, fails: f };
  }
  return { locked: false, left: Math.max(0, maxFails(h) - f.length) };
}
export const loginOk = h => h.setting('remote_fails', '[]');

// Пути, доступные снаружи без входа. Всё остальное до входа — пустой 404: ни версии, ни имени машины.
// Снаружи без входа: сайт-маскировка (/ и /site/*), секретный адрес входа и то, что нужно самой странице входа.
const PUBLIC_RELAY = /^\/(api\/login|api\/login\/code|api\/remote\/probe|app\.css|manifest\.webmanifest|icons\/[\w.-]+|site\/[\w.-]+)$/;
export const relayPublic = (pathname, lp = '/enter') => pathname === '/' || pathname === lp || PUBLIC_RELAY.test(pathname);

// Проверка «через домен отвечает именно этот Depo» — по секрету, без открытой /health
export function probeToken(h) {
  let t = h.setting('remote_probe');
  if (!t) { t = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, '0')).join(''); h.setting('remote_probe', t); }
  return t;
}

// null — пускаем; строка — причина отказа
export function gate(cfg, req) {
  if (!viaRelay(cfg, req)) return null;
  return cfg.enabled ? null : 'Удалённый доступ к Depo выключен в настройках.';
}

// реальный адрес клиента: за проводником — первый из X-Forwarded-For
export function clientIp(cfg, req) {
  const peer = peerOf(req);
  if (viaRelay(cfg, req) && (cfg.relay_peer ? peer === cfg.relay_peer : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(peer))) {
    const xff = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return peer;
}

// адрес этой машины в NetBird — его пересыльщик на проводнике и будет звать
export function netbirdIp() {
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (!/^(wt\d+|netbird)/.test(name)) continue;
    const v4 = (list || []).find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

// Проверка снаружи: домен смотрит на проводник? через него отвечает именно этот Depo?
// вход по IP проводника: https на порту Depo, сертификат проверяем нашим же CA
function getIp(ip, port, caFile, probe) {
  return new Promise(resolve => {
    const t = Date.now();
    let ca; try { ca = fs.readFileSync(caFile); } catch { }
    const req = https.get({ host: ip, port, path: '/api/remote/probe?t=' + encodeURIComponent(probe || ''), ca, timeout: 12000, agent: false }, r => {
      let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { } resolve({ status: r.statusCode, json: j, ms: Date.now() - t }); });
    });
    req.on('timeout', () => req.destroy(new Error('нет ответа за 12 с')));
    req.on('error', e => resolve({ error: e.code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'сертификат Depo ещё не знает этот IP — сохрани настройки, он перевыпустится' : (e.code || e.message) }));
  });
}

export async function check(cfg, { fetchFn = fetch, version, httpsPort = 4621, caFile, probe } = {}) {
  const out = { domain: cfg.domain, dns: null, dns_ok: null, https: null, same_depo: null, ms: null, error: null, ip: null };
  if (cfg.relay_ip) {
    const r = await getIp(cfg.relay_ip, httpsPort, caFile, probe);
    out.ip = { url: `https://${cfg.relay_ip}:${httpsPort}`, status: r.status ?? null, ms: r.ms ?? null, same: !!r.json?.ok, error: r.error ?? (r.status === 404 && !cfg.enabled ? 'доступ выключен — снаружи пустая страница' : r.status && r.status !== 200 ? `ответ ${r.status}` : null) };
  }
  if (!cfg.domain) return out;
  try { out.dns = (await dns.resolve4(cfg.domain)).join(', '); out.dns_ok = cfg.relay_ip ? out.dns.split(', ').includes(cfg.relay_ip) : null; }
  catch (e) { out.error = `DNS: ${e.code || e.message}`; }
  const t = Date.now();
  try {
    const r = await fetchFn(`https://${cfg.domain}/api/remote/probe?t=${encodeURIComponent(probe || '')}`, { signal: AbortSignal.timeout(12000) });
    out.ms = Date.now() - t;
    out.https = r.status;
    const d = await r.json().catch(() => null);
    out.same_depo = !!d?.ok;
    if (!r.ok && !out.error) out.error = r.status === 404 && !cfg.enabled ? 'доступ выключен — снаружи пустая страница, как и задумано' : `ответ ${r.status}`;
  } catch (e) { out.error ??= `HTTPS: ${e.cause?.code || e.message}`; }
  return out;
}

// Готовый docker-compose для проводника — подставлены адрес этой машины в NetBird и порты Depo.
//  forward-web — для домена: слушает только шлюз docker-сети обратного прокси (снаружи не виден);
//  forward-ip  — вход прямо по IP: https://IP:4621 со своим сертификатом Depo (тот же CA, что на телефоне).
export function relayCompose({ target, port = 4620, httpsPort = 4621, bind = '172.18.0.1', listen = 14620 }) {
  return `# Проводник для Depo: клиент NetBird + два пересыльщика. Остальные сервисы сервера не затрагивает.
# /opt/depo-relay/docker-compose.yml; рядом .env с NB_SETUP_KEY=...; запуск: docker compose up -d
# bind — шлюз docker-сети, где живёт обратный прокси (docker network inspect <сеть> → Gateway).
services:
  netbird:
    image: netbirdio/netbird:latest
    container_name: depo-relay-netbird
    restart: unless-stopped
    network_mode: host
    cap_add: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE]
    env_file: .env
    environment:
      - NB_HOSTNAME=depo-relay
    volumes:
      - netbird-client:/etc/netbird
  forward-web:
    image: alpine/socat:latest
    container_name: depo-relay-forward-web
    restart: unless-stopped
    network_mode: host
    depends_on: [netbird]
    entrypoint: ["sh", "-c"]
    # порт открывается, только когда Depo умеет выключатель доступа (401 на /api/remote)
    command:
      - |
        until wget -q -S -O /dev/null http://${target}:${port}/api/remote 2>&1 | grep -qE " (401|403) "; do sleep 20; done
        exec socat TCP-LISTEN:${listen},bind=${bind},fork,reuseaddr TCP:${target}:${port},connect-timeout=10
  forward-ip:
    image: alpine/socat:latest
    container_name: depo-relay-forward-ip
    restart: unless-stopped
    network_mode: host
    depends_on: [netbird]
    entrypoint: ["sh", "-c"]
    command:
      - |
        until wget -q -S -O /dev/null http://${target}:${port}/api/remote 2>&1 | grep -qE " (401|403) "; do sleep 20; done
        exec socat TCP-LISTEN:${httpsPort},fork,reuseaddr TCP:${target}:${httpsPort},connect-timeout=10
volumes:
  netbird-client:
`;
}
