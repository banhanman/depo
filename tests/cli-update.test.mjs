// Менеджер обновлений AI CLI: все четыре агента на модели настоящего окружения малины —
// обёртки с sing-box (claude, codex), глобальные npm-пакеты, нативные сборки Claude.
// Сеть, npm и sudo подменены; сами CLI — настоящие исполняемые скрипты, версию отдают запуском.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { open, helpers } from '../lib/db.mjs';
import * as cu from '../lib/cli-update.mjs';

const NODE = process.execPath;
const PROXY_LINES = 'P=http://127.0.0.1:2080\nexport HTTPS_PROXY="$P" https_proxy="$P"\nexport NO_PROXY=localhost\n';
const claudeBin = v => `#!${NODE}\nconsole.log('${v} (Claude Code)')\n`;
const PKGS = { codex: '@openai/codex', kimi: '@moonshot-ai/kimi-code', gemini: '@google/gemini-cli' };

function world(t, { versions = { codex: '0.160.0', kimi: '2.4.0', gemini: '0.66.0' }, claude = '2.1.300', latest = {}, claudeLatest = '2.1.317', rootOwned = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-cliupd-'));
  t.after(() => { try { fs.chmodSync(path.join(root, 'nm'), 0o755); } catch { } fs.rmSync(root, { recursive: true, force: true }); });
  const home = path.join(root, 'home'), bin = path.join(home, '.local', 'bin'), gbin = path.join(root, 'gbin'), nm = path.join(root, 'nm');
  const cv = path.join(home, '.local', 'share', 'claude', 'versions');
  const calls = path.join(root, 'npm-calls.log');
  for (const d of [bin, gbin, nm, cv]) fs.mkdirSync(d, { recursive: true });

  // глобальные npm-пакеты: исполняемый файл читает версию из своего package.json — как настоящие
  for (const [id, pkg] of Object.entries(PKGS)) {
    const dir = path.join(nm, pkg);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version: versions[id] }));
    fs.writeFileSync(path.join(dir, 'bin', 'cli.js'),
      `#!${NODE}\nconst v=require(${JSON.stringify(path.join(dir, 'package.json'))}).version;\nif(v.startsWith('9.9.9'))process.exit(3);\nconsole.log(${id === 'codex' ? "'codex-cli '+v" : 'v'})\n`, { mode: 0o755 });
    fs.symlinkSync(path.join(dir, 'bin', 'cli.js'), path.join(gbin, id));
  }
  // обёртка Codex с прокси → глобальный codex; Claude — обёртка на нативную сборку
  fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env bash\n# через sing-box\n${PROXY_LINES}exec ${path.join(gbin, 'codex')} "$@"\n`, { mode: 0o775 });
  fs.writeFileSync(path.join(cv, claude), claudeBin(claude), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env bash\n# Claude ВСЕГДА через sing-box\n${PROXY_LINES}export NODE_USE_ENV_PROXY=1\nexec ${path.join(cv, claude)} "$@"\n`, { mode: 0o775 });

  // npm: root -g и install -g pkg@ver (FAIL_PKG — падает, BREAK_PKG — ставит неработающую версию)
  fs.writeFileSync(path.join(bin, 'npm'), `#!${NODE}
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},a.join(' ')+'\\n');
if(a[0]==='root'){console.log(${JSON.stringify(nm)});process.exit(0)}
const spec=a.find(x=>/@\\d/.test(x));const at=spec.lastIndexOf('@');const pkg=spec.slice(0,at);let ver=spec.slice(at+1);
if(process.env.FAIL_PKG===pkg){console.error('npm ERR! network ETIMEDOUT');process.exit(1)}
if(process.env.BREAK_PKG===pkg&&ver!==process.env.KEEP_VER)ver='9.9.9';
const f=path.join(${JSON.stringify(nm)},pkg,'package.json');
try{fs.accessSync(path.dirname(f),fs.constants.W_OK)}catch{console.error('EACCES');process.exit(243)}
fs.writeFileSync(f,JSON.stringify({name:pkg,version:ver}));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/usr/bin/env bash\n[ "$1" = -n ] && shift\n[ "$SUDO_OK" = 1 ] || { echo 'sudo: a password is required' >&2; exit 1; }\n[ "$1" = true ] && exit 0\nchmod u+w ${JSON.stringify(nm)}/*/* 2>/dev/null\nexec "$@"\n`, { mode: 0o755 });
  if (rootOwned) for (const pkg of Object.values(PKGS)) fs.chmodSync(path.join(nm, pkg), 0o555);

  // официальный источник: npm dist-tags и downloads.claude.ai (latest, манифест, бинарник)
  const tags = { codex: '0.166.0', kimi: '2.4.1', gemini: '0.66.0', ...latest };
  const blobs = new Map();
  const net = { claudeLatest, badChecksum: false, hits: [] };
  const fetch = async url => {
    net.hits.push(url);
    const npm = Object.entries(PKGS).find(([, p]) => url === `${cu.NPM_REGISTRY}/-/package/${p.replace('/', '%2f')}/dist-tags`);
    if (npm) return Response.json({ latest: tags[npm[0]], next: '99.0.0-rc.1' });
    const rel = url.startsWith(cu.CLAUDE_RELEASES) ? url.slice(cu.CLAUDE_RELEASES.length + 1) : null;
    if (rel === 'latest' || rel === 'stable') return new Response(net.claudeLatest + '\n');
    const m = rel?.match(/^([\d.]+)\/(manifest\.json|linux-arm64\/claude)$/);
    if (m) {
      if (!blobs.has(m[1])) blobs.set(m[1], Buffer.from(claudeBin(m[1])));
      const b = blobs.get(m[1]);
      if (m[2] === 'manifest.json') {
        const sum = net.badChecksum ? 'f'.repeat(64) : crypto.createHash('sha256').update(b).digest('hex');
        return Response.json({ version: m[1], platforms: { 'linux-arm64': { checksum: sum, size: b.length } } });
      }
      return new Response(b);
    }
    return new Response('not found', { status: 404 });
  };

  const env = { PATH: [bin, gbin, path.dirname(NODE), '/usr/bin', '/bin'].join(':'), HOME: home };
  const db = open(path.join(root, 'data'));
  t.after(() => db.close());
  const h = helpers(db);
  const ctx = { env, home, fetch, platform: 'linux-arm64', procsUsing: () => [], backupDir: path.join(root, 'data', 'cli-backups'), lockFile: path.join(root, 'cli.lock') };
  const npmCalls = () => { try { return fs.readFileSync(calls, 'utf8').split('\n').filter(l => l.startsWith('install')); } catch { return []; } };
  return { root, home, bin, nm, cv, env, h, ctx, net, tags, npmCalls, wrapper: path.join(bin, 'claude') };
}
const mgr = (w, extra = {}) => cu.createManager({ h: w.h, ctx: w.ctx, ...extra });

test('версии: разбор, сравнение, только стабильные', () => {
  assert.equal(cu.parseVersion('codex-cli 0.160.0'), '0.160.0');
  assert.equal(cu.parseVersion('2.1.317 (Claude Code)'), '2.1.317');
  assert.ok(cu.cmpVersion('0.166.0', '0.160.0') > 0);
  assert.ok(cu.cmpVersion('2.1.10', '2.1.9') > 0);
  assert.ok(cu.cmpVersion('1.0.0-rc.1', '1.0.0') < 0);
  assert.equal(cu.isStable('0.67.0-preview.0'), false);
  assert.equal(cu.isStable('0.66.0'), true);
});

test('определение: все четыре — путь, способ установки и версия, которую реально запускает Depo', async t => {
  const w = world(t);
  const ctx = { ...w.ctx, run: cu.runCmd };
  const c = await cu.detect('claude', ctx);
  assert.equal(c.kind, 'claude-native');
  assert.equal(c.wrapper, w.wrapper);
  assert.equal(c.running, '2.1.300');
  const x = await cu.detect('codex', ctx);
  assert.deepEqual([x.kind, x.pkg, x.running, x.wrapper], ['npm', '@openai/codex', '0.160.0', path.join(w.bin, 'codex')]);
  const k = await cu.detect('kimi', ctx);
  assert.deepEqual([k.kind, k.pkg, k.running, k.wrapper], ['npm', '@moonshot-ai/kimi-code', '2.4.0', null]);
  const g = await cu.detect('gemini', ctx);
  assert.deepEqual([g.kind, g.pkg, g.running], ['npm', '@google/gemini-cli', '0.66.0']);
});

test('проверка всех: находит новые стабильные версии, пререлизы не берёт', async t => {
  const w = world(t);
  const m = mgr(w);
  const s = await m.checkAll();
  const by = Object.fromEntries(s.agents.map(a => [a.id, a]));
  assert.deepEqual([by.claude.current, by.claude.latest, by.claude.available], ['2.1.300', '2.1.317', true]);
  assert.deepEqual([by.codex.latest, by.codex.available], ['0.166.0', true]);
  assert.deepEqual([by.kimi.latest, by.kimi.available], ['2.4.1', true]);
  assert.deepEqual([by.gemini.latest, by.gemini.available, by.gemini.status], ['0.66.0', false, 'current']);
  assert.ok(by.claude.checked_at && by.codex.kind === 'npm');
  assert.equal(w.npmCalls().length, 0, 'проверка ничего не ставит');
});

test('npm-агенты (Codex, Kimi, Gemini): обновление, проверка запуском, обёртка Codex не тронута', async t => {
  const w = world(t, { latest: { gemini: '0.67.0' } });
  const wrapBefore = fs.readFileSync(path.join(w.bin, 'codex'), 'utf8');
  const updated = [];
  const m = mgr(w, { onUpdated: id => updated.push(id) });
  for (const [id, v] of [['codex', '0.166.0'], ['kimi', '2.4.1'], ['gemini', '0.67.0']]) {
    const r = await m.update(id);
    assert.equal(r.status, 'updated', `${id}: ${r.message}`);
    const d = await cu.detect(id, { ...w.ctx, run: cu.runCmd });
    assert.equal(d.running, v, `${id} запускается новой версией`);
    const s = m.states().agents.find(a => a.id === id);
    assert.deepEqual([s.current, s.prev, s.status], [v, { codex: '0.160.0', kimi: '2.4.0', gemini: '0.66.0' }[id], 'updated']);
  }
  assert.deepEqual(updated, ['codex', 'kimi', 'gemini'], 'кэши моделей сбрасываются после каждого');
  assert.equal(fs.readFileSync(path.join(w.bin, 'codex'), 'utf8'), wrapBefore, 'обёртка с прокси не изменилась');
  assert.match(w.npmCalls()[0], /^install -g --no-fund --no-audit @openai\/codex@0\.166\.0$/);
});

test('Claude: скачивание с проверкой sha256, в обёртке меняется только путь exec — прокси на месте', async t => {
  const w = world(t);
  const before = fs.readFileSync(w.wrapper, 'utf8');
  fs.chmodSync(w.wrapper, 0o775);
  const m = mgr(w);
  const r = await m.update('claude');
  assert.equal(r.status, 'updated', r.message);
  const after = fs.readFileSync(w.wrapper, 'utf8');
  assert.equal(after, before.replace(path.join(w.cv, '2.1.300'), path.join(w.cv, '2.1.317')));
  assert.match(after, /HTTPS_PROXY/);
  assert.equal(fs.statSync(w.wrapper).mode & 0o777, 0o775, 'права обёртки сохранены');
  assert.ok(fs.existsSync(path.join(w.cv, '2.1.300')), 'предыдущая сборка оставлена для отката');
  assert.equal((await cu.detect('claude', { ...w.ctx, run: cu.runCmd })).running, '2.1.317');
  assert.equal(fs.readdirSync(w.ctx.backupDir).length, 1, 'копия обёртки сохранена');
  assert.ok(w.net.hits.some(u => u.endsWith('/2.1.317/manifest.json')));
});

test('Claude: неверная контрольная сумма — файл отброшен, обёртка не тронута', async t => {
  const w = world(t);
  w.net.badChecksum = true;
  const before = fs.readFileSync(w.wrapper, 'utf8');
  const r = await mgr(w).update('claude');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /контрольная сумма/);
  assert.equal(fs.readFileSync(w.wrapper, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(w.cv), ['2.1.300']);
});

test('Claude: ручной откат на предыдущую сборку', async t => {
  const w = world(t);
  const m = mgr(w);
  const up = await m.update('claude');
  assert.equal(up.status, 'updated', up.message);
  const r = await m.rollback('claude');
  assert.ok(r.ok, r.message);
  assert.equal((await cu.detect('claude', { ...w.ctx, run: cu.runCmd })).running, '2.1.300');
  const s = m.states().agents.find(a => a.id === 'claude');
  assert.equal(s.failed_version, '2.1.317', 'откатанную версию сам больше не ставит');
});

test('агент занят задачей — обновление откладывается и ставится, когда освободился', async t => {
  const w = world(t);
  let busy = 'Kimi выполняет задачу в чате «Depo»';
  const m = mgr(w, { isBusy: id => id === 'kimi' ? busy : '' });
  const r = await m.update('kimi');
  assert.equal(r.status, 'pending');
  assert.equal(w.npmCalls().length, 0, 'ничего не ставили');
  assert.equal(m.states().agents.find(a => a.id === 'kimi').deferred, busy);
  busy = '';
  await m.tick();
  const s = m.states().agents.find(a => a.id === 'kimi');
  assert.deepEqual([s.status, s.current], ['updated', '2.4.1']);
});

test('CLI запущен вне Depo (живая сессия) — тоже откладываем', async t => {
  const w = world(t);
  w.ctx.procsUsing = dirs => dirs.some(d => d.endsWith('codex')) ? [4242] : [];
  const r = await mgr(w).update('codex');
  assert.equal(r.status, 'pending');
  assert.match(r.message, /pid 4242/);
  assert.equal(w.npmCalls().length, 0);
});

test('ошибка установки: понятная причина, без бесконечных повторов той же версии', async t => {
  const w = world(t);
  w.ctx.env = { ...w.env, FAIL_PKG: '@moonshot-ai/kimi-code' };
  const m = mgr(w);
  const r = await m.update('kimi');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /ETIMEDOUT/);
  const kimiCalls = () => w.npmCalls().filter(l => l.includes('kimi-code')).length;
  const calls = kimiCalls();
  w.h.setting('cliupd:last_auto', 0);
  await m.tick(); await m.tick();
  assert.equal(kimiCalls(), calls, 'авто не повторяет упавшую версию');
  assert.equal(m.states().agents.find(a => a.id === 'kimi').failed_version, '2.4.1');
});

test('встала нерабочая версия — автоматический откат на предыдущую', async t => {
  const w = world(t);
  w.ctx.env = { ...w.env, BREAK_PKG: '@google/gemini-cli', KEEP_VER: '0.66.0' };
  w.tags.gemini = '0.67.0';
  const r = await mgr(w).update('gemini');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /Откат выполнен: снова 0\.66\.0/);
  assert.equal((await cu.detect('gemini', { ...w.ctx, run: cu.runCmd })).running, '0.66.0');
});

test('после установки пропал вход в аккаунт — откат', async t => {
  const w = world(t);
  let logged = true;
  w.ctx.run = async (cmd, args, o) => {
    const r = await cu.runCmd(cmd, args, o);
    if (args.includes('@openai/codex@0.166.0')) logged = false;     // «обновление стёрло авторизацию»
    return r;
  };
  const m = mgr(w, { authOk: () => logged });
  const r = await m.update('codex');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /пропал вход/);
  assert.match(r.message, /снова 0\.160\.0/);
});

test('пакеты root: через sudo -n, а без sudo — честная ошибка с командой для ручного запуска', async t => {
  const w = world(t, { rootOwned: true });
  const r = await mgr(w).update('kimi');
  assert.equal(r.status, 'failed');
  assert.match(r.action, /sudo npm install -g @moonshot-ai\/kimi-code@2\.4\.1/);
  w.ctx.env = { ...w.env, SUDO_OK: '1' };
  const ok = await mgr(w).update('kimi', { manual: true });
  assert.equal(ok.status, 'updated', ok.message);
});

test('неизвестный способ установки — не обновляем вслепую', async t => {
  const w = world(t);
  fs.rmSync(path.join(w.root, 'gbin', 'gemini'));
  fs.writeFileSync(path.join(w.bin, 'gemini'), `#!${process.execPath}\nconsole.log('0.50.0')\n`, { mode: 0o755 });
  const m = mgr(w);
  const s = await m.check('gemini');
  assert.equal(s.status, 'unsupported');
  assert.equal(s.current, '0.50.0');
  const r = await m.update('gemini');
  assert.equal(r.status, 'failed');
  assert.equal(w.npmCalls().length, 0);
});

test('одно обновление за раз', async t => {
  const w = world(t);
  const m = mgr(w);
  const [a, b] = await Promise.all([m.update('codex'), m.update('kimi')]);
  assert.equal(a.status, 'updated');
  assert.equal(b.status, 'queued');
});

test('раз в сутки: проверка всех и авто-установка только включённых', async t => {
  const w = world(t);
  const m = mgr(w);
  m.setAuto('codex', false);
  await m.tick();
  const by = Object.fromEntries(m.states().agents.map(a => [a.id, a]));
  assert.equal(by.codex.status, 'available', 'авто выключено — только показали');
  assert.deepEqual([by.kimi.status, by.claude.status, by.gemini.status], ['updated', 'updated', 'current'], JSON.stringify([by.claude.error, by.kimi.error]));
  const n = w.npmCalls().length;
  await m.tick();
  assert.equal(w.npmCalls().length, n, 'до следующих суток в сеть и npm не ходим');
});

test('обёртка с двумя ветками exec (с прокси и без) — переключаются обе', async t => {
  const w = world(t);
  const old = path.join(w.cv, '2.1.300');
  fs.writeFileSync(w.wrapper, `#!/usr/bin/env bash\nif [ -n "$NOPROXY" ]; then\n  exec ${old} "$@"\nfi\nexport HTTPS_PROXY=http://127.0.0.1:2080\nexec ${old} "$@"\n`);
  assert.equal((await mgr(w).update('claude')).status, 'updated');
  const txt = fs.readFileSync(w.wrapper, 'utf8');
  assert.equal(txt.match(/2\.1\.317/g).length, 2);
  assert.ok(!txt.includes('2.1.300'));
});

test('другой процесс Depo уже обновляет (lock) — второй не лезет', async t => {
  const w = world(t);
  fs.writeFileSync(w.ctx.lockFile, String(process.ppid));          // живой чужой процесс
  const r = await mgr(w).update('kimi');
  assert.equal(r.status, 'queued');
  assert.equal(w.npmCalls().length, 0);
  fs.writeFileSync(w.ctx.lockFile, '999999');                       // протухший lock забираем
  assert.equal((await mgr(w).update('kimi')).status, 'updated');
  assert.ok(!fs.existsSync(w.ctx.lockFile), 'lock снят');
});

test('перезапуск посреди установки: «обновляется» не висит, версия сама не повторяется', async t => {
  const w = world(t);
  w.h.setting('cliupd:kimi', JSON.stringify({ auto: true, status: 'updating', latest: '2.4.1', current: '2.4.0' }));
  const m = mgr(w);
  const s = m.states().agents.find(a => a.id === 'kimi');
  assert.deepEqual([s.status, s.failed_version], ['failed', '2.4.1']);
});

test('ранняя ошибка не стирает запомненную упавшую версию', async t => {
  const w = world(t);
  w.h.setting('cliupd:kimi', JSON.stringify({ auto: true, failed_version: '2.4.1' }));
  w.ctx.fetch = async () => { throw new Error('сеть недоступна'); };
  const m = mgr(w);
  assert.equal((await m.update('kimi')).status, 'failed');
  assert.equal(m.states().agents.find(a => a.id === 'kimi').failed_version, '2.4.1');
});

test('живая сессия node /usr/bin/kimi (симлинк в пакет) распознаётся как занятость', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depo-procs-'));
  t_cleanup.push(dir);
  return new Promise((resolve, reject) => {
    const pkg = path.join(dir, 'pkg'); fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'main.mjs'), 'setTimeout(()=>{},5000)');
    fs.symlinkSync(path.join(pkg, 'main.mjs'), path.join(dir, 'kimi'));
    import('node:child_process').then(({ spawn }) => {
      const ch = spawn(process.execPath, [path.join(dir, 'kimi')], { stdio: 'ignore' });
      setTimeout(() => {
        try { assert.ok(cu.procsUsing([pkg]).includes(ch.pid)); resolve(); } catch (e) { reject(e); } finally { ch.kill(); }
      }, 300);
    });
  });
});
const t_cleanup = [];
test.after(() => t_cleanup.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

test('сторож после обновления: ошибки лимитов не считаются, два падения подряд — откат', async () => {
  const store = new Map(), logs = [];
  const h = { setting: (k, v) => v === undefined ? store.get(k) : store.set(k, String(v)), log: (lvl, scope, text) => logs.push(text) };
  const m = cu.createManager({ h, ctx: { lockFile: path.join(os.tmpdir(), `depo-wd-${process.pid}.lock`), fetch: async () => new Response('', { status: 404 }) } });
  h.setting('cliupd:kimi', JSON.stringify({ auto: true, current: '2.5.0', prev: '2.4.1', updated_at: Date.now() }));
  assert.equal(await m.reportRun('kimi', { ok: false, error: '5h limit reached' }), null);
  assert.equal(JSON.parse(h.setting('cliupd:kimi')).bad_runs ?? 0, 0);
  assert.equal(await m.reportRun('kimi', { ok: false, error: 'Процесс kimi завершился с кодом 1 и не вернул результат.' }), null);
  assert.equal(JSON.parse(h.setting('cliupd:kimi')).bad_runs, 1);
  const r = await m.reportRun('kimi', { ok: false, error: 'SyntaxError: Unexpected token' });
  assert.ok(r, 'на втором падении — попытка отката');
  assert.equal(r.from, '2.5.0');
  assert.ok(logs.some(l => /упал \(2\/2\)/.test(l)));
  // давно обновлённый агент сторожа не будит
  h.setting('cliupd:codex', JSON.stringify({ current: '1.0.0', prev: '0.9.0', updated_at: Date.now() - 72 * 3600e3 }));
  assert.equal(await m.reportRun('codex', { ok: false, error: 'boom' }), null);
});

test('npm: свежий релиз выдерживается, ставится предыдущая выдержанная версия', async () => {
  const day = 24 * 3600e3, now = Date.now();
  const fetch = async url => url.endsWith('/dist-tags') ? Response.json({ latest: '3.0.0' })
    : Response.json({ time: { '2.9.0': new Date(now - 10 * day).toISOString(), '2.9.5': new Date(now - 3 * day).toISOString(), '3.0.0': new Date(now - 3600e3).toISOString() } });
  const r = await cu._methods.npm.latest({ pkg: '@x/cli' }, { fetch });
  assert.equal(r.version, '2.9.5');
  assert.equal(r.newest, '3.0.0');
  assert.ok(r.ready_at > now);
  const old = await cu._methods.npm.latest({ pkg: '@x/cli' }, { fetch, soakMs: 1000 });
  assert.equal(old.version, '3.0.0');
});
