import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as tc from '../lib/tlscert.mjs';

test('перевыпуск сертификата тем же CA: новые имена добавляются, старые остаются', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-tls-t-'));
  try {
    const o = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });
    o('genrsa', '-out', 'ca.key', '2048');
    o('req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', '30', '-subj', '/CN=Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', 'ca.crt');
    fs.writeFileSync(path.join(dir, 's.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=IP:100.64.0.10,DNS:depo-host\n');
    o('genrsa', '-out', 'server.key', '2048');
    o('req', '-new', '-key', 'server.key', '-subj', '/CN=x', '-config', 's.cnf', '-out', 's.csr');
    o('x509', '-req', '-in', 's.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '30', '-extfile', 's.cnf', '-extensions', 'ext', '-out', 'server.crt');
    assert.equal(await tc.ensureSans(dir, ['100.64.0.10']), false, 'всё уже есть — не трогаем');
    assert.equal(await tc.ensureSans(dir, ['203.0.113.10', 'depo-host.netbird.cloud']), true);
    const sans = await tc.currentSans(dir);
    for (const n of ['100.64.0.10', 'depo-host', '203.0.113.10', 'depo-host.netbird.cloud']) assert.ok(sans.includes(n), n);
    execFileSync('openssl', ['verify', '-CAfile', 'ca.crt', 'server.crt'], { cwd: dir });   // подписан тем же CA
    assert.ok(fs.existsSync(path.join(dir, 'server.crt.prev')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
