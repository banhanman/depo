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

test('каталог Kimi: «По умолчанию» наследует раздумья и контекст модели по умолчанию', () => {
  const catalog = parseKimiCatalog(JSON.stringify({
    models: {
      'kimi-code/k3': { model: 'k3', displayName: 'K3', maxContextSize: 1048576, supportEfforts: ['low', 'high'], defaultEffort: 'high' },
      'kimi-code/k5': { model: 'k5', displayName: 'K5', maxContextSize: 131072, supportEfforts: ['medium'] },
    },
  }), 'kimi-code/k3');
  assert.equal(catalog.defaultModel, 'kimi-code/k3');
  const def = catalog.items[0];
  assert.equal(def.name, 'По умолчанию');
  assert.deepEqual(def.efforts.map(e => e.id), ['low', 'high']);
  assert.equal(def.effort, 'high');
  assert.equal(def.contextWindow, 1048576);
  assert.match(def.description, /K3/);
  assert.deepEqual(catalog.items[2].efforts.map(e => e.id), ['medium']);
});

import { claudeCatalog, parseClaudeCatalog } from '../lib/models.mjs';
import fsCat from 'node:fs';
import osCat from 'node:os';
import pathCat from 'node:path';
const ccModels = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work and everyday tasks', section: 'main' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', section: 'more' },
];
const ccState = { model: 'claude-opus-5-5', thinking_by_model: [{ id: 'claude-opus-5-5', thinking: { effort: 'medium' } }] };
const catDir = files => {
  const dir = fsCat.mkdtempSync(pathCat.join(osCat.tmpdir(), 'cc-catalog-'));
  for (const [name, body] of Object.entries(files)) fsCat.writeFileSync(pathCat.join(dir, name), JSON.stringify(body));
  return dir;
};
const floor = { version: 1, sources: {} };

test('каталог Claude: новый формат v2 (<uuid>-cc.json, catalog.config/state)', () => {
  const dir = catDir({ 'published-floor.json': floor, 'abc-123-cc.json': { version: 2, catalog: { surface: 'cc', config: { models: ccModels }, state: ccState } } });
  const c = claudeCatalog(dir);
  assert.equal(c.source, 'catalog');
  assert.deepEqual(c.items.map(i => i.id), ['', 'claude-opus-5-5', 'claude-opus-4-8']);
  assert.equal(c.items[1].description, 'Для сложной и повседневной работы');
  assert.equal(c.items[1].effort, 'medium');
  assert.match(c.items[0].description, /Opus 5\.5/);
  fsCat.rmSync(dir, { recursive: true, force: true });
});

test('каталог Claude: старый формат v1 (published-*.json с documentBytes) по-прежнему читается', () => {
  const doc = { version: 1940, surfaces: { cc: { model_selector_config: [{ models: ccModels }], model_selector_state: [ccState] } } };
  const dir = catDir({ 'published-floor.json': floor, 'published-x.json': { documentBytes: Buffer.from(JSON.stringify(doc)).toString('base64') } });
  const c = claudeCatalog(dir);
  assert.equal(c.source, 'catalog');
  assert.equal(c.version, 1940);
  assert.equal(c.items.length, 3);
  fsCat.rmSync(dir, { recursive: true, force: true });
});

test('каталог Claude: непонятный файл не мешает, без каталога — честная заглушка', () => {
  assert.equal(parseClaudeCatalog({ version: 9, something: 1 }), null);
  const dir = catDir({ 'published-floor.json': floor, 'weird-cc.json': { version: 9 } });
  assert.equal(claudeCatalog(dir).source, 'fallback');
  fsCat.rmSync(dir, { recursive: true, force: true });
});
