import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import * as queue from '../lib/queue.mjs';

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-queue-test-'));
  const db = open(tmp);
  const h = helpers(db);
  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', tmp, 'TE', 1);
  h.run('INSERT INTO chats(id,project_id,created_at,updated_at) VALUES(?,?,?,?)', 'chat', 1, 1, 1);
  t.after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  return h;
}

test('очередь сохраняет порядок, текст и вложения', t => {
  const h = setup(t);
  const first = queue.enqueue(h, 'chat', 'Первое', [{ path: '/tmp/a.txt' }]);
  queue.enqueue(h, 'chat', 'Второе');
  assert.equal(first.status, 'pending');
  assert.deepEqual(queue.pending(h, 'chat').map(x => x.text), ['Первое', 'Второе']);
  assert.equal(queue.pending(h, 'chat')[0].attachments[0].path, '/tmp/a.txt');
});

test('редактировать и удалять можно только ожидающее сообщение', t => {
  const h = setup(t);
  const item = queue.enqueue(h, 'chat', 'Черновик');
  const changed = queue.update(h, item.id, 'Исправлено');
  assert.equal(changed.text, 'Исправлено');
  assert.equal(queue.remove(h, item.id), true);
  assert.equal(queue.update(h, item.id, 'Не должно сохраниться'), null);
});

test('запуск атомарно забирает следующее, сбой не теряет сообщение', t => {
  const h = setup(t);
  queue.enqueue(h, 'chat', 'Первое');
  queue.enqueue(h, 'chat', 'Второе');
  const claimed = queue.claimNext(h, 'chat');
  assert.equal(claimed.text, 'Первое');
  assert.equal(queue.claimNext(h, 'chat').text, 'Второе', 'повторный запуск забирает другое сообщение');
  h.run("UPDATE queued_messages SET status='sent' WHERE text='Второе'");
  queue.fail(h, claimed.id, 'CLI не запустился');
  assert.equal(queue.pending(h, 'chat')[0].error, 'CLI не запустился');
  const retry = queue.claimNext(h, 'chat');
  queue.complete(h, retry.id, 42);
  assert.deepEqual(queue.pending(h, 'chat'), []);
  assert.equal(h.get('SELECT run_id FROM queued_messages WHERE id=?', retry.id).run_id, 42);
});

test('после перезапуска недошедшие сообщения снова ожидают', t => {
  const h = setup(t);
  queue.enqueue(h, 'chat', 'Не потерять');
  queue.claimNext(h, 'chat');
  assert.equal(queue.restore(h), 1);
  assert.equal(queue.pending(h, 'chat')[0].text, 'Не потерять');
});

test('немедленная доставка не выдаётся за поддерживаемую у одноходовых CLI', () => {
  assert.equal(queue.canSteer('claude'), true);
  assert.equal(queue.canSteer('codex'), false);
  assert.equal(queue.canSteer('kimi'), false);
  assert.equal(queue.canSteer('gemini'), false);
});

test('пустые сообщения без вложений не ставятся в очередь', t => {
  const h = setup(t);
  assert.throws(() => queue.enqueue(h, 'chat', '  '), /Пустое сообщение/);
});
