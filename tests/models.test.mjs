import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiCatalog } from '../lib/models.mjs';

test('каталог Kimi берёт актуальные модели и окна из Kimi Code', () => {
  const catalog = parseKimiCatalog(JSON.stringify({
    providers: { 'managed:kimi-code': { api_key: 'не попадает в ответ' } },
    models: {
      'kimi-code/k3': { model: 'k3', displayName: 'K3', maxContextSize: 1048576, supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
      'kimi-code/k3.1-pro-highspeed': { model: 'k3.1-pro', displayName: 'K3.1 Pro Highspeed 2x Usage Cost', maxContextSize: 1048576 },
      'kimi-code/k3-256k': { model: 'k3-256k', maxContextSize: 262144 },
    },
  }));
  assert.equal(catalog.source, 'kimi-code');
  assert.deepEqual(catalog.items.map(m => m.id), ['', 'kimi-code/k3', 'kimi-code/k3.1-pro-highspeed', 'kimi-code/k3-256k']);
  assert.equal(catalog.items[1].name, 'K3');
  assert.equal(catalog.items[1].contextWindow, 1048576);
  assert.deepEqual(catalog.items[1].efforts.map(e => e.id), ['low', 'high', 'max']);
  assert.equal(catalog.items[1].effort, 'high');
  assert.equal(catalog.items[3].description, 'Контекст 262k');
  assert.equal(JSON.stringify(catalog).includes('не попадает'), false);
});

test('пустой каталог Kimi не подменяется устаревшими моделями', () => {
  assert.throws(() => parseKimiCatalog({ models: {} }), /пустой каталог/);
});
