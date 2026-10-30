import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiUsage } from '../lib/kimi-meta.mjs';

test('лимиты Kimi читаются из /usage', () => {
  const usage = parseKimiUsage(`╭ Usage ─╮
│ Plan usage                                                           │
│   5h limit       ███████░░░░░░░░░░░░░  35% used  resets in 3h 18m     │
│   Monthly limit  ░░░░░░░░░░░░░░░░░░░░  2% used   resets in 31d 14h 5m │
╰───────────────────────────────────────────────────────────────────────╯`);
  assert.deepEqual(usage.limits, [
    { label: 'Сессия · 5 ч', pct: 35, resets: 'через 3 ч 18 мин' },
    { label: 'Месяц', pct: 2, resets: 'через 31 дн. 14 ч 5 мин' },
  ]);
});

test('еженедельный лимит старого тарифа Kimi тоже поддерживается', () => {
  const usage = parseKimiUsage('Weekly limit 81% used resets in 2d 4h');
  assert.deepEqual(usage.limits, [{ label: 'Неделя', pct: 81, resets: 'через 2 дн. 4 ч' }]);
});

test('контекст текущей сессии Kimi читается из /usage', () => {
  const usage = parseKimiUsage(`│ Context window                                                   │
│   ██████░░░░░░░░░░░░░░      29%  (290k / 1M)                       │
│ Plan usage                                                         │
│   5h limit  49% used  resets in 2h 52m                             │`);
  assert.deepEqual(usage.context, { used: 290000, window: 1000000, pct: 29 });
});
