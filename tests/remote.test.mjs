import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as remote from '../lib/remote.mjs';

const mem = () => { const m = new Map(); return { setting: (k, v) => v === undefined ? m.get(k) : m.set(k, v) }; };
const req = (host, peer = '100.64.1.2', xff) => ({ headers: { host, ...(xff ? { 'x-forwarded-for': xff } : {}) }, socket: { remoteAddress: peer } });

test('проводник: выключатель на стороне Depo и настоящий адрес клиента', () => {
  const h = mem();
  assert.throws(() => remote.set(h, { enabled: true }), /домен/);
  assert.throws(() => remote.set(h, { domain: 'не домен' }), /Домен/);
  assert.throws(() => remote.set(h, { domain: 'depo.example.ru', relay_ip: '999.1.1.1' }), /IP/);
  remote.set(h, { domain: 'https://Depo.Example.ru/', relay_ip: '203.0.113.10' });
  let cfg = remote.get(h);
  assert.equal(cfg.domain, 'depo.example.ru');
  assert.equal(cfg.enabled, false);
  assert.match(remote.gate(cfg, req('depo.example.ru')), /выключен/);
  assert.equal(remote.gate(cfg, req('100.64.0.10:4620')), null, 'по NetBird напрямую — пускаем всегда');
  remote.set(h, { enabled: true });
  cfg = remote.get(h);
  assert.equal(remote.gate(cfg, req('depo.example.ru')), null);
  assert.equal(remote.clientIp(cfg, req('depo.example.ru', '100.64.9.9', '5.6.7.8, 100.64.9.9')), '5.6.7.8');
  assert.equal(remote.clientIp(cfg, req('depo.example.ru', '192.168.1.5', '5.6.7.8')), '192.168.1.5', 'чужому X-Forwarded-For не верим');
  assert.equal(remote.clientIp(cfg, req('localhost', '100.64.9.9', '5.6.7.8')), '100.64.9.9');
  assert.match(remote.relayCompose({ target: '100.64.0.10', port: 4620 }), /TCP:100\.64\.0\.10:4620/);

  // по адресу проводника в NetBird — даже с поддельным Host
  h.setting('remote', JSON.stringify({ ...remote.get(h), enabled: false, relay_peer: '100.64.0.20' }));
  cfg = remote.get(h);
  assert.match(remote.gate(cfg, req('100.64.0.10', '100.64.0.20')), /выключен/);
  assert.match(remote.gate(cfg, req('203.0.113.10:4621', '1.2.3.4')), /выключен/, 'по IP проводника в Host — тоже снаружи');
  assert.equal(remote.gate(cfg, req('100.64.0.10', '100.64.0.30')), null, 'другие узлы NetBird — как раньше');
});

test('проводник находится в netbird status по имени depo-relay', async () => {
  const h = mem();
  const r = await remote.detectRelayPeer(h, { status: async () => ({ fqdn: 'depo-host.netbird.cloud', peers: { details: [
    { fqdn: 'pc-home.netbird.cloud', netbirdIp: '100.64.0.30' }, { fqdn: 'depo-relay.netbird.cloud', netbirdIp: '100.64.0.20', status: 'Connected' }] } }) });
  assert.equal(r.ip, '100.64.0.20');
  assert.equal(remote.get(h).relay_peer, '100.64.0.20');
});

test('три неверных пароля снаружи выключают удалённый доступ; включение обнуляет счётчик', () => {
  const m = new Map(), h = { setting: (k, v) => v === undefined ? m.get(k) : m.set(k, v) };
  remote.set(h, { domain: 'depo.example.org', enabled: true });
  m.set('remote_max_fails', '3');
  assert.equal(remote.loginFailed(h, '1.1.1.1').locked, false);
  assert.equal(remote.loginFailed(h, '2.2.2.2').locked, false);
  const r = remote.loginFailed(h, '3.3.3.3');
  assert.equal(r.locked, true);
  assert.equal(remote.get(h).enabled, false);
  assert.ok(remote.get(h).locked_at);
  remote.set(h, { enabled: true });
  assert.equal(remote.get(h).locked_at, null);
  assert.equal(remote.loginFailed(h, '4.4.4.4').locked, false, 'после включения счёт заново');
  assert.ok(remote.relayPublic('/') && remote.relayPublic('/api/login') && remote.relayPublic('/icons/icon-180.png') && remote.relayPublic('/enter', '/enter'));
  assert.ok(!remote.relayPublic('/health') && !remote.relayPublic('/api/state') && !remote.relayPublic('/ca.crt') && !remote.relayPublic('/app.js') && !remote.relayPublic('/login'));
  // по умолчанию — сразу после первой ошибки
  m.delete('remote_max_fails'); remote.set(h, { enabled: true });
  assert.equal(remote.loginFailed(h, '5.5.5.5').locked, true);
  assert.equal(remote.loginPath(h), '/enter');
  assert.throws(() => remote.setLoginPath(h, '/api'), /занят/);
  assert.equal(remote.setLoginPath(h, 'secret-door'), '/secret-door');
});
