// Аккаунты агентов: кто вошёл (почта) и профили — несколько аккаунтов на агента.
// Вход делает сам CLI через браузер, а переключение между сохранёнными —
// это подмена файлов с учётными данными, что Depo умеет сам.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';

const HOME = os.homedir();
const SRC = {
  claude: [path.join(HOME, '.claude', '.credentials.json')],
  codex: [path.join(HOME, '.codex', 'auth.json')],
};
// имя профиля = имя файла: почта допустима, слэши и ведущие точки — нет
const safe = n => String(n || '').replace(/[^\p{L}\p{N} _@.+-]+/gu, '').replace(/^[.\s]+/, '').trim().slice(0, 80);

const dirFor = (root, provider) => path.join(root, 'accounts', provider);

const kimiRoot = () => process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');
const kimiCredentialFiles = () => {
  try { return fs.readdirSync(path.join(kimiRoot(), 'credentials')).filter(f => f.endsWith('.json')).map(f => path.join(kimiRoot(), 'credentials', f)); }
  catch { return null; }
};

export function kimiReady() {
  const files = kimiCredentialFiles();
  if (files) return files.some(f => {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return !!(d.access_token || d.refresh_token); }
    catch { return false; }
  });
  try { return JSON.parse(fs.readFileSync(path.join(kimiRoot(), 'region.json'), 'utf8')).authState === 'logged-in'; }
  catch { return false; }
}

export function kimiSignature() {
  const files = kimiCredentialFiles() ?? [];
  return `${kimiReady()}#${files.map(f => {
    try { const st = fs.statSync(f); return `${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}`; }
    catch { return '-'; }
  }).join('|')}`;
}

export function kimiEnv(env, effort = '') {
  const proxy = process.env.DEPO_KIMI_PROXY;
  return {
    ...env,
    ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}),
    ...(effort ? { KIMI_MODEL_THINKING_EFFORT: effort } : {}),
  };
}

// ─────────── кто вошёл: почта/идентификатор аккаунта ───────────
// Берём из того, что сам CLI хранит локально; наружу ничего не запрашиваем.
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const jwt = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };
const claudeJson = () => path.join(HOME, '.claude.json');

export function identity(provider) {
  if (provider === 'claude') {
    const o = readJson(claudeJson())?.oauthAccount ?? {};
    return { email: o.emailAddress ?? null, name: o.displayName ?? null, org: o.organizationName ?? null };
  }
  if (provider === 'codex') {
    const t = readJson(SRC.codex[0])?.tokens ?? {};
    const c = jwt(t.id_token) ?? {};
    return { email: c.email ?? null, name: c.name ?? null, plan: c['https://api.openai.com/auth']?.chatgpt_plan_type ?? null };
  }
  if (provider === 'gemini') return { email: readJson(path.join(HOME, '.gemini', 'google_accounts.json'))?.active ?? null };
  if (provider === 'kimi') {
    for (const f of kimiCredentialFiles() ?? []) {
      const c = jwt(readJson(f)?.access_token);
      const id = c?.user_id ?? c?.sub;
      if (!id) continue;
      const pr = kimiProfiles.get(String(id));   // почту и тариф подтягивает refreshKimiProfile()
      return { email: pr?.email ?? null, user: String(id), name: pr?.nickname || `id ${String(id).slice(-6)}`, plan: pr?.plan ?? null };
    }
  }
  return { email: null };
}

// Профиль Kimi: тот же GET {base}/me, которым Kimi Code CLI сам показывает аккаунт (ник, почта, тариф).
// Токен — из локального входа CLI, только чтение, результат кэшируем на час.
const kimiProfiles = new Map();   // user_id -> { email, nickname, plan, at }
export async function refreshKimiProfile({ force = false, fetchFn = fetch } = {}) {
  for (const f of kimiCredentialFiles() ?? []) {
    const token = readJson(f)?.access_token;
    const id = String(jwt(token)?.user_id ?? jwt(token)?.sub ?? '');
    if (!token || !id) continue;
    const old = kimiProfiles.get(id);
    if (!force && old && Date.now() - old.at < 3600000) return old;
    try {
      const base = (process.env.KIMI_CODE_BASE_URL || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '');
      const r = await fetchFn(base + '/me', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return old ?? null;
      const d = await r.json();
      const pr = { email: d.email || null, nickname: d.nickname || null, plan: d.user_level_name || null, at: Date.now() };
      kimiProfiles.set(id, pr);
      return pr;
    } catch { return old ?? null; }
  }
  return null;
}

export function current(provider) {
  const who = identity(provider);
  if (provider === 'kimi') return { ok: kimiReady() ? 'аккаунт Kimi' : false, ...who };   // plan — из профиля Kimi
  if (provider === 'gemini') {
    try { return { ok: fs.statSync(path.join(HOME, '.gemini', 'oauth_creds.json')).size > 10 ? 'аккаунт Google' : false, ...who }; }
    catch { return { ok: false }; }
  }
  try {
    const f = SRC[provider][0];
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (provider === 'claude') {
      const o = d.claudeAiOauth ?? {};
      return { ok: true, plan: o.subscriptionType ?? null, expires: o.expiresAt ?? null, mtime: fs.statSync(f).mtimeMs, ...who };
    }
    const t = d.tokens ?? {};
    return { ok: true, plan: d.openai_api_key ? 'api key' : (who.plan || (t.account_id ? 'подписка' : null)), account: t.account_id ?? null, mtime: fs.statSync(f).mtimeMs, ...who };
  } catch { return { ok: false }; }
}

// ─────────── профили: несколько аккаунтов на одного агента ───────────
// Профиль — снимок файлов, в которых CLI держит вход, плюс метаданные (почта, последние лимиты).
// Файлы с токенами лежат в data/accounts/<агент>/ с правами 600.
const PROVIDERS = ['claude', 'codex', 'gemini', 'kimi'];
function credFiles(provider) {
  if (provider === 'claude') return [SRC.claude[0]];
  if (provider === 'codex') return [SRC.codex[0]];
  if (provider === 'gemini') return ['oauth_creds.json', 'google_accounts.json'].map(n => path.join(HOME, '.gemini', n));
  if (provider === 'kimi') return kimiCredentialFiles() ?? [];
  return [];
}
const keyOf = f => path.relative(HOME, f);
const fromKey = (provider, k) => {
  const abs = path.resolve(HOME, k);
  // распаковываем только в известные места — профиль не может писать куда попало
  const okDir = provider === 'kimi' ? path.join(kimiRoot(), 'credentials') : null;
  if (okDir ? path.dirname(abs) !== okDir : !credFiles(provider).includes(abs)) throw new Error('Профиль повреждён.');
  return abs;
};
const profId = who => safe(who.user || who.email || '') || null;   // у Kimi — стабильный user_id, у остальных — почта

function readProfile(f) {
  const d = readJson(f);
  if (!d) return null;
  return d.v === 2 ? d : { v: 1, legacy: d };   // старый формат — голая копия файла учётных данных
}

function writeAtomic(f, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, f);
}

// Снимок текущего входа в профиль. Вызывается при каждом показе аккаунтов и перед переключением:
// CLI периодически обновляет токены, и в профиле должна лежать свежая пара.
export function capture(root, provider, { meters = null } = {}) {
  if (!PROVIDERS.includes(provider) || !ready(provider)) return null;
  const who = identity(provider);
  const id = profId(who);
  if (!id) return null;
  const files = {};
  for (const f of credFiles(provider)) { try { files[keyOf(f)] = fs.readFileSync(f, 'utf8'); } catch { } }
  if (!Object.keys(files).length) return null;
  const f = path.join(dirFor(root, provider), id + '.json');
  const old = readProfile(f);
  const prof = {
    v: 2, provider, id, email: who.email ?? null, name: who.name ?? null, plan: current(provider).plan ?? null,
    files, oauthAccount: provider === 'claude' ? readJson(claudeJson())?.oauthAccount ?? null : undefined,
    meters: meters?.limits?.length ? { at: Date.now(), limits: meters.limits } : old?.meters ?? null,
    saved: old?.saved ?? Date.now(),
  };
  const next = JSON.stringify(prof);
  if (!old || JSON.stringify(old) !== next) writeAtomic(f, next);
  return id;
}

export function list(root, provider) {
  const dir = dirFor(root, provider);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const cur = ready(provider) ? profId(identity(provider)) : null;
  const curRaw = (() => { try { return fs.readFileSync(credFiles(provider)[0], 'utf8'); } catch { return null; } })();
  return names.map(n => {
    const f = path.join(dir, n), d = readProfile(f);
    if (!d) return null;
    const id = n.slice(0, -5);
    const active = d.v === 2 ? id === cur : curRaw !== null && JSON.stringify(d.legacy) === JSON.stringify(JSON.parse(curRaw));
    return { id, name: id, email: d.email ?? null, label: d.name ?? null, plan: d.plan ?? null, meters: d.meters ?? null,
      active, saved: fs.statSync(f).mtimeMs, legacy: d.v !== 2 };
  }).filter(Boolean).sort((a, b) => b.active - a.active || b.saved - a.saved);
}

// ручное сохранение под именем (старый путь; теперь вход запоминается сам по почте)
export async function save(root, provider, name) {
  const nm = safe(name);
  if (!nm) throw new Error('Нужно имя профиля.');
  if (!ready(provider)) throw new Error(`Сейчас в ${provider} никто не залогинен — сохранять нечего.`);
  const id = capture(root, provider);
  if (!id) throw new Error('Не удалось прочитать вход этого агента.');
  if (id !== nm) fs.copyFileSync(path.join(dirFor(root, provider), id + '.json'), path.join(dirFor(root, provider), nm + '.json'));
  return { name: nm };
}

export async function use(root, provider, name, { meters = null } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error('Неизвестный агент.');
  const nm = safe(name);
  const f = path.join(dirFor(root, provider), nm + '.json');
  const d = readProfile(f);
  if (!d) throw new Error('Такого профиля нет.');
  capture(root, provider, { meters });   // уходящий аккаунт сохраняем со свежими токенами и лимитами
  const backup = path.join(dirFor(root, provider), '.prev');
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const cf of credFiles(provider)) { try { fs.copyFileSync(cf, path.join(backup, path.basename(cf))); } catch { } }
  if (d.v !== 2) {   // старый профиль: только главный файл
    writeAtomic(SRC[provider]?.[0] ?? credFiles(provider)[0], JSON.stringify(d.legacy));
    return { name: nm };
  }
  if (provider === 'kimi') for (const cf of kimiCredentialFiles() ?? []) fs.rmSync(cf, { force: true });
  for (const [k, body] of Object.entries(d.files ?? {})) writeAtomic(fromKey(provider, k), body);
  if (provider === 'claude' && d.oauthAccount) {
    const cj = readJson(claudeJson());
    if (cj) { cj.oauthAccount = d.oauthAccount; writeAtomic(claudeJson(), JSON.stringify(cj, null, 2), fs.statSync(claudeJson()).mode & 0o777); }
  }
  return { name: nm, email: d.email ?? null };
}

export async function remove(root, provider, name) {
  await fsp.rm(path.join(dirFor(root, provider), safe(name) + '.json'), { force: true });
}

// «Добавить аккаунт»: текущий вход уже сохранён в профиль, локальные файлы убираем —
// без выхода через CLI, который мог бы отозвать токены сохранённого профиля.
export function detach(root, provider) {
  if (!PROVIDERS.includes(provider)) throw new Error('Неизвестный агент.');
  if (ready(provider) && !capture(root, provider)) throw new Error('Не понял, чей это вход, — сохранить его перед добавлением нового не получилось.');
  for (const f of credFiles(provider)) fs.rmSync(f, { force: true });
  return { ok: true };
}

export const ready = provider => !!current(provider).ok;

export function logoutKimi({ spawnFn = spawn, isReady = kimiReady, startDelay = 800, pollMs = 250, timeoutMs = 30000 } = {}) {
  if (!isReady()) return Promise.resolve({ ok: true });
  return new Promise((resolve, reject) => {
    const child = spawnFn('script', ['-qec', 'kimi', '/dev/null'], {
      cwd: HOME, env: kimiEnv({ ...process.env, TERM: 'xterm-256color', CI: '', COLUMNS: '80', LINES: '24' }), detached: true,
    });
    child.stdout?.resume(); child.stderr?.resume();
    let settled = false, starter, poll, timer;
    const terminate = () => {
      try { child.stdin.write('/exit\r'); } catch { }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } }
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(starter); clearTimeout(timer); clearInterval(poll);
      if (!error && !isReady()) { terminate(); resolve({ ok: true }); }
      else { terminate(); reject(error ?? new Error('Kimi Code не подтвердил выход из аккаунта.')); }
    };
    starter = setTimeout(() => {
      try { child.stdin.write('/logout\r'); } catch (e) { finish(e); }
    }, startDelay);
    poll = setInterval(() => { if (!isReady()) finish(); }, pollMs);
    timer = setTimeout(() => finish(new Error('Kimi Code не завершил выход за 30 секунд.')), timeoutMs);
    child.on('error', finish);
    child.on('close', () => finish());
  });
}

// Выход: даём CLI убрать токены своими руками, чтобы не оставить мусор.
export async function logout(provider) {
  if (provider === 'kimi') return logoutKimi();
  if (provider === 'gemini') {
    for (const name of ['oauth_creds.json', 'google_accounts.json'])
      await fsp.rm(path.join(HOME, '.gemini', name), { force: true });
    return { ok: true };
  }
  if (!SRC[provider]) throw new Error('Неизвестный агент.');
  const [cmd, args] = provider === 'codex' ? ['codex', ['logout']] : ['claude', ['/logout']];
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000 }, () => {
      if (provider === 'claude') { try { fs.rmSync(SRC.claude[0], { force: true }); } catch { } }
      if (ready(provider)) return reject(new Error(`${provider} не подтвердил выход из аккаунта.`));
      resolve({ ok: true });
    });
  });
}
