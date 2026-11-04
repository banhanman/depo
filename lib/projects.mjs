// Проект — это настоящая папка на малине. Запись в базе только описывает её.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
// Куда пускать: домашний каталог, но не чужие служебные места
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DENY = [
  path.join(HOME, '.claude'),
  path.join(HOME, '.codex'),
  path.join(HOME, '.gemini'),
  path.join(HOME, '.kimi-code'),
  path.join(HOME, '.ssh'),
  path.join(ROOT, 'data'),
];

export function expand(p) {
  let s = String(p || '').trim();
  if (s.startsWith('~')) s = path.join(HOME, s.slice(1));
  return path.resolve(s);
}
export const shorten = p => (p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p === HOME ? '~' : p);

export function checkPath(p) {
  const abs = expand(p);
  if (!abs.startsWith(HOME + '/') && abs !== HOME) return { ok: false, error: 'Папка должна быть внутри домашнего каталога.' };
  if (DENY.some(d => abs === d || abs.startsWith(d + '/'))) return { ok: false, error: 'Эта папка служебная, её подключать нельзя.' };
  return { ok: true, abs };
}

export function ensureDir(abs, create) {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return { ok: false, error: 'По этому пути не папка.' };
    return { ok: true, created: false };
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, error: e.message };
    if (!create) return { ok: false, error: 'Папки нет. Поставь галочку «создать», если нужно её завести.' };
    try { fs.mkdirSync(abs, { recursive: true }); return { ok: true, created: true }; }
    catch (e2) { return { ok: false, error: e2.message }; }
  }
}

export function glyphFor(name, taken = []) {
  const clean = String(name).replace(/[^\p{L}\p{N} _-]/gu, ' ').trim();
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  const cand = [
    words.length > 1 ? (words[0][0] + words[1][0]) : clean.slice(0, 2),
    clean.slice(0, 2), clean.slice(0, 1) + (clean.slice(2, 3) || 'X'),
  ].map(s => s.toUpperCase().slice(0, 2)).filter(Boolean);
  for (const c of cand) if (!taken.includes(c)) return c;
  for (let i = 1; i < 100; i++) { const c = (cand[0] || 'PR')[0] + i; if (!taken.includes(c)) return c; }
  return 'PR';
}

// Список подпапок дома — чтобы подключать существующие проекты из интерфейса
export function suggestions(known = []) {
  const out = [];
  for (const dir of [HOME]) {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (!it.isDirectory() || it.name.startsWith('.')) continue;
      const abs = path.join(dir, it.name);
      if (!checkPath(abs).ok || known.includes(abs)) continue;
      let mtime = 0, marks = [];
      try { mtime = fs.statSync(abs).mtimeMs; } catch { }
      for (const m of ['package.json', '.git', 'CLAUDE.md', 'pyproject.toml'])
        if (fs.existsSync(path.join(abs, m))) marks.push(m);
      out.push({ path: abs, short: shorten(abs), name: it.name, mtime, marks });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 40);
}

// Проводник для «Нового проекта»: подпапки внутри домашнего каталога, без скрытых и служебных.
export function browse(p, connected = []) {
  const chk = checkPath(p || HOME);
  if (!chk.ok) return { ok: false, error: chk.error };
  let entries;
  try { entries = fs.readdirSync(chk.abs, { withFileTypes: true }); }
  catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'Такой папки нет.' : e.message }; }
  const dirs = entries
    .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(chk.abs, e.name))
    .filter(d => { try { return fs.statSync(d).isDirectory() && checkPath(d).ok; } catch { return false; } })
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .slice(0, 300)
    .map(d => {
      const marks = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'docker-compose.yml', 'AGENTS.md', 'CLAUDE.md']
        .filter(f => fs.existsSync(path.join(d, f))).map(f => f === '.git' ? 'git' : f.replace(/\..*$/, ''));
      return { name: path.basename(d), path: d, short: shorten(d), marks, connected: connected.includes(d) };
    });
  const parent = chk.abs === HOME ? null : path.dirname(chk.abs);
  return { ok: true, path: chk.abs, short: shorten(chk.abs), parent, parent_short: parent ? shorten(parent) : null, dirs };
}
