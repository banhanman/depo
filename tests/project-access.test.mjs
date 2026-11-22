import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, fixOwner } from '../lib/projects.mjs';

test('папку, закрытую для записи, не подключаем и подсказываем, как вернуть её себе', { skip: process.getuid?.() === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-ro-'));
  fs.chmodSync(dir, 0o555);
  try {
    const r = ensureDir(dir, false);
    assert.equal(r.ok, false);
    assert.match(r.error, /закрыта для записи/);
    assert.equal(r.fix_owner, dir);
  } finally { fs.chmodSync(dir, 0o755); fs.rmSync(dir, { recursive: true }); }
});

test('обычная папка подключается как раньше', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-rw-'));
  try { assert.deepEqual(ensureDir(dir, false), { ok: true, created: false }); }
  finally { fs.rmSync(dir, { recursive: true }); }
});

test('«Вернуть себе» трогает только root-файлы внутри папки, без перехода по ссылкам и на другие диски', async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.depo-fix-'));
  try {
    const calls = [];
    const r = await fixOwner(dir, { run: async (cmd, args) => { calls.push([cmd, ...args]); } });
    assert.equal(r.ok, true);
    const me = `${process.getuid()}:${process.getgid()}`;
    assert.deepEqual(calls, [['sudo', '-n', 'find', fs.realpathSync(dir), '-xdev', '-user', 'root', '-exec', 'chown', '-h', me, '{}', '+']]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('«Вернуть себе» не трогает домашний каталог целиком, чужие места и служебные папки', async () => {
  const run = async () => { throw new Error('не должно вызываться'); };
  for (const p of [os.homedir(), '/etc', path.join(os.homedir(), '.ssh'), path.join(os.homedir(), 'нет-такой-папки-depo')]) {
    const r = await fixOwner(p, { run });
    assert.equal(r.ok, false, p);
  }
});

test('если sudo не дал прав, подсказываем команду для терминала', async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.depo-fix-'));
  try {
    const r = await fixOwner(dir, { run: async () => { throw new Error('sudo: a password is required'); } });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes(`sudo chown -R ${os.userInfo().username}: `), r.error);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
