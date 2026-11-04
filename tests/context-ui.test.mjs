import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('индикатор контекста не отображает суммарные токены хода как заполнение окна', () => {
  assert.match(app, /if \(!c \|\| !used \|\| c\.ctx_over\) \{ dot\.hidden = true; return; \}/);
  assert.match(app, /ctx_over: !!d\.over/);
  assert.doesNotMatch(app, /Math\.min\(999, Math\.round\(used \/ win \* 100\)\)/);
});
