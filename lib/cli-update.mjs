// Обновления AI CLI: Claude Code, Codex, Kimi Code, Gemini CLI — один менеджер на всех.
// Движок общий (определить → проверить → поставить → убедиться → при сбое откатить),
// различаются только способы установки: глобальный npm-пакет и нативный бинарник Claude.
// Агенты — это данные (какой бинарь, какой пакет), а не четыре копии логики.
//
// Принципы: ставим только стабильные версии из официальных источников; способ установки
// определяем по факту, от того, что реально запускает Depo (его PATH, обёртки, симлинки);
// неизвестный способ не трогаем; обёртки с прокси не перезаписываем — правим только цель exec;
// одно обновление за раз; занятый агент — откладываем; упавшую версию повторно сами не ставим.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

export const AGENTS = {
  claude: { name: 'Claude Code', bin: 'claude', npm: '@anthropic-ai/claude-code' },
  codex: { name: 'Codex CLI', bin: 'codex', npm: '@openai/codex' },
  kimi: { name: 'Kimi Code', bin: 'kimi', npm: '@moonshot-ai/kimi-code' },
  gemini: { name: 'Gemini CLI', bin: 'gemini', npm: '@google/gemini-cli' },
};
export const IDS = Object.keys(AGENTS);

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const CLAUDE_RELEASES = 'https://downloads.claude.ai/claude-code-releases';
// сколько новая версия npm-пакета должна «отлежаться» в реестре, прежде чем Depo её поставит сам
export const SOAK_MS = 48 * 3600e3;
const KIND_NAMES = { npm: 'npm (глобально)', 'claude-native': 'нативный', pipx: 'pipx', uv: 'uv tool', unknown: 'неизвестно' };

// ───────── версии ─────────
const VER = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;
export const parseVersion = s => String(s ?? '').match(VER)?.[0] ?? null;
export const isStable = v => !!v && /^\d+\.\d+\.\d+$/.test(v);
export function cmpVersion(a, b) {
  const pa = String(a).match(VER), pb = String(b).match(VER);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
  return (pa[4] ? -1 : 0) - (pb[4] ? -1 : 0);          // 1.2.3-rc < 1.2.3
}

// ───────── окружение: запуск, поиск в PATH ─────────
export function runCmd(cmd, args, { env = process.env, timeout = 60000, cwd } = {}) {
  return new Promise(resolve => {
    let out = '', err = '', done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout: out, stderr: err }); };
    let ch;
    try { ch = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    const t = setTimeout(() => { err += `\nпрервано: дольше ${Math.round(timeout / 1000)} с`; try { ch.kill('SIGKILL'); } catch { } }, timeout);
    ch.stdout.on('data', d => { out = (out + d).slice(-200000); });
    ch.stderr.on('data', d => { err = (err + d).slice(-200000); });
    ch.on('error', e => { err += e.message; finish(-1); });
    ch.on('close', code => finish(code ?? -1));
  });
}

export function which(bin, PATH = process.env.PATH || '') {
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const f = path.join(dir, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { }
  }
  return null;
}

// Обёртка — shell-скрипт, который в конце делает exec <путь> (так устроены claude/codex с sing-box).
export function readWrapper(file) {
  let head = '';
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(8192); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); head = b.subarray(0, n).toString('utf8'); } catch { return null; }
  if (!/^#!.*\b(ba|da|z)?sh\b/.test(head.split('\n')[0])) return null;
  const m = head.match(/^\s*exec\s+(["']?)(\/[^"'\s]+)\1/m);
  return m ? { file, target: m[2] } : null;
}

// Процессы, которые прямо сейчас исполняют файлы из каталога (живые сессии этого CLI вне Depo).
export function procsUsing(dirs) {
  const hits = [];
  let list = [];
  try { list = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && +n !== process.pid); } catch { return hits; }
  for (const pid of list) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const exe = (() => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return ''; } })();
      // node /usr/bin/kimi … — симлинк в пакет; сравниваем по настоящему пути
      const args = [exe, ...cmd.slice(0, 3)].flatMap(a => { try { return [a, fs.realpathSync(a)]; } catch { return [a]; } });
      if (args.some(a => dirs.some(d => d && (a === d || a.startsWith(d + '/'))))) hits.push(+pid);
    } catch { }
  }
  return hits;
}

const defaultCtx = () => ({
  env: process.env,
  fetch: globalThis.fetch,
  run: runCmd,
  home: os.homedir(),
  platform: `${process.platform}-${process.arch === 'x64' ? 'x64' : process.arch}`,
  procsUsing,
  lockFile: path.join(os.tmpdir(), `depo-cli-update-${process.getuid?.() ?? 'u'}.lock`),
  sudoOk: async ctx => (await ctx.run('sudo', ['-n', 'true'], { env: ctx.env, timeout: 10000 })).code === 0,
});

async function npmRoot(ctx) {
  if (ctx._npmRoot !== undefined) return ctx._npmRoot;
  const r = await ctx.run('npm', ['root', '-g'], { env: ctx.env, timeout: 30000 });
  ctx._npmRoot = r.code === 0 && r.stdout.trim() ? fs.realpathSync(r.stdout.trim()) : null;
  return ctx._npmRoot;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writable = dir => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } };

// ───────── определение установки: от того, что запускает Depo ─────────
export async function detect(id, ctx) {
  const a = AGENTS[id];
  const found = which(a.bin, ctx.env.PATH);
  if (!found) return { id, installed: false, kind: 'unknown', reason: `${a.bin} не найден в PATH, с которым работает Depo` };
  const wrapper = readWrapper(found);
  const target = wrapper?.target ?? found;
  let real;
  try { real = fs.realpathSync(target); } catch { return { id, installed: false, path: found, wrapper: wrapper?.file ?? null, kind: 'unknown', reason: `обёртка ${found} указывает на несуществующий ${target}` }; }

  const info = { id, installed: true, path: found, wrapper: wrapper?.file ?? null, target, real, kind: 'unknown', pkg: null, pkgDir: null, pkgVersion: null };
  const nm = await npmRoot(ctx);
  const claudeVersions = path.join(ctx.home, '.local', 'share', 'claude', 'versions');
  if (nm && real.startsWith(nm + path.sep)) {
    const parts = path.relative(nm, real).split(path.sep);
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pj = readJson(path.join(nm, name, 'package.json'));
    Object.assign(info, { kind: 'npm', npmRoot: nm, pkg: pj?.name ?? name, pkgDir: path.join(nm, name), pkgVersion: pj?.version ?? null });
  } else if (id === 'claude' && path.dirname(real) === claudeVersions) {
    Object.assign(info, { kind: 'claude-native', versionsDir: claudeVersions, pkgVersion: path.basename(real) });
  } else if (/[\\/]pipx[\\/]venvs[\\/]/.test(real)) info.kind = 'pipx';
  else if (/[\\/]uv[\\/]tools[\\/]/.test(real)) info.kind = 'uv';

  // фактическая версия — запуском ровно того, что запускает Depo (через обёртку, с её прокси)
  const r = await ctx.run(found, ['--version'], { env: { ...ctx.env, DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' }, timeout: 60000 });
  info.running = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  if (!info.running) info.reason = `${found} --version не ответил версией${r.stderr ? ': ' + r.stderr.trim().slice(0, 200) : ''}`;
  if (info.kind === 'npm' && info.pkg !== a.npm) info.note = `пакет ${info.pkg} вместо ожидаемого ${a.npm}`;
  return info;
}

// ───────── способы установки ─────────
const METHODS = {
  npm: {
    supported: info => info.pkg ? null : 'не удалось определить npm-пакет',
    // «Проверенная» версия: стабильный latest, но не моложе SOAK_MS. Совсем свежие релизы с ошибкой
    // обычно отзывают или чинят за сутки-двое — их пропускаем и берём предыдущую выдержанную.
    async latest(info, ctx) {
      const res = await ctx.fetch(`${NPM_REGISTRY}/-/package/${info.pkg.replace('/', '%2f')}/dist-tags`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`реестр npm ответил ${res.status}`);
      const v = (await res.json())?.latest;
      if (!isStable(v)) throw new Error(`в реестре npm нет стабильной версии (latest=${v ?? '—'})`);
      let times = null;
      try {
        const r2 = await ctx.fetch(`${NPM_REGISTRY}/${info.pkg.replace('/', '%2f')}`, { signal: AbortSignal.timeout(60000) });
        if (r2.ok) times = (await r2.json())?.time ?? null;
      } catch { }
      if (!times?.[v]) return { version: v, newest: v };
      const soak = ctx.soakMs ?? SOAK_MS, cut = Date.now() - soak;
      if (Date.parse(times[v]) <= cut) return { version: v, newest: v };
      const aged = Object.keys(times).filter(k => isStable(k) && cmpVersion(k, v) < 0 && Date.parse(times[k]) <= cut)
        .sort(cmpVersion).pop();
      return { version: aged ?? null, newest: v, ready_at: Date.parse(times[v]) + soak };
    },
    async install(info, version, ctx, log) {
      // npm перезаписывает каталог пакета и его ссылку в bin — нужна запись и туда, и в корень
      const asRoot = ![info.npmRoot, path.dirname(info.pkgDir), info.pkgDir].every(writable);
      if (asRoot && !(await ctx.sudoOk(ctx)))
        throw Object.assign(new Error(`каталог ${info.npmRoot} принадлежит root, а sudo без пароля недоступен`),
          { action: `выполни вручную: sudo npm install -g ${info.pkg}@${version}` });
      const args = ['install', '-g', '--no-fund', '--no-audit', `${info.pkg}@${version}`];
      log('info', `${asRoot ? 'sudo ' : ''}npm ${args.join(' ')}${asRoot ? ' (глобальные пакеты принадлежат root)' : ''}`);
      // под sudo PATH заменяется на secure_path — передаём тот же npm, что дал npm root
      const npmBin = which('npm', ctx.env.PATH) ?? 'npm';
      const r = asRoot ? await ctx.run('sudo', ['-n', npmBin, ...args], { env: ctx.env, timeout: 15 * 60000 })
        : await ctx.run('npm', args, { env: ctx.env, timeout: 15 * 60000 });
      if (r.code !== 0) throw new Error(`npm завершился с кодом ${r.code}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`);
      const prev = info.pkgVersion;
      return { rollback: prev ? () => METHODS.npm.install(info, prev, ctx, log).then(() => { }) : null };
    },
    busyDirs: info => [info.pkgDir],
  },

  // Нативный Claude: бинарники лежат в ~/.local/share/claude/versions/<версия>.
  // Штатный `claude update` переставил бы ~/.local/bin/claude на симлинк и снёс обёртку с sing-box,
  // поэтому качаем сами из официального источника, сверяем sha256 и меняем только цель exec в обёртке.
  'claude-native': {
    supported: () => null,
    async latest(info, ctx, opts) {
      const channel = opts.channel === 'stable' ? 'stable' : 'latest';
      const res = await ctx.fetch(`${CLAUDE_RELEASES}/${channel}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`downloads.claude.ai ответил ${res.status}`);
      const v = (await res.text()).trim();
      if (!isStable(v)) throw new Error(`канал ${channel} вернул не версию: ${v.slice(0, 60)}`);
      return { version: v, channel };
    },
    async install(info, version, ctx, log) {
      const dir = info.versionsDir, dest = path.join(dir, version);
      const mres = await ctx.fetch(`${CLAUDE_RELEASES}/${version}/manifest.json`, { signal: AbortSignal.timeout(30000) });
      if (!mres.ok) throw new Error(`манифест ${version} недоступен (${mres.status})`);
      const plat = (await mres.json())?.platforms?.[ctx.platform];
      if (!/^[a-f0-9]{64}$/.test(plat?.checksum || '')) throw new Error(`в манифесте ${version} нет сборки для ${ctx.platform}`);
      if (!(fs.existsSync(dest) && await sha256(dest) === plat.checksum)) {
        const free = (() => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } })();
        if (plat.size && free < plat.size + 256 * 2 ** 20)
          throw Object.assign(new Error(`мало места: нужно ${Math.round(plat.size / 2 ** 20) + 256} МБ, свободно ${Math.round(free / 2 ** 20)} МБ`), { action: 'освободи место на диске' });
        log('info', `скачиваю ${version} для ${ctx.platform}${plat.size ? ` (${Math.round(plat.size / 2 ** 20)} МБ)` : ''}`);
        const tmp = path.join(dir, `.${version}.download`);
        try {
          const res = await ctx.fetch(`${CLAUDE_RELEASES}/${version}/${ctx.platform}/claude`, { signal: AbortSignal.timeout(30 * 60000) });
          if (!res.ok || !res.body) throw new Error(`загрузка ответила ${res.status}`);
          const hash = crypto.createHash('sha256'), out = fs.createWriteStream(tmp, { mode: 0o755 });
          for await (const chunk of res.body) { hash.update(chunk); if (!out.write(chunk)) await once(out, 'drain'); }
          out.end();
          await once(out, 'close');           // не 'finish': пока дескриптор открыт, запуск файла падает с ETXTBSY
          const got = hash.digest('hex');
          if (got !== plat.checksum) throw new Error(`контрольная сумма не совпала (${got.slice(0, 12)}… ≠ ${plat.checksum.slice(0, 12)}…) — файл отброшен`);
          fs.chmodSync(tmp, 0o755);
          fs.renameSync(tmp, dest);
        } finally { fs.rmSync(tmp, { force: true }); }
      }
      const self = await ctx.run(dest, ['--version'], { env: { ...ctx.env, DISABLE_AUTOUPDATER: '1' }, timeout: 60000 });
      if (parseVersion(self.stdout) !== version) throw new Error(`скачанный ${version} не запускается: ${(self.stderr || self.stdout).trim().slice(0, 200)}`);
      const undo = switchTarget(info, dest, ctx, log);
      return { rollback: undo };
    },
    busyDirs: () => [],          // старый бинарник остаётся на месте — живые сессии не задеваем
  },
};

async function sha256(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

// Переключение Claude на новый бинарник: в обёртке меняется только путь в строке exec (атомарно,
// права и всё остальное как было; копия обёртки — в резерв), без обёртки — атомарно меняется симлинк.
function switchTarget(info, dest, ctx, log) {
  if (info.wrapper) {
    const before = fs.readFileSync(info.wrapper, 'utf8');
    const lines = before.split('\n');
    const idx = lines.map((l, i) => /^\s*exec\s/.test(l) && l.includes(info.target) ? i : -1).filter(i => i >= 0);
    if (!idx.length) throw new Error(`в обёртке ${info.wrapper} не нашлась строка exec ${info.target}`);
    for (const i of idx) lines[i] = lines[i].split(info.target).join(dest);       // все ветки exec, а не только первая
    if (ctx.backupDir) { fs.mkdirSync(ctx.backupDir, { recursive: true }); fs.copyFileSync(info.wrapper, path.join(ctx.backupDir, `${path.basename(info.wrapper)}.${Date.now()}`)); }
    atomicWrite(info.wrapper, lines.join('\n'));
    log('info', `обёртка ${info.wrapper}: exec → ${dest} (остальное без изменений)`);
    return () => { atomicWrite(info.wrapper, before); log('warn', `обёртка ${info.wrapper} возвращена на ${info.target}`); };
  }
  const link = info.path, old = fs.readlinkSync(link);
  const swap = to => { const t = `${link}.depo-tmp`; fs.rmSync(t, { force: true }); fs.symlinkSync(to, t); fs.renameSync(t, link); };
  swap(dest);
  log('info', `симлинк ${link} → ${dest}`);
  return () => { swap(old); log('warn', `симлинк ${link} возвращён на ${old}`); };
}
function atomicWrite(file, text) {
  const st = fs.statSync(file), tmp = `${file}.depo-tmp`;
  fs.writeFileSync(tmp, text);
  fs.chmodSync(tmp, st.mode & 0o7777);            // umask не должен менять права обёртки
  fs.renameSync(tmp, file);
}

// Чистим старые нативные сборки Claude: остаются текущая и предыдущая (для отката).
function pruneClaude(dir, keep) {
  try {
    const vs = fs.readdirSync(dir).filter(n => /^\d+\.\d+\.\d+$/.test(n)).sort(cmpVersion);
    for (const v of vs) if (!keep.includes(v) && vs.indexOf(v) < vs.length - 2) fs.rmSync(path.join(dir, v), { force: true });
  } catch { }
}

// ───────── менеджер: состояние, журнал, расписание ─────────
// h — помощники БД (setting/log/all), isBusy(id) → причина или '', authOk(id) → вход в агента жив,
// onUpdated(id) — сбросить кэши моделей, onChange(state) — разослать в интерфейс.
export function createManager({ h, ctx: ctxIn = {}, isBusy = () => '', authOk = () => true, onUpdated = () => { }, onChange = () => { }, now = Date.now } = {}) {
  const ctx = { ...defaultCtx(), ...ctxIn };
  let busy = null;                       // id, который сейчас обновляется (одно обновление за раз)
  let timer = null;
  const key = id => `cliupd:${id}`;
  const load = id => ({ auto: true, ...(readSetting(h, key(id)) ?? {}) });
  const save = (id, patch) => { const s = { ...load(id), ...patch }; h.setting(key(id), JSON.stringify(s)); return s; };
  const log = id => (level, text) => h.log(level, 'cli-update', `${AGENTS[id].name}: ${text}`);
  const emit = () => onChange(states());
  // Claude — только проверенный канал stable (latest выходит раньше и чаще ломается)
  const channel = () => h.setting('cliupd:claude_channel') === 'latest' ? 'latest' : 'stable';

  function view(id) {
    const s = load(id);
    return { id, name: AGENTS[id].name, ...s, kind_name: KIND_NAMES[s.kind] ?? s.kind ?? '—',
      updating: busy === id, available: !!(s.latest && s.current && cmpVersion(s.latest, s.current) > 0) };
  }
  const states = () => ({ agents: IDS.map(view), busy, last_auto: +(h.setting('cliupd:last_auto') || 0) || null, channel: channel() });

  async function check(id) {
    const lg = log(id);
    try {
      const info = await detect(id, ctx);
      const base = { checked_at: now(), kind: info.kind, path: info.path ?? null, wrapper: info.wrapper ?? null, real: info.real ?? null,
        current: info.running ?? info.pkgVersion ?? null, installed: info.installed, note: info.note ?? null };
      const m = METHODS[info.kind];
      const why = !info.installed ? info.reason : !m ? `способ установки «${KIND_NAMES[info.kind] ?? info.kind}» Depo обновлять не умеет — обновляй вручную` : m.supported(info);
      if (why) { lg('warn', `проверка: ${why}`); return save(id, { ...base, latest: null, error: why, status: 'unsupported' }); }
      const got = await m.latest(info, ctx, { channel: channel() });
      const version = got.version && cmpVersion(got.version, base.current) > 0 ? got.version : base.current;
      if (info.kind === 'npm' && info.running && info.pkgVersion && info.running !== info.pkgVersion)
        base.note = `Depo запускает ${info.running}, а в пакете ${info.pkgVersion}`;
      const st = cmpVersion(version, base.current) > 0 ? 'available' : 'current';
      const fresh = got.newest && got.newest !== version && cmpVersion(got.newest, base.current) > 0
        ? { newest: got.newest, ready_at: got.ready_at ?? null } : { newest: null, ready_at: null };
      lg('info', `проверка: стоит ${base.current ?? '—'} (${KIND_NAMES[info.kind]}), доступна ${version}${fresh.newest ? `, свежая ${fresh.newest} ещё выдерживается` : ''}`);
      return save(id, { ...base, ...fresh, latest: version, error: null, status: load(id).status === 'pending' && st === 'available' ? 'pending' : st });
    } catch (e) {
      lg('error', `проверка не удалась: ${e.message}`);
      return save(id, { checked_at: now(), error: e.message, status: 'check-failed' });
    } finally { emit(); }
  }
  async function checkAll() { for (const id of IDS) await check(id); h.setting('cliupd:last_check', now()); return states(); }

  // Одно обновление: занятость → откладываем; ставим; проверяем запуском через Depo; вход жив; иначе откат.
  // Процесс упал посреди установки — статус «обновляется» не должен висеть вечно, а версия — ставиться по кругу.
  for (const id of IDS) {
    const s = load(id);
    if (s.status === 'updating') save(id, { status: 'failed', error: 'установка прервана перезапуском Depo — проверь версию', failed_version: s.latest ?? s.failed_version ?? null });
  }

  async function update(id, { manual = false } = {}) {
    if (busy) return { ok: false, status: 'queued', message: `сейчас обновляется ${AGENTS[busy].name}` };
    const release = takeLock(ctx.lockFile);
    if (!release) return { ok: false, status: 'queued', message: 'обновление уже идёт в другом процессе Depo' };
    try { return await updateLocked(id, { manual }); } finally { release(); }
  }
  async function updateLocked(id, { manual }) {
    const reason = isBusy(id);
    if (reason) { save(id, { status: 'pending', deferred: reason }); log(id)('info', `отложено: ${reason}`); emit(); return { ok: false, status: 'pending', message: reason }; }
    busy = id; emit();
    const lg = log(id);
    let undo = null, target = null;
    try {
      const info = await detect(id, ctx);
      const m = METHODS[info.kind];
      if (!info.installed || !m) throw Object.assign(new Error(info.reason || `способ установки «${KIND_NAMES[info.kind] ?? info.kind}» не поддерживается — вслепую не обновляю`), { action: 'обнови вручную' });
      const inUse = m.busyDirs(info).length ? ctx.procsUsing(m.busyDirs(info)) : [];
      if (inUse.length) {
        const why = `${AGENTS[id].name} сейчас запущен вне Depo (pid ${inUse.slice(0, 3).join(', ')})`;
        save(id, { status: 'pending', deferred: why }); lg('info', `отложено: ${why}`);
        return { ok: false, status: 'pending', message: why };
      }
      ({ version: target } = await m.latest(info, ctx, { channel: channel() }));
      const from = info.running ?? info.pkgVersion;
      if (!target) { save(id, { status: 'current', deferred: null, manual_pending: false }); return { ok: true, status: 'current', message: 'свежая версия ещё выдерживается' }; }
      if (cmpVersion(target, from) <= 0) { save(id, { status: 'current', latest: target, current: from, deferred: null, manual_pending: false }); return { ok: true, status: 'current' }; }
      if (!manual && load(id).failed_version === target) {
        save(id, { status: 'available', deferred: null });
        return { ok: false, status: 'skipped', message: `${target} уже не встала — сам повторять не буду` };
      }
      const authBefore = authOk(id);
      save(id, { status: 'updating', deferred: null, error: null });
      lg('info', `обновление ${from} → ${target}${manual ? ' (вручную)' : ''}`);
      ({ rollback: undo } = await m.install(info, target, ctx, lg));
      const after = await detect(id, ctx);
      if (after.running !== target) throw new Error(`после установки Depo запускает ${after.running ?? 'неизвестную версию'} вместо ${target}${after.reason ? ': ' + after.reason : ''}`);
      if (authBefore && !authOk(id)) throw new Error('после установки пропал вход в аккаунт');
      if (info.kind === 'claude-native') pruneClaude(info.versionsDir, [target, from]);
      save(id, { status: 'updated', current: target, latest: target, prev: from, updated_at: now(), failed_version: null, error: null, action: null, manual_pending: false,
        kind: after.kind, path: after.path, real: after.real });
      lg('info', `обновлён до ${target}; Depo запускает ${after.path} → ${target}`);
      try { await onUpdated(id); } catch { }
      return { ok: true, status: 'updated', version: target };
    } catch (e) {
      let rolled = '';
      if (undo) {
        try {
          await undo();
          const back = await detect(id, ctx);
          rolled = back.running ? ` Откат выполнен: снова ${back.running}.` : ' Откат выполнен, но версия не подтвердилась.';
        } catch (e2) { rolled = ` Откат не удался: ${e2.message}.`; }
      }
      const msg = e.message + rolled;
      lg('error', `обновление${target ? ' до ' + target : ''} не удалось: ${msg}${e.action ? ' Что сделать: ' + e.action : ''}`);
      save(id, { status: 'failed', error: msg, action: e.action ?? null, failed_version: target ?? load(id).failed_version ?? null, failed_at: now(), deferred: null, manual_pending: false });
      return { ok: false, status: 'failed', message: msg, action: e.action ?? null };
    } finally { busy = null; emit(); }
  }

  // Ручной откат на предыдущую версию — там, где она известна и способ установки это позволяет.
  async function rollback(id) {
    const s = load(id);
    if (!s.prev) return { ok: false, message: 'предыдущая версия неизвестна' };
    if (busy) return { ok: false, message: `сейчас обновляется ${AGENTS[busy].name}` };
    const reason = isBusy(id);
    if (reason) return { ok: false, message: reason };
    const release = takeLock(ctx.lockFile);
    if (!release) return { ok: false, message: 'обновление уже идёт в другом процессе Depo' };
    busy = id; emit();
    const lg = log(id);
    try {
      const info = await detect(id, ctx);
      if (info.kind === 'npm') await METHODS.npm.install(info, s.prev, ctx, lg);
      else if (info.kind === 'claude-native') {
        const dest = path.join(info.versionsDir, s.prev);
        if (!fs.existsSync(dest)) throw new Error(`сборки ${s.prev} уже нет на диске`);
        switchTarget(info, dest, ctx, lg);
      } else throw new Error('откат для этого способа установки не поддерживается');
      const back = await detect(id, ctx);
      if (back.running !== s.prev) throw new Error(`после отката Depo запускает ${back.running ?? '—'}, а не ${s.prev}`);
      save(id, { status: 'current', current: s.prev, prev: s.current, failed_version: s.latest, error: null });
      lg('warn', `откат выполнен: ${s.current} → ${s.prev}; ${s.latest} сам ставить не буду`);
      return { ok: true, version: s.prev };
    } catch (e) {
      lg('error', `откат не удался: ${e.message}`);
      save(id, { error: `откат не удался: ${e.message}` });
      return { ok: false, message: e.message };
    } finally { busy = null; release(); emit(); }
  }

  // Раз в сутки — проверка всех; авто-включённые с новой версией помечаются «ждёт» и ставятся по одному,
  // когда агент свободен. Тик частый, но дешёвый: без сети, пока сутки не прошли и ждать нечего.
  async function tick() {
    if (busy) return;
    if (now() - (+(h.setting('cliupd:last_auto') || 0)) >= 24 * 3600e3) {
      h.setting('cliupd:last_auto', now());
      await checkAll();
      for (const id of IDS) {
        const s = load(id);
        if (s.auto && s.status === 'available' && s.latest !== s.failed_version) save(id, { status: 'pending' });
      }
      emit();
    }
    for (const id of IDS) {
      const s = load(id);
      if (s.status !== 'pending' || !s.auto && !s.manual_pending) continue;
      await update(id, { manual: !!s.manual_pending });
      if (busy) return;
    }
  }

  // Сторож после обновления: если свежая версия агента в первые двое суток подряд падает на ходах
  // (не лимит, не сеть, не отмена) — сами откатываемся на предыдущую и больше её не ставим.
  const NOT_CLI = /limit|лимит|429|rate|quota|usage|network|сеть|ECONN|ETIMEDOUT|timed? ?out|остановлен|cancel|отклонен|denied|login|войди|auth/i;
  async function reportRun(id, { ok, error = '' } = {}) {
    if (!AGENTS[id]) return null;
    const s = load(id);
    if (!s.updated_at || now() - s.updated_at > 48 * 3600e3 || !s.prev) return null;
    if (ok) { if (s.bad_runs) save(id, { bad_runs: 0 }); return null; }
    if (NOT_CLI.test(error)) return null;
    const bad = (s.bad_runs ?? 0) + 1;
    save(id, { bad_runs: bad });
    log(id)('warn', `ход после обновления до ${s.current} упал (${bad}/2): ${String(error).slice(0, 160)}`);
    if (bad < 2) return null;
    const r = await rollback(id);
    save(id, { bad_runs: 0, auto_rolled: r.ok ? now() : null });
    if (r.ok) log(id)('warn', `автооткат: ${s.current} ломал ходы — вернул ${r.version}`);
    return { rolled: r.ok, from: s.current, to: r.version ?? null, message: r.message ?? null };
  }

  return {
    states, check, checkAll, update, rollback, tick, reportRun,
    isUpdating: id => busy === id,
    setAuto(id, on) { const s = save(id, { auto: !!on }); log(id)('info', `автообновление ${on ? 'включено' : 'выключено'}`); emit(); return s; },
    setChannel(ch) { h.setting('cliupd:claude_channel', ch === 'stable' ? 'stable' : 'latest'); emit(); },
    // ручная кнопка при занятом агенте: запоминаем, чтобы тик поставил, даже если авто выключено
    async requestUpdate(id) {
      const r = await update(id, { manual: true });
      if (r.status === 'pending') save(id, { manual_pending: true });
      return r;
    },
    start({ firstDelay = 3 * 60e3, every = 5 * 60e3 } = {}) {
      const go = () => tick().catch(e => h.log('error', 'cli-update', `расписание: ${e.message}`));
      setTimeout(go, firstDelay).unref?.();
      timer = setInterval(go, every); timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
}

// Один lock на машину: два Depo (боевой и стенд) не должны одновременно гонять npm -g / менять обёртку.
// Протухший lock (процесс умер) забираем.
function takeLock(file) {
  if (!file) return () => { };
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); } catch { } };
    } catch (e) {
      if (e.code !== 'EEXIST') return () => { };
      const pid = +fs.readFileSync(file, 'utf8') || 0;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e2) { alive = e2.code === 'EPERM'; }
      if (alive && pid !== process.pid) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

function readSetting(h, k) { try { const v = h.setting(k); return v ? JSON.parse(v) : null; } catch { return null; } }
export const _methods = METHODS;   // для тестов
