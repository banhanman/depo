import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const CONFIG = path.join('.depo', 'checks.json');
const clip = (s, n = 5000) => String(s || '').slice(-n);
const abs = (root, value) => path.resolve(root, value);

export function normalizeConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Конфигурация должна быть объектом.');
  const strings = name => {
    if (value[name] === undefined) return [];
    if (!Array.isArray(value[name]) || value[name].some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${name}: нужен массив команд.`);
    return value[name].slice(0, 30);
  };
  const config = { checks: strings('checks'), verify: strings('verify'), artifacts: strings('artifacts'), deploy: value.deploy || '', rollback: value.rollback || '', release: value.release || null };
  for (const key of ['deploy', 'rollback']) if (typeof config[key] !== 'string') throw new Error(`${key}: нужна строка команды.`);
  if (config.release) {
    if (typeof config.release !== 'object' || !config.release.source || !config.release.releases || !config.release.current) throw new Error('release: нужны source, releases и current.');
    config.artifacts = [...new Set([...config.artifacts, config.release.source])];
  }
  return config;
}

export function readConfig(root) {
  let value = {};
  try { value = JSON.parse(fs.readFileSync(path.join(root, CONFIG), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Некорректный .depo/checks.json'); }
  return normalizeConfig(value);
}

export async function saveConfig(root, value) {
  const config = normalizeConfig(value);
  await fsp.mkdir(path.join(root, '.depo'), { recursive: true });
  await fsp.writeFile(path.join(root, CONFIG), JSON.stringify(config, null, 2) + '\n');
  return config;
}

export function runCommand(root, command, timeout = 300000) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: { ...process.env, CI: '1' }, detached: true });
    let output = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } }
    }, Math.max(1000, Math.min(+timeout || 300000, 1800000)));
    child.stdout.on('data', d => { output = clip(output + d); });
    child.stderr.on('data', d => { output = clip(output + d); });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, command, output: error.message, duration_ms: Date.now() - started }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, command, output: timedOut ? 'Превышено время проверки.\n' + output : output, duration_ms: Date.now() - started });
    });
  });
}

function localRef(ref) {
  if (!ref || /^(?:[a-z]+:|\/\/|#)/i.test(ref)) return null;
  return decodeURIComponent(ref.split('#')[0].split('?')[0]);
}

async function checkArtifact(root, dir) {
  const base = abs(root, dir), index = path.join(base, 'index.html');
  const refs = [];
  const add = ref => { const clean = localRef(ref); if (clean) refs.push(clean); };
  let html;
  try { html = await fsp.readFile(index, 'utf8'); }
  catch { return { name: dir, ok: false, error: 'Нет dist/index.html или выбранного index.html.' }; }
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const tag = match[0];
    add(tag.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1]);
    if (/rel=["']manifest["']/i.test(tag)) {
      const href = localRef(tag.match(/\bhref=["']([^"']+)["']/i)?.[1]);
      if (href) {
        try {
          const manifestFile = path.resolve(base, href.replace(/^\//, ''));
          const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
          for (const icon of manifest.icons ?? []) {
            const ref = localRef(icon.src);
            if (ref) refs.push(path.join(path.dirname(href), ref).replace(/^\//, ''));
          }
        } catch { return { name: dir, ok: false, error: `Манифест не читается: ${href}` }; }
      }
    }
  }
  for (const ref of refs) {
    const file = path.resolve(base, ref.replace(/^\//, ''));
    if (file !== base && !file.startsWith(base + path.sep)) return { name: dir, ok: false, error: `Ссылка выходит за артефакт: ${ref}` };
    try { const st = await fsp.stat(file); if (!st.isFile()) throw new Error(); }
    catch { return { name: dir, ok: false, error: `Отсутствует файл из HTML/манифеста: ${ref}` }; }
  }
  return { name: dir, ok: true, files: refs.length };
}

export async function checkArtifacts(root, dirs) {
  const results = [];
  for (const dir of dirs) results.push(await checkArtifact(root, dir));
  return { ok: results.every(x => x.ok), results };
}

export async function runChecks(root) {
  let config;
  try { config = readConfig(root); } catch (error) { return { ok: false, results: [{ name: 'config', ok: false, error: error.message }] }; }
  const artifacts = await checkArtifacts(root, config.artifacts);
  const results = artifacts.results.map(x => ({ ...x, name: `Артефакт ${x.name}` }));
  if (!artifacts.ok) return { ok: false, results };
  for (const command of config.checks) {
    const result = await runCommand(root, command);
    results.push({ name: command, ...result });
    if (!result.ok) return { ok: false, results };
  }
  const report = { ok: true, at: Date.now(), results };
  await fsp.mkdir(path.join(root, '.depo'), { recursive: true });
  await fsp.writeFile(path.join(root, '.depo', 'last-check.json'), JSON.stringify(report, null, 2));
  return report;
}

async function verify(root, commands) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(root, command);
    results.push({ name: command, ...result });
    if (!result.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

async function switchLink(current, target) {
  const tmp = path.join(path.dirname(current), `.depo-current-${crypto.randomUUID()}`);
  await fsp.symlink(target, tmp, 'dir');
  await fsp.rename(tmp, current);
}

async function release(root, config) {
  const source = abs(root, config.release.source);
  if (source !== root && !source.startsWith(root + path.sep)) throw new Error('release.source должен быть внутри проекта.');
  const releases = abs(root, config.release.releases), current = abs(root, config.release.current);
  for (const target of [releases, current]) if (target === path.parse(target).root) throw new Error('Небезопасный путь релиза.');
  if (releases === source || releases.startsWith(source + path.sep)) throw new Error('releases не может быть внутри исходного артефакта.');
  await fsp.mkdir(releases, { recursive: true });
  await fsp.mkdir(path.dirname(current), { recursive: true });
  try { const st = await fsp.lstat(current); if (!st.isSymbolicLink()) throw new Error('current уже существует и не является ссылкой Depo.'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const previous = await fsp.realpath(current).catch(() => null);
  const tmp = path.join(releases, `.depo-tmp-${crypto.randomUUID()}`);
  const final = path.join(releases, `release-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`);
  await fsp.cp(source, tmp, { recursive: true, errorOnExist: true });
  await fsp.rename(tmp, final);
  await switchLink(current, final);
  return { release: final, previous };
}

export async function deploy(root) {
  let config;
  try { config = readConfig(root); } catch (error) { return { ok: false, stage: 'config', error: error.message }; }
  if (!config.checks.length) return { ok: false, stage: 'checks', error: 'Публикация запрещена без обязательных проверок в .depo/checks.json.' };
  const checks = await runChecks(root);
  if (!checks.ok) return { ok: false, stage: 'checks', checks };
  let published = null;
  try {
    published = config.release ? await release(root, config) : null;
    if (!config.release && !config.deploy) throw new Error('Нужна команда deploy или настройка release.');
    if (config.deploy) {
      const result = await runCommand(root, config.deploy);
      if (!result.ok) throw Object.assign(new Error('Команда публикации завершилась с ошибкой.'), { deploy: result });
    }
    const verified = await verify(root, config.verify);
    if (!verified.ok) throw Object.assign(new Error('Проверка после публикации не прошла.'), { verified });
    return { ok: true, checks, verify: verified.results, release: published?.release ?? null };
  } catch (error) {
    let rolledBack = false, rollback = null;
    if (published) {
      try {
        if (published.previous) await switchLink(config.release.current, published.previous);
        else await fsp.unlink(abs(root, config.release.current));
        rolledBack = true;
      } catch { }
    }
    if (config.rollback) { rollback = await runCommand(root, config.rollback); rolledBack ||= rollback.ok; }
    return { ok: false, stage: error.verified ? 'verify' : 'deploy', error: error.message, checks, deploy: error.deploy, verify: error.verified?.results, rolledBack, rollback };
  }
}
