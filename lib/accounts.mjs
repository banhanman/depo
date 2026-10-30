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
const safe = n => String(n || '').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40);

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

export function current(provider) {
  if (provider === 'kimi') return { ok: kimiReady() ? 'аккаунт Kimi' : false };
  if (provider === 'gemini') {
    try { return { ok: fs.statSync(path.join(HOME, '.gemini', 'oauth_creds.json')).size > 10 ? 'аккаунт Google' : false }; }
    catch { return { ok: false }; }
  }
  try {
    const f = SRC[provider][0];
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (provider === 'claude') {
      const o = d.claudeAiOauth ?? {};
      return { ok: true, plan: o.subscriptionType ?? null, expires: o.expiresAt ?? null, mtime: fs.statSync(f).mtimeMs };
    }
    const t = d.tokens ?? {};
    return { ok: true, plan: d.openai_api_key ? 'api key' : (t.account_id ? 'подписка' : null), account: t.account_id ?? null, mtime: fs.statSync(f).mtimeMs };
  } catch { return { ok: false }; }
}

export function list(root, provider) {
  const dir = dirFor(root, provider);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const cur = current(provider);
  const same = f => { try { return fs.readFileSync(f, 'utf8') === fs.readFileSync(SRC[provider][0], 'utf8'); } catch { return false; } };
  return names.filter(n => n.endsWith('.json')).map(n => {
    const f = path.join(dir, n);
    return { name: n.slice(0, -5), active: cur.ok && same(f), saved: fs.statSync(f).mtimeMs };
  }).sort((a, b) => b.saved - a.saved);
}

export async function save(root, provider, name) {
  const nm = safe(name);
  if (!nm) throw new Error('Нужно имя профиля.');
  const src = SRC[provider][0];
  if (!fs.existsSync(src)) throw new Error(`Сейчас в ${provider} никто не залогинен — сохранять нечего.`);
  const dir = dirFor(root, provider);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.copyFile(src, path.join(dir, nm + '.json'));
  await fsp.chmod(path.join(dir, nm + '.json'), 0o600);
  return { name: nm };
}

export async function use(root, provider, name) {
  const nm = safe(name);
  const f = path.join(dirFor(root, provider), nm + '.json');
  if (!fs.existsSync(f)) throw new Error('Такого профиля нет.');
  const dst = SRC[provider][0];
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) await fsp.copyFile(dst, dst + '.depo-prev');
  await fsp.copyFile(f, dst);
  await fsp.chmod(dst, 0o600);
  return { name: nm };
}

export async function remove(root, provider, name) {
  await fsp.rm(path.join(dirFor(root, provider), safe(name) + '.json'), { force: true });
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
