import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as companion from '../lib/companion.mjs';

test('Gemini объясняет запрет бесплатного тарифа вместо обрезанного stack trace', () => {
  const error = companion.geminiError(`Warning: Basic terminal detected
Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals.
    at _doSetupUser (file:///usr/lib/node_modules/@google/gemini-cli/bundle/chunk.js:1:1)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)`);
  assert.match(error.message, /Google закрыл бесплатный Gemini/);
  assert.match(error.message, /выбери другого собеседника/);
  assert.doesNotMatch(error.message, /at _doSetupUser/);
});

test('собеседнику не уходят секреты', async () => {
  const { redact, digest } = await import('../lib/companion.mjs');
  const t = redact('ключ sk-abcdefghijklmnopqrstuvwx и GITHUB_TOKEN=ghp_123 и password: "hunter2"\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----');
  assert.doesNotMatch(t, /sk-abcdef|ghp_123|hunter2|AAAA/);
  assert.match(t, /\[секрет скрыт\]/);
  assert.match(t, /\[приватный ключ скрыт\]/);
  assert.doesNotMatch(digest([{ role: 'assistant', text: 'DEPO_TOKEN=abc123secret готово' }]), /abc123secret/);
});
