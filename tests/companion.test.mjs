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
