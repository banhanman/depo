import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLessons, addLessons, init } from '../lib/memory.mjs';
import * as team from '../lib/team.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'depo-lessons-'));
const lessons = root => fs.readFileSync(path.join(root, '.depo/memory/LESSONS.md'), 'utf8').split('\n').filter(x => x.startsWith('- '));

test('parseLessons: блок УРОКИ, пункты, не больше трёх, «нет» — пусто', () => {
  assert.deepEqual(parseLessons('Итог.\nУРОКИ:\n- npm test перед ревью\n- 2) не трогать .env\n3. третий\n- четвёртый\n\nдальше'),
    ['npm test перед ревью', 'не трогать .env', 'третий']);
  assert.deepEqual(parseLessons('**УРОКИ:** нет'), []);
  assert.deepEqual(parseLessons('УРОКИ: одна строка'), ['одна строка']);
  assert.deepEqual(parseLessons('без блока'), []);
});

test('addLessons: дата и автор, без дублей, не больше 40 строк, попадает в AGENTS.md', () => {
  const root = tmp(), pr = { name: 't', path: root };
  try {
    init(pr);
    assert.equal(addLessons(pr, ['Гонять npm test', 'гонять NPM test!'], 'команда', new Date('2026-11-04')), 1);
    assert.equal(addLessons(pr, ['Гонять npm test'], 'владелец'), 0);
    assert.match(lessons(root)[0], /^- 2026-11-04 · команда: Гонять npm test$/);
    for (let i = 0; i < 45; i++) addLessons(pr, [`урок номер ${i}`]);
    const all = lessons(root);
    assert.equal(all.length, 40);
    assert.match(all.at(-1), /урок номер 44/);
    assert.ok(!all.some(x => /Гонять npm test/.test(x)), 'старые вытесняются');
    assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /урок номер 44/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('память для Claude: в существующий CLAUDE.md добавляется импорт @AGENTS.md, текст владельца цел, без повторов', () => {
  const root = tmp(), pr = { name: 't', path: root };
  try {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Мои правила\n\nНе деплоить.\n');
    init(pr);
    addLessons(pr, ['урок']);
    const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert.ok(text.startsWith('# Мои правила\n\nНе деплоить.'));
    assert.equal(text.match(/^@AGENTS\.md/gm).length, 1);
    const noClaude = tmp();
    init({ name: 'x', path: noClaude });
    assert.ok(!fs.existsSync(path.join(noClaude, 'CLAUDE.md')), 'CLAUDE.md не создаём, если его не было');
    fs.rmSync(noClaude, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('уроки просит только финальное ревью ведущего', () => {
  const cfg = team.normalize({});
  const steps = [{ role: 'lead', title: 'a', do: 'x' }, { role: 'test', title: 'b', do: 'y' }, { role: 'lead', title: 'c', do: 'z' }];
  assert.match(team.stepPrompt(cfg, { task: 'T', steps, i: 2 }), /УРОКИ:/);
  assert.doesNotMatch(team.stepPrompt(cfg, { task: 'T', steps, i: 0 }), /УРОКИ:/);
  assert.doesNotMatch(team.stepPrompt(cfg, { task: 'T', steps, i: 1 }), /УРОКИ:/);
});
