import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meters } from '../lib/usage.mjs';

const meters = () => new Meters({ h: { log() { } }, hub: { send() { } }, home: '/tmp' });
const event = pct => ({ unifiedWindows: {
  five_hour: { utilization: pct / 100, resetsAt: Date.now() / 1000 + 3 * 3600 },
  seven_day: { utilization: 0.31, resetsAt: Date.now() / 1000 + 4 * 86400 },
} });
const fmtEn = d => `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;
const inH = h => fmtEn(new Date(Date.now() + h * 3600e3));
const usage = `Current session: 0% used · resets ${inH(4)} (Europe/Moscow)
Current week (all models): 32% used · resets ${inH(72)} (Europe/Moscow)
Current week (Fable): 26% used · resets ${inH(71)} (Europe/Moscow)`;
const pct = (m, label) => m.snapshot('claude').limits.find(l => l.label === label)?.pct;

test('свежий /usage сменяет цифры из давнего хода: после сброса сессии не висят старые 67%', () => {
  const m = meters();
  m.fromEvent(event(67));
  assert.equal(pct(m, 'Сессия · 5 ч'), 67);
  m.applyUsage(usage);
  assert.equal(pct(m, 'Сессия · 5 ч'), 0);
  assert.equal(pct(m, 'Неделя · все модели'), 32);
  assert.equal(pct(m, 'Неделя · Fable'), 26);
});

test('ход после /usage снова главнее, недельный Fable не теряется', () => {
  const m = meters();
  m.applyUsage(usage);
  m.fromEvent(event(5));
  assert.equal(pct(m, 'Сессия · 5 ч'), 5);
  assert.equal(pct(m, 'Неделя · Fable'), 26);
});

test('пустой или непонятный /usage не стирает известные лимиты', () => {
  const m = meters();
  m.fromEvent(event(12));
  m.applyUsage('что-то новое в формате вывода');
  assert.equal(pct(m, 'Сессия · 5 ч'), 12);
});

const past = new Date(Date.now() - 3600e3), future = new Date(Date.now() + 86400e3);
const en = d => `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`;

test('окно, чей сброс уже прошёл, показываем пустым, даже если /usage отдал старые 100%', () => {
  const m = meters();
  m.applyUsage(`Current session: 100% used · resets ${en(past)} (Europe/Moscow)\nCurrent week (all models): 60% used · resets ${en(future)} (Europe/Moscow)`);
  assert.equal(pct(m, 'Сессия · 5 ч'), 0);
  assert.equal(m.snapshot('claude').limits.find(l => l.label === 'Сессия · 5 ч').resets, '');
  assert.equal(pct(m, 'Неделя · все модели'), 60);
});

test('сброс из хода тоже стареет: 100% без нового хода сами уходят в ноль', () => {
  const m = meters();
  m.fromEvent({ unifiedWindows: { five_hour: { utilization: 1, resetsAt: past.getTime() / 1000 } } });
  assert.equal(pct(m, 'Сессия · 5 ч'), 0);
});

test('после сброса CLI пишет строку без «resets» — сессию всё равно узнаём', () => {
  const m = meters();
  m.fromEvent(event(100));
  m.applyUsage(`Current session: 0% used\nCurrent week (all models): 47% used · resets ${en(future)} (Europe/Moscow)`);
  assert.equal(pct(m, 'Сессия · 5 ч'), 0);
  assert.equal(pct(m, 'Неделя · все модели'), 47);
});
