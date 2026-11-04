// Свой экран терминала: проверяем то, из-за чего он и появился —
// перерисовка кадра не должна копиться простынёй.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen } from '../lib/vt.mjs';

test('очистка экрана стирает прошлый кадр', () => {
  const s = new Screen(40, 10);
  s.write('первый кадр\n');
  s.write('\x1b[2J\x1b[H' + 'второй кадр');
  assert.equal(s.text(), 'второй кадр');
});

test('курсор возвращается и переписывает строку', () => {
  const s = new Screen(40, 10);
  s.write('Выбери: вариант A');
  s.write('\x1b[1;1H\x1b[KВыбери: вариант B');
  assert.equal(s.text(), 'Выбери: вариант B');
});

test('цвета выбрасываются, текст остаётся', () => {
  const s = new Screen(40, 5);
  s.write('\x1b[31mкрасный\x1b[0m текст');
  assert.equal(s.text(), 'красный текст');
});

test('экран не растёт бесконечно — только то, что видно', () => {
  const s = new Screen(20, 4);
  for (let i = 1; i <= 20; i++) s.write(`строка ${i}\n`);
  const lines = s.text().split('\n');
  assert.ok(lines.length <= 4, `строк ${lines.length}`);
  assert.match(s.text(), /строка 20/);
});
