import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inside, insideReal, list, read } from '../lib/files.mjs';

const sandbox = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  return { root, outside };
};

test('симлинк наружу не читается и не листится', async t => {
  const { root, outside } = sandbox(t);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  fs.symlinkSync(outside, path.join(root, 'linkdir'));
  await assert.rejects(() => read(root, 'link.txt'), /За пределы проекта/);
  await assert.rejects(() => list(root, 'linkdir'), /За пределы проекта/);
  await assert.rejects(() => insideReal(root, 'link.txt'), /За пределы проекта/);
});

test('обычные файлы и симлинки внутри проекта работают', async t => {
  const { root } = sandbox(t);
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'привет');
  fs.symlinkSync(path.join('sub', 'a.txt'), path.join(root, 'b.txt'));
  assert.equal((await read(root, 'sub/a.txt')).text, 'привет');
  assert.equal((await read(root, 'b.txt')).text, 'привет');
  assert.equal((await list(root, 'sub')).items.length, 1);
  assert.equal(inside(root, 'sub/a.txt'), path.join(root, 'sub', 'a.txt'));
});

test('несуществующая цель внутри проекта допускается (для загрузки)', async t => {
  const { root } = sandbox(t);
  assert.equal(await insideReal(root, 'new/file.txt'), path.join(root, 'new', 'file.txt'));
});

test('корень проекта через симлинк не мешает проверке', async t => {
  const { root, outside } = sandbox(t);
  const viaLink = path.join(outside, 'project-link');
  fs.symlinkSync(root, viaLink);
  fs.writeFileSync(path.join(root, 'a.txt'), 'привет');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'секрет');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  assert.equal((await read(viaLink, 'a.txt')).text, 'привет');
  await assert.rejects(() => read(viaLink, 'link.txt'), /За пределы проекта/);
});
