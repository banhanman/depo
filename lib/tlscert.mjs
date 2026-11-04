// Сертификат https Depo: подписан своим CA (data/tls/ca.*), который уже стоит на телефоне.
// Когда появляются новые имена (IP проводника, имя машины в NetBird), перевыпускаем только серверный
// сертификат тем же CA — телефону ничего переустанавливать не нужно — и подменяем его на лету.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (cmd, args, opts = {}) => new Promise((res, rej) =>
  execFile(cmd, args, { timeout: 30000, ...opts }, (e, out, err) => e ? rej(new Error((err || e.message).trim().slice(0, 300))) : res(out)));

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const norm = s => String(s || '').trim().toLowerCase();

export async function currentSans(dir) {
  try {
    const out = await run('openssl', ['x509', '-in', path.join(dir, 'server.crt'), '-noout', '-ext', 'subjectAltName']);
    return [...out.matchAll(/(?:DNS:|IP Address:)([^,\s]+)/g)].map(m => norm(m[1]));
  } catch { return []; }
}

// wanted — имена и IP, которые обязательно должны быть в сертификате; уже имеющиеся сохраняются.
// true — сертификат перевыпущен.
export async function ensureSans(dir, wanted) {
  const want = [...new Set(wanted.map(norm).filter(Boolean))];
  if (!fs.existsSync(path.join(dir, 'ca.key')) || !fs.existsSync(path.join(dir, 'ca.crt'))) return false;
  const have = await currentSans(dir);
  if (want.every(w => have.includes(w))) return false;
  const all = [...new Set([...have, ...want, '127.0.0.1', 'localhost', os.hostname().toLowerCase()])];
  const san = all.map(x => (IPV4.test(x) ? 'IP:' : 'DNS:') + x).join(',');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-tls-'));
  try {
    const cnf = path.join(tmp, 'san.cnf');
    fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=${san}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n`);
    const key = path.join(tmp, 'server.key'), csr = path.join(tmp, 'server.csr'), crt = path.join(tmp, 'server.crt');
    await run('openssl', ['genrsa', '-out', key, '2048']);
    await run('openssl', ['req', '-new', '-key', key, '-subj', `/CN=Depo ${os.hostname()}`, '-config', cnf, '-out', csr]);
    await run('openssl', ['x509', '-req', '-in', csr, '-CA', path.join(dir, 'ca.crt'), '-CAkey', path.join(dir, 'ca.key'),
      '-CAcreateserial', '-CAserial', path.join(dir, 'ca.srl'), '-days', '825', '-sha256', '-extfile', cnf, '-extensions', 'ext', '-out', crt]);
    // старую пару сохраняем рядом — на случай отката
    for (const f of ['server.key', 'server.crt']) { try { fs.copyFileSync(path.join(dir, f), path.join(dir, f + '.prev')); } catch { } }
    fs.copyFileSync(key, path.join(dir, 'server.key')); fs.chmodSync(path.join(dir, 'server.key'), 0o600);
    fs.copyFileSync(crt, path.join(dir, 'server.crt'));
    return true;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
