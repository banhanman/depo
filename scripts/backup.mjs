import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DEPO_DATA_DIR || path.join(ROOT, 'data');
const DEST = process.env.DEPO_BACKUP_DIR || path.join(os.homedir(), 'backups', 'depo');
const KEEP = +(process.env.DEPO_BACKUP_KEEP || 14);

const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)));

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const report = { at: Date.now(), ok: false };

try {
  if (!fs.existsSync(DEST)) fs.mkdirSync(DEST, { recursive: true });
  const probe = path.join(DEST, '.depo-probe');
  fs.writeFileSync(probe, stamp); fs.unlinkSync(probe);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-backup-'));
  const db = new DatabaseSync(path.join(DATA, 'depo.db'), { readOnly: true });
  db.exec(`VACUUM INTO '${path.join(tmp, 'depo.db').replace(/'/g, "''")}'`);
  db.close();

  for (const extra of ['uploads']) {
    const src = path.join(DATA, extra);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, extra), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, 'README.txt'),
    `Снимок Depo от ${new Date().toLocaleString('ru-RU')}\nХост: ${os.hostname()}\n` +
    `Восстановление: положить depo.db в ${DATA} при остановленном depo.service.\n`);

  const file = path.join(DEST, `depo-${stamp}.tar.gz`);
  await run('tar', ['-czf', file, '-C', tmp, '.']);
  fs.rmSync(tmp, { recursive: true, force: true });

  const size = fs.statSync(file).size;
  const old = fs.readdirSync(DEST).filter(f => /^depo-.*\.tar\.gz$/.test(f)).sort();
  const drop = old.slice(0, Math.max(0, old.length - KEEP));
  for (const f of drop) fs.unlinkSync(path.join(DEST, f));

  Object.assign(report, { ok: true, file, size, kept: old.length - drop.length, removed: drop.length });
  console.log(`бэкап: ${file} (${(size / 1048576).toFixed(1)} МБ), хранится ${report.kept}, удалено ${drop.length}`);
} catch (e) {
  report.error = e.message;
  console.error('бэкап не прошёл:', e.message);
}

try {
  const db = new DatabaseSync(path.join(DATA, 'depo.db'));
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('last_backup', JSON.stringify(report));
  db.prepare('INSERT INTO log(ts,level,scope,text) VALUES(?,?,?,?)')
    .run(Date.now(), report.ok ? 'info' : 'error', 'backup',
      report.ok ? `копия ${path.basename(report.file)} (${(report.size / 1048576).toFixed(1)} МБ)` : report.error);
  db.close();
} catch { }
process.exit(report.ok ? 0 : 1);
