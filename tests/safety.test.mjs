import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as safety from '../lib/safety.mjs';

function setup(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-safety-test-'));
  fs.mkdirSync(path.join(root, '.depo'));
  fs.writeFileSync(path.join(root, '.depo', 'checks.json'), JSON.stringify(config));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('несогласованный HTML с отсутствующим chunk не проходит проверку', async t => {
  const root = setup(t);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<script type="module" src="/assets/app.js"></script>');
  const result = await safety.checkArtifacts(root, ['dist']);
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /app\.js/);
});

test('полный артефакт и манифест проходят проверку', async t => {
  const root = setup(t);
  fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<script src="assets/app.js"></script><link rel="manifest" href="app.webmanifest">');
  fs.writeFileSync(path.join(root, 'dist', 'assets', 'app.js'), 'ok');
  fs.writeFileSync(path.join(root, 'dist', 'app.webmanifest'), JSON.stringify({ icons: [{ src: 'assets/icon.png' }] }));
  fs.writeFileSync(path.join(root, 'dist', 'assets', 'icon.png'), 'ok');
  const result = await safety.checkArtifacts(root, ['dist']);
  assert.equal(result.ok, true);
});

test('неуспешная обязательная проверка блокирует команду публикации', async t => {
  const marker = path.join(os.tmpdir(), `depo-deploy-${crypto.randomUUID()}`);
  const root = setup(t, { checks: ['node -e "process.exit(1)"'], deploy: `node -e "require('fs').writeFileSync('${marker}','bad')"` });
  const result = await safety.deploy(root);
  t.after(() => fs.rmSync(marker, { force: true }));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'checks');
  assert.equal(fs.existsSync(marker), false);
});

test('ошибка команды публикации запускает настроенный откат', async t => {
  const marker = path.join(os.tmpdir(), `depo-rollback-${crypto.randomUUID()}`);
  const root = setup(t, {
    checks: ['node -e "process.exit(0)"'],
    deploy: 'node -e "process.exit(1)"',
    rollback: `node -e "require('fs').writeFileSync('${marker}','rolled back')"`,
  });
  const result = await safety.deploy(root);
  t.after(() => fs.rmSync(marker, { force: true }));
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'deploy');
  assert.equal(result.rollback.ok, true);
  assert.equal(fs.existsSync(marker), true);
});

test('релиз копируется целиком и атомарно становится текущим', async t => {
  const root = setup(t, { checks: ['node -e "process.exit(0)"'] });
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'index.html'), 'ok');
  fs.writeFileSync(path.join(dist, 'old.js'), 'old release remains available');
  const releases = path.join(root, 'releases');
  const current = path.join(root, 'current');
  fs.writeFileSync(path.join(root, '.depo', 'checks.json'), JSON.stringify({
    checks: ['node -e "process.exit(0)"'],
    release: { source: 'dist', releases, current },
    verify: ['node -e "process.exit(0)"'],
  }));
  const result = await safety.deploy(root);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(current, 'old.js'), 'utf8'), 'old release remains available');
  assert.ok(result.release.includes('release-'));
});

test('неуспешная проверка после публикации возвращает предыдущий релиз', async t => {
  const root = setup(t);
  const releases = path.join(root, 'releases');
  const current = path.join(root, 'current');
  const previous = path.join(releases, 'release-old');
  fs.mkdirSync(previous, { recursive: true });
  fs.writeFileSync(path.join(previous, 'version.txt'), 'old');
  fs.symlinkSync(previous, current, 'dir');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'index.html'), 'new');
  fs.writeFileSync(path.join(root, '.depo', 'checks.json'), JSON.stringify({
    checks: ['node -e "process.exit(0)"'],
    release: { source: 'dist', releases, current },
    verify: ['node -e "process.exit(1)"'],
  }));
  const result = await safety.deploy(root);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'verify');
  assert.equal(result.rolledBack, true);
  assert.equal(fs.realpathSync(current), previous);
});
