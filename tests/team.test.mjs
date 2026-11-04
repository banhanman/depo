import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as team from '../lib/team.mjs';

test('команда: настройки, подсказка, разбор плана, вердикт и возврат на доработку', () => {
  const cfg = team.normalize({});
  assert.deepEqual(cfg.roles.map(r => [r.id, r.provider]), [['lead', 'claude'], ['ui', 'codex'], ['test', 'kimi']]);
  assert.equal(team.suggest(cfg, 'поправь анимацию кнопки на мобильной').role, 'ui');
  assert.equal(team.suggest(cfg, 'напиши тесты на api').role, 'test');
  const plan = team.parsePlan('Сделаю так.\n```json\n{"steps":[{"role":"lead","title":"Ядро","do":"x"},{"role":"ui","title":"Карточка","do":"y"},{"role":"test","title":"Тесты","do":"z"}]}\n```', cfg);
  assert.equal(plan.length, 4, 'ревью ведущего добавлено в конец');
  assert.equal(plan.at(-1).role, 'lead');
  assert.equal(team.parsePlan('без плана', cfg), null);
  assert.equal(team.parsePlan('```json\n{"steps":[{"role":"чужая","title":"A"}]}\n```', cfg)[0].role, 'lead', 'неизвестная роль → ведущий');
  assert.equal(team.verdict('...\nИТОГ: ПРОВАЛЕНО'), false);
  assert.equal(team.verdict('ИТОГ: пройдено'), true);
  assert.equal(team.verdict('что-то'), null);
  const fixed = team.withFix(cfg, plan, 2, 'упал тест X');
  assert.deepEqual(fixed.map(s => s.role), ['lead', 'ui', 'test', 'ui', 'test', 'lead']);
  assert.match(fixed[3].do, /упал тест X/);
  assert.match(team.stepPrompt(cfg, { task: 'T', steps: plan, i: 2 }), /ИТОГ: ПРОЙДЕНО/);
  assert.doesNotMatch(team.stepPrompt(cfg, { task: 'T', steps: plan, i: 1 }), /ИТОГ:/);
  const c2 = team.normalize({ roles: [{ name: 'Один', provider: 'codex' }], retries: 9, max_steps: 1 });
  assert.equal(c2.roles[0].id, 'lead'); assert.equal(c2.retries, 3); assert.equal(c2.max_steps, 2);
});

test('команда: указания роли сохраняются, чистятся и не смешиваются между ролями', () => {
  const cfg = team.normalize({
    roles: [
      { id: 'lead', name: 'Ведущий', provider: 'claude', instructions: '  Пиши по-русски.\r\n\r\nПокрывай краевые случаи.  ' },
      { id: 'test', name: 'Тесты', provider: 'kimi', model: 'k3', effort: 'high', instructions: 'Гоняй npm test дважды.' },
    ],
  });
  const lead = cfg.roles.find(r => r.id === 'lead');
  const tester = cfg.roles.find(r => r.id === 'test');
  assert.equal(lead.instructions, 'Пиши по-русски.\n\nПокрывай краевые случаи.');
  assert.equal(tester.instructions, 'Гоняй npm test дважды.');
  assert.equal(tester.model, 'k3');
  assert.equal(tester.effort, 'high');

  const long = team.normalize({ roles: [{ name: 'A', provider: 'kimi', instructions: 'x'.repeat(5000) }] });
  assert.equal(long.roles[0].instructions.length, 2000, 'указания обрезаются до 2000');

  const old = team.normalize({ roles: [{ id: 'lead', name: 'Ведущий', provider: 'claude', keywords: ['план'], model: 'opus', effort: 'max' }] });
  assert.equal(old.roles[0].instructions, '', 'старый конфиг без поля — пустые указания');
  assert.equal(old.roles[0].model, 'opus');

  const plan = team.parsePlan('```json\n{"steps":[{"role":"lead","title":"План"},{"role":"test","title":"Тесты"}]}\n```', cfg);
  const leadStep = team.stepPrompt(cfg, { task: 'T', steps: plan, i: 0 });
  const testStep = team.stepPrompt(cfg, { task: 'T', steps: plan, i: 1 });
  assert.match(leadStep, /Указания владельца для роли «Ведущий»/);
  assert.match(leadStep, /Пиши по-русски/);
  assert.doesNotMatch(leadStep, /Гоняй npm test/);
  assert.match(testStep, /Гоняй npm test дважды/);
  assert.doesNotMatch(testStep, /Покрывай краевые случаи/);

  const pp = team.planPrompt(cfg, 'Задача');
  assert.match(pp, /Пиши по-русски/);
  assert.doesNotMatch(pp, /Гоняй npm test/);
});

// ─────────── выключенные из команды агенты ───────────
test('off: выключили Kimi — роль test берёт Codex (его модель), выключили и Codex — Claude', () => {
  const cfg = team.normalize({ ...team.DEFAULT, off: ['kimi'] });
  const test1 = team.assignee(cfg, team.role(cfg, 'test'));
  assert.equal(test1.provider, 'codex');
  assert.equal(test1.instead, 'kimi');
  assert.equal(test1.reason, 'off');
  assert.equal(team.assignee(cfg, team.role(cfg, 'lead')).instead, null);
  const cfg2 = team.normalize({ ...team.DEFAULT, off: ['kimi', 'codex'] });
  assert.equal(team.assignee(cfg2, team.role(cfg2, 'test')).provider, 'claude');
  assert.equal(team.assignee(cfg2, team.role(cfg2, 'ui')).provider, 'claude');
});

test('off: без входа (ready) — тоже подмена, причина ready', () => {
  const cfg = team.normalize(team.DEFAULT);
  const a = team.assignee(cfg, team.role(cfg, 'test'), p => p !== 'kimi');
  assert.equal(a.provider, 'codex');
  assert.equal(a.reason, 'ready');
});

test('off: выключить всех нельзя; мусор отбрасывается; старый конфиг без off работает', () => {
  const store = {};
  const h = { setting: (k, v) => v === undefined ? store[k] : (store[k] = v) };
  assert.throws(() => team.save(h, { ...team.DEFAULT, off: ['claude', 'codex', 'kimi'] }), /Нельзя выключить всех/);
  assert.deepEqual(team.normalize({ off: ['kimi', 'kimi', 'gemini', 1] }).off, ['kimi']);
  assert.deepEqual(team.normalize({ roles: team.DEFAULT.roles }).off, []);
  assert.deepEqual(team.save(h, { ...team.DEFAULT, off: ['kimi'] }).off, ['kimi']);
  assert.deepEqual(team.config(h).off, ['kimi']);
});

test('off: в задании на план выключенный агент не числится исполнителем', () => {
  const p = team.planPrompt(team.normalize({ ...team.DEFAULT, off: ['kimi'] }), 'задача');
  assert.doesNotMatch(p, /\(агент Kimi Code\)/);
  assert.match(p, /test: .*\(агент Codex, вместо Kimi Code/);
});
