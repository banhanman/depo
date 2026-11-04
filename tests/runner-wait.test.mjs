import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import { Runner, runInfo } from '../lib/runner.mjs';

const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-wait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(dir);
  const h = helpers(db);
  h.run("INSERT INTO projects(name,path,glyph,created_at) VALUES('P','/tmp','П',1)");
  h.run("INSERT INTO chats(id,project_id,created_at,updated_at) VALUES('c1',1,1,1)");
  const events = [];
  const runner = new Runner({ h, hub: { send: (type, data) => events.push({ type, ...data }) }, env: {} });
  return { h, runner, events, db };
};

test('ожидание подтверждения вычитается из активного времени и фиксируется', async t => {
  const { h, runner, events } = setup(t);
  const started = Date.now() - 10000;
  h.run("INSERT INTO runs(chat_id,provider,status,started_at,phase) VALUES('c1','kimi','running',?,'Изучает проект')", started);
  const runId = h.get("SELECT id FROM runs WHERE chat_id='c1'").id;
  runner.active.set('c1', { runId, phase: 'Изучает проект', waiting: false });

  runner.setWaiting('c1', true);
  let run = h.get('SELECT * FROM runs WHERE id=?', runId);
  assert.equal(run.phase, 'Ожидает подтверждения');
  assert.ok(run.wait_started_at > 0);
  // пока ждём, активное время заморожено: оно не растёт вместе с Date.now()
  const frozen = runInfo(run).active_ms;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(runInfo(h.get('SELECT * FROM runs WHERE id=?', runId)).active_ms, frozen);

  runner.setWaiting('c1', false);
  run = h.get('SELECT * FROM runs WHERE id=?', runId);
  assert.equal(run.wait_started_at, null);
  assert.ok(run.waiting_ms >= 50, `waiting_ms=${run.waiting_ms}`);
  assert.equal(run.phase, 'Изучает проект');

  // повторное ожидание суммируется с первым, а не сбрасывает его
  const before = run.waiting_ms;
  runner.setWaiting('c1', true);
  await new Promise(r => setTimeout(r, 40));
  runner.setWaiting('c1', false);
  run = h.get('SELECT * FROM runs WHERE id=?', runId);
  assert.ok(run.waiting_ms >= before + 30, `${run.waiting_ms} < ${before} + 30`);

  // прогресс уходит в поток с посчитанным активным временем
  const progress = events.filter(e => e.type === 'run-progress').at(-1);
  assert.ok(progress?.run);
  assert.ok(progress.run.active_ms <= progress.run.duration_ms);
  assert.ok(events.some(e => e.type === 'run-progress' && e.run.phase === 'Ожидает подтверждения'));
});

test('фаза не меняется, пока ход ждёт подтверждения', t => {
  const { h, runner } = setup(t);
  h.run("INSERT INTO runs(chat_id,provider,status,started_at) VALUES('c1','kimi','running',?)", Date.now());
  const runId = h.get("SELECT id FROM runs WHERE chat_id='c1'").id;
  runner.active.set('c1', { runId, phase: 'Изучает проект', waiting: false });
  runner.setWaiting('c1', true);
  runner.setPhase('c1', 'Выполняет команды');
  assert.equal(h.get('SELECT phase FROM runs WHERE id=?', runId).phase, 'Ожидает подтверждения');
});
