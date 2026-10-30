import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache', 'data']);
const MAX_VIEW = 512 * 1024;

export function inside(root, rel) {
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('За пределы проекта нельзя.');
  return abs;
}

export async function list(root, rel = '.') {
  const abs = inside(root, rel);
  const items = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const it of items) {
    if (it.name.startsWith('.') && it.name !== '.env.example') continue;
    const full = path.join(abs, it.name);
    let size = 0, mtime = 0;
    try { const st = await fsp.stat(full); size = st.size; mtime = st.mtimeMs; } catch { continue; }
    out.push({
      name: it.name, dir: it.isDirectory(), size, mtime,
      rel: path.relative(root, full) || it.name,
      heavy: it.isDirectory() && SKIP.has(it.name),
    });
  }
  out.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, 'ru'));
  return { path: path.relative(root, abs), up: abs === root ? null : path.relative(root, path.dirname(abs)), items: out };
}

export async function read(root, rel) {
  const abs = inside(root, rel);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('Это папка.');
  if (st.size > MAX_VIEW) return { tooBig: true, size: st.size };
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) return { binary: true, size: st.size };
  return { text: buf.toString('utf8'), size: st.size, lines: buf.toString('utf8').split('\n').length };
}

const git = (root, args) => new Promise(res =>
  execFile('git', ['-C', root, ...args], { maxBuffer: 16 << 20, timeout: 20000 },
    (err, stdout) => res(err ? null : stdout)));

export async function diff(root) {
  const isRepo = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!isRepo) return { repo: false };
  const [stat, patch, branch] = await Promise.all([
    git(root, ['diff', '--stat', 'HEAD']),
    git(root, ['diff', 'HEAD']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean);
  return {
    repo: true, branch: (branch || '').trim(),
    stat: (stat || '').trim(), patch: (patch || '').slice(0, 400000), untracked: untracked.slice(0, 50),
  };
}
