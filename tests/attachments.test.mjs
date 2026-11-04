import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, helpers } from '../lib/db.mjs';
import { Runner } from '../lib/runner.mjs';

const waitFor = async fn => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Не дождались завершения Kimi');
};

test('Kimi получает изображения и другие файлы вместе с доступом к папке загрузки', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-attachment-test-'));
  const db = open(path.join(tmp, 'data'));
  const h = helpers(db);
  t.after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const bin = path.join(tmp, 'bin');
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(bin);
  fs.mkdirSync(uploads);
  const capture = path.join(tmp, 'args.json');
  const fake = path.join(bin, 'kimi');
  fs.writeFileSync(fake, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.DEPO_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ role: 'assistant', content: 'ok' }));\n`, { mode: 0o755 });
  const image = path.join(uploads, 'screen.png');
  const archive = path.join(uploads, 'archive.zip');
  fs.writeFileSync(image, 'test image');
  fs.writeFileSync(archive, 'test archive');

  h.run('INSERT INTO projects(name,path,glyph,created_at) VALUES(?,?,?,?)', 'Test', tmp, 'TE', Date.now());
  const project = h.get('SELECT * FROM projects');
  const chat = { id: 'kimi-image', project_id: project.id, provider: 'kimi', cwd: tmp };
  h.run('INSERT INTO chats(id,project_id,provider,created_at,updated_at) VALUES(?,?,?,?,?)', chat.id, project.id, chat.provider, Date.now(), Date.now());
  const runner = new Runner({
    h,
    hub: { send() {} },
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPO_TEST_CAPTURE: capture },
    root: tmp,
  });

  runner.start(chat, 'Разбери вложения', 'Разбери вложения', [
    { image: true, path: image, media_type: 'image/png' },
    { image: false, path: archive, media_type: 'application/zip' },
  ]);
  await waitFor(() => fs.existsSync(capture) && !runner.isRunning(chat.id));
  const args = JSON.parse(fs.readFileSync(capture, 'utf8'));
  const prompt = args[args.indexOf('-p') + 1];
  assert.ok(prompt.includes(image), 'путь к изображению отсутствует в запросе Kimi');
  assert.ok(prompt.includes(archive), 'путь к архиву отсутствует в запросе Kimi');
  const addDir = args.indexOf('--add-dir');
  assert.notEqual(addDir, -1, 'Kimi не получил --add-dir для папки загрузок');
  assert.equal(args[addDir + 1], uploads);
});
