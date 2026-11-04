import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import { Telegram } from '../lib/telegram.mjs';

test('отключённый Telegram-бот игнорирует сообщения и не запускает polling', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-telegram-test-'));
  const db = open(tmp);
  const h = helpers(db);
  t.after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  h.setting('tg_token', 'test-token');
  h.setting('tg_chat', '123');
  h.setting('tg_enabled', '0');

  let sent = 0;
  const tg = new Telegram(h);
  tg.send = async () => { sent++; return { ok: true }; };
  await tg.onUpdate({ message: { chat: { id: 123 }, text: '/start' } });
  assert.equal(sent, 0);
  await tg.poll();
  assert.equal(tg.polling, false);
});

test('Telegram: /restart — меню с подтверждением, чужие игнорируются, хук без реального exit', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-tg-restart-'));
  const db = open(tmp);
  const h = helpers(db);
  t.after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  h.setting('tg_token', 'test-token');
  h.setting('tg_chat', '123');
  h.setting('tg_enabled', '1');

  let restarts = 0, restartResult = { ok: true };
  const calls = [];
  const tg = new Telegram(h, {
    running: () => [],
    restart: () => { restarts++; return restartResult; },
  });
  tg.call = async (method, body) => { calls.push([method, body]); return { ok: true, result: { message_id: calls.length } }; };

  // сама команда — только меню с подтверждением, перезапуск не вызывается
  await tg.onUpdate({ message: { chat: { id: 123 }, text: '/restart' } });
  assert.equal(restarts, 0);
  const menu = calls.find(c => c[0] === 'sendMessage' && /Перезапустить Depo/.test(c[1].text));
  assert.ok(menu, 'меню подтверждения отправлено');
  assert.deepEqual(menu[1].reply_markup.inline_keyboard[0].map(b => b.callback_data), ['restart:ok', 'restart:no']);

  // отмена — не перезапускает
  await tg.onCallback({ id: 'q1', data: 'restart:no', message: { chat: { id: 123 }, message_id: 1 } });
  assert.equal(restarts, 0);
  assert.ok(calls.some(c => c[0] === 'sendMessage' && /не перезапускаю/.test(c[1].text)));

  // подтверждение — хук вызван ровно раз, флаг для отчёта записан
  await tg.onCallback({ id: 'q2', data: 'restart:ok', message: { chat: { id: 123 }, message_id: 1 } });
  assert.equal(restarts, 1);
  assert.ok(+h.setting('tg_restart_at') > 0, 'время перезапуска запомнено для отчёта после старта');
  assert.ok(calls.some(c => c[0] === 'sendMessage' && /Перезапускаю Depo/.test(c[1].text)));

  // хук сообщил об ошибке — сообщаем её, не падаем
  restartResult = { ok: false, error: 'systemctl не найден' };
  await tg.onCallback({ id: 'q3', data: 'restart:ok', message: { chat: { id: 123 }, message_id: 1 } });
  assert.equal(restarts, 2);
  assert.ok(calls.some(c => c[0] === 'sendMessage' && /systemctl не найден/.test(c[1].text)));

  // чужой chat_id — и сообщение, и кнопка игнорируются молча
  const before = calls.length;
  await tg.onCallback({ id: 'q4', data: 'restart:ok', message: { chat: { id: 999 }, message_id: 2 } });
  await tg.onUpdate({ message: { chat: { id: 999 }, text: '/restart' } });
  assert.equal(restarts, 2);
  assert.equal(calls.length, before, 'чужому ничего не отправлено');
});
