import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInfo, phaseForTool } from '../lib/runner.mjs';
import { quotaDelta } from '../lib/usage.mjs';

test('таймер показывает активное время без ожидания подтверждения', () => {
  const run = { status: 'running', started_at: 10000, waiting_ms: 2000, wait_started_at: 15000 };
  assert.equal(runInfo(run, 20000).active_ms, 3000);
  assert.equal(runInfo(run, 20000).duration_ms, 10000);
  assert.equal(runInfo({ ...run, status: 'done', ended_at: 18000 }, 20000).active_ms, 3000);
});

test('фазы берутся из реальных инструментов', () => {
  assert.equal(phaseForTool({ name: 'Read' }), 'Изучает проект');
  assert.equal(phaseForTool({ name: 'Edit' }), 'Изменяет файлы');
  assert.equal(phaseForTool({ name: 'Bash', input: { command: 'npm test' } }), 'Запускает тесты');
  assert.equal(phaseForTool({ name: 'Bash', input: { command: 'git status' } }), 'Выполняет команды');
});

test('квота задачи помечена приблизительной, сброс не выдаётся за отрицательный расход', () => {
  const start = { limits: [{ label: 'Сессия · 5 ч', pct: 40, resets: 'a' }, { label: 'Месяц', pct: 20, resets: 'b' }] };
  const end = { limits: [{ label: 'Сессия · 5 ч', pct: 47, resets: 'a' }, { label: 'Месяц', pct: 20, resets: 'b' }] };
  const delta = quotaDelta(start, end);
  assert.equal(delta.approximate, true);
  assert.equal(delta.changes[0].delta, 7);
  assert.equal(quotaDelta(start, { limits: [{ ...end.limits[0], pct: 2, resets: 'new' }] }).changes[0].reset, true);
});
