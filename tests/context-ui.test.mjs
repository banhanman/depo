import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'app.css'), 'utf8');

test('индикатор контекста не отображает суммарные токены хода как заполнение окна', () => {
  assert.match(app, /if \(!c \|\| !used \|\| c\.ctx_over\) \{ dot\.hidden = true; return; \}/);
  assert.match(app, /ctx_over: !!d\.over/);
  assert.doesNotMatch(app, /Math\.min\(999, Math\.round\(used \/ win \* 100\)\)/);
});

test('мобильный индикатор лимитов оставляет сессию и не расширяет шапку', () => {
  assert.match(app, /g lim\$\{isSession\(l\) \? ' session' : ''\}/);
  assert.match(css, /#chip-gauge\{min-width:0;max-width:40vw;overflow-x:auto/);
  assert.match(css, /#chip-gauge:not\(:has\(\.tm\)\) \.g\.lim:not\(\.session\)\{display:none\}/);
  assert.match(css, /#chip-gauge:has\(\.tm\) \.g\.tm \.lb\{display:none\}/);
});
