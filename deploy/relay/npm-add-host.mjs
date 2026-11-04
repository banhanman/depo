#!/usr/bin/env node
// Добавляет домен Depo в Nginx Proxy Manager через его API: Proxy Host → пересыльщик проводника,
// сертификат Let's Encrypt, Force SSL, без буферизации (живая лента ответов).
// Уже существующие хосты не трогает: если домен занят — останавливается.
//
//   NPM_URL=http://IP:81 NPM_USER=… NPM_PASS=… DOMAIN=depo.example.ru [WWW=1] [FORWARD_HOST=172.18.0.1] [FORWARD_PORT=14620] \
//   [LE_EMAIL=…] [CERT_ID=<готовый сертификат в NPM>] node npm-add-host.mjs [--check]
const { NPM_URL, NPM_USER, NPM_PASS, DOMAIN, FORWARD_HOST = '172.18.0.1', FORWARD_PORT = '14620', LE_EMAIL, WWW, CERT_ID } = process.env;
const check = process.argv.includes('--check');
if (!NPM_URL || !NPM_USER || !NPM_PASS || (!DOMAIN && !check)) { console.error('нужны NPM_URL, NPM_USER, NPM_PASS, DOMAIN'); process.exit(2); }

// выпуск сертификата идёт минуту-две — системный прокси может оборвать долгий запрос, ходим напрямую
process.env.NODE_USE_ENV_PROXY = '0';
const call = async (method, path, body, token) => {
  const r = await fetch(NPM_URL.replace(/\/$/, '') + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${d?.error?.message || JSON.stringify(d).slice(0, 300)}`);
  return d;
};

const { token } = await call('POST', '/tokens', { identity: NPM_USER, secret: NPM_PASS });
const hosts = await call('GET', '/nginx/proxy-hosts', null, token);
if (check) { console.log('вход в NPM ок; хосты:', hosts.map(h => h.domain_names.join(',')).join(' | ')); process.exit(0); }

const names = [DOMAIN.toLowerCase(), ...(WWW === '1' ? ['www.' + DOMAIN.toLowerCase()] : [])];
const busy = hosts.find(h => h.domain_names.some(n => names.includes(n)));
if (busy) { console.error(`домен уже есть в NPM (хост #${busy.id}) — ничего не меняю`); process.exit(1); }

const host = await call('POST', '/nginx/proxy-hosts', {
  domain_names: names, forward_scheme: 'http', forward_host: FORWARD_HOST, forward_port: +FORWARD_PORT,
  access_list_id: 0, certificate_id: 0, ssl_forced: false, caching_enabled: false, block_exploits: true,
  allow_websocket_upgrade: true, http2_support: true, hsts_enabled: false, hsts_subdomains: false,
  advanced_config: 'proxy_buffering off;\nproxy_read_timeout 1h;\nproxy_send_timeout 1h;\nclient_max_body_size 64m;',
  meta: {}, locations: [],
}, token);
console.log(`хост #${host.id} создан: ${names.join(', ')} → http://${FORWARD_HOST}:${FORWARD_PORT}`);

const cert = CERT_ID ? { id: +CERT_ID } : await call('POST', '/nginx/certificates', {
  provider: 'letsencrypt', nice_name: names[0], domain_names: names,
  meta: { dns_challenge: false },   // NPM 2.12+: почта для Let's Encrypt берётся из учётки NPM, старые поля он отвергает
}, token);
console.log(CERT_ID ? `взят готовый сертификат #${cert.id}` : `сертификат Let's Encrypt #${cert.id} выпущен`);
await call('PUT', `/nginx/proxy-hosts/${host.id}`, { certificate_id: cert.id, ssl_forced: true, http2_support: true }, token);
console.log(`https включён: https://${names[0]}`);
