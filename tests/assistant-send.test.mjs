import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSends, wantsSend, resolveTarget } from '../lib/assistant.mjs';

test('блок отправки вырезается из ответа, ТЗ и адрес достаются целиком', () => {
  const r = extractSends(`Сформулировал и отправляю.\n<<<SEND chat=5476a79e>>>\nСделай дашборд:\n- графики\n- настройки\n<<<END>>>\nГотово.`);
  assert.equal(r.text, 'Сформулировал и отправляю.\n\nГотово.');
  assert.deepEqual(r.sends, [{ chat: '5476a79e', project: null, task: 'Сделай дашборд:\n- графики\n- настройки' }]);
});

test('новый чат в проекте и пустые блоки', () => {
  const r = extractSends('<<<SEND project=12>>>\nТЗ\n<<<END>>>\n<<<SEND chat=abc12345>>>\n   \n<<<END>>>');
  assert.deepEqual(r.sends, [{ chat: null, project: 12, task: 'ТЗ' }]);
  assert.equal(r.text, '');
});

test('без явной просьбы владельца блок не исполняется', () => {
  assert.ok(wantsSend('ок, отправь это в тот чат как тз'));
  assert.ok(wantsSend('Передай Kimi задачу'));
  assert.ok(wantsSend('закинь в новый чат'));
  assert.ok(!wantsSend('что сделано в проекте shop?'));
  assert.ok(!wantsSend(''));
});

test('чат ищется по короткому id, архивные и чужие не годятся', () => {
  const rows = [{ id: '5476a79e-3bb0-4cb8-a7e0-86ff8a7eab76', archived: 0 }, { id: '5476a700-0000-0000-0000-000000000000', archived: 1 }];
  const h = { all: (_sql, like) => rows.filter(r => r.id.startsWith(like.replace('%', '')) && !r.archived) };
  assert.equal(resolveTarget(h, '5476a79e'), rows[0].id);
  assert.equal(resolveTarget(h, '5476a'), null, 'слишком короткий id не угадываем');
  assert.equal(resolveTarget(h, 'ffffffff'), null);
});
