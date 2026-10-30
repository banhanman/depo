import { spawn } from 'node:child_process';
import os from 'node:os';
import { Screen } from './vt.mjs';
import { kimiEnv } from './accounts.mjs';

const HOME = os.homedir();
export const CMD = {
  claude: ['claude', 'auth', 'login', '--claudeai'],
  codex: ['codex', 'login', '--device-auth'],
  gemini: ['gemini'],
  kimi: ['kimi', 'login', '--region', 'global'],
};
const LINK = /https?:\/\/[^\s"'<>)\]]+/g;
const CODE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;

function linksFrom(screen) {
  const rows = screen.buf.map(r => r.join(''));
  const joined = [];
  let cur = '';
  for (const r of rows) {
    cur += r.trimEnd();
    if (r[r.length - 1] !== ' ') continue;
    if (cur) joined.push(cur);
    cur = '';
  }
  if (cur) joined.push(cur);
  const out = [];
  for (const m of joined.join('\n').match(LINK) ?? []) {
    const u = m.replace(/[.,;)\]'"]+$/, '');
    if (/^https?:\/\/(localhost|127\.)/.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
const TTL = 10 * 60 * 1000;

export class Linker {
  constructor({ log, emit, authSig } = {}) {
    this.log = log ?? (() => { });
    this.emit = emit ?? (() => { });
    this.authSig = authSig ?? (() => '');
    this.jobs = new Map();
  }

  state(provider) {
    const j = this.jobs.get(provider);
    if (!j) return { provider, status: 'idle' };
    return {
      provider, status: j.status, text: j.screen.text(), links: j.links,
      code: CODE.exec(j.screen.text())?.[0] ?? null,
      error: j.error ?? null, started: j.started,
    };
  }

  start(provider) {
    if (!CMD[provider]) throw new Error('Неизвестный агент.');
    const old = this.jobs.get(provider);
    if (old && old.status === 'running') return this.state(provider);
    this.cancel(provider);

    const [bin, ...args] = CMD[provider];
    const quoted = [bin, ...args].map(a => (/[^\w./-]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
    const env = { ...process.env, TERM: 'xterm-256color', BROWSER: 'echo', CI: '', COLUMNS: '80', LINES: '24' };
    const child = spawn('script', ['-qec', quoted, '/dev/null'], {
      cwd: HOME, env: provider === 'kimi' ? kimiEnv(env) : env,
    });

    const j = {
      provider, child, screen: new Screen(80, 24), links: [], status: 'running',
      error: null, started: Date.now(), sig0: this.authSig(provider),
    };
    this.jobs.set(provider, j);
    j.poll = setInterval(() => {
      if (j.status !== 'running') return;
      if (this.authSig(provider) === j.sig0) return;
      this.log('info', 'link', `вход ${provider}: учётные данные появились`);
      j.status = 'done';
      clearInterval(j.poll);
      try { j.child.kill('SIGTERM'); } catch { }
      this.emit('link', this.state(provider));
    }, 1500);
    j.poll.unref?.();

    const take = buf => {
      j.screen.write(buf.toString('utf8'));
      for (const u of linksFrom(j.screen)) if (!j.links.includes(u)) j.links.push(u);
      this.emit('link', this.state(provider));
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', e => { j.status = 'error'; j.error = e.message; this.emit('link', this.state(provider)); });
    child.on('close', code => {
      clearInterval(j.poll);
      if (j.status === 'done') return;
      j.screen.write(`\r\n— процесс завершился (код ${code}) —\r\n`);
      j.status = (code === 0 || this.authSig(provider) !== j.sig0) ? 'done' : 'error';
      if (j.status !== 'done') j.error = `вход прерван (код ${code})`;
      this.log(code === 0 ? 'info' : 'warn', 'link', `вход ${provider}: ${j.status}`);
      this.emit('link', this.state(provider));
      setTimeout(() => { if (this.jobs.get(provider) === j) this.jobs.delete(provider); }, 60000).unref();
    });
    j.timer = setTimeout(() => this.cancel(provider), TTL);
    j.timer.unref();
    this.log('info', 'link', `запущен вход ${provider}`);
    return this.state(provider);
  }

  send(provider, text, { enter = true } = {}) {
    const j = this.jobs.get(provider);
    if (!j || j.status !== 'running') throw new Error('Вход не запущен.');
    j.child.stdin.write(String(text ?? '') + (enter ? '\r' : ''));
    return this.state(provider);
  }

  key(provider, name) {
    const map = { up: '[A', down: '[B', left: '[D', right: '[C', enter: '\r', esc: '', space: ' ' };
    if (!map[name]) throw new Error('Неизвестная клавиша.');
    return this.send(provider, map[name], { enter: false });
  }

  async callback(provider, raw) {
    const j = this.jobs.get(provider);
    if (!j || j.status !== 'running') throw new Error('Вход не запущен.');
    let u;
    try { u = new URL(String(raw).trim()); } catch { throw new Error('Это не похоже на адрес — скопируй строку из адресной строки браузера целиком.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Нужен адрес http:// или https://');
    if (!u.port) throw new Error('В адресе нет порта — значит, это не возврат от входа.');
    const local = `http://127.0.0.1:${u.port}${u.pathname}${u.search}`;
    const r = await fetch(local, { redirect: 'manual', signal: AbortSignal.timeout(20000) })
      .catch(e => { throw new Error(`Не достучался до ${u.port}: ${e.message}`); });
    this.log('info', 'link', `возврат из браузера отдан ${provider} (${r.status})`);
    return this.state(provider);
  }

  cancel(provider) {
    const j = this.jobs.get(provider);
    if (!j) return { provider, status: 'idle' };
    clearTimeout(j.timer); clearInterval(j.poll);
    try { j.child.kill('SIGTERM'); } catch { }
    this.jobs.delete(provider);
    this.emit('link', { provider, status: 'idle' });
    return { provider, status: 'idle' };
  }
}
