// Собеседник: тот, у кого можно спросить «что тут происходит» и «куда дальше».
//
// Он НЕ исполнитель: не трогает файлы, не запускает команд, не просит разрешений.
// Получает выжимку разговора и отвечает словами — текстом в ленту или голосом.
//
// Кем работать собеседником — выбирает владелец в настройках: Codex (аккаунт ChatGPT),
// Claude или Gemini. Привязки к одному провайдеру нет специально: у Google бесплатный
// тариф Gemini CLI для личных аккаунтов закрыт (IneligibleTierError), и упираться в него
// одного было бы глупо.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
export const PROVIDERS = ['codex', 'claude', 'gemini'];
export const DEFAULT = 'codex';

const exists = rel => { try { return fs.statSync(path.join(HOME, rel)).size > 10; } catch { return false; } };
export const ready = p => p === 'gemini' ? exists('.gemini/oauth_creds.json')
  : p === 'codex' ? exists('.codex/auth.json')
    : p === 'claude' ? exists('.claude/.credentials.json') : false;

const ROLE = `Ты — собеседник внутри Depo: панели, через которую владелец ведёт работу с агентами
Claude Code и Codex. Тебе дают выжимку чата: задачи владельца и ответы агента.
Ты ничего не выполняешь и не читаешь файлы — ты объясняешь, подсказываешь и помогаешь решить,
что делать дальше. Отвечай по-русски, коротко и по делу, без вступлений.`;

const VOICE = `\nОтвет будет прочитан вслух, поэтому: две-три фразы, живым языком,
без списков, без разметки, без чтения кода вслух.`;

const DRAFT = `\nРежим «Подготовить уточнение»: владелец хочет дописать агенту уточнение к задаче.
Сформулируй его текст от лица владельца: конкретно, коротко, без вступлений и без кавычек вокруг.
Верни ТОЛЬКО текст уточнения — его покажут владельцу на проверку, сам ты агенту ничего не отправляешь.`;

// Секреты не уходят собеседнику ни при каких условиях: ключи, токены, пароли, приватные ключи.
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
];
export function redact(text) {
  let t = String(text || '');
  t = t.replace(SECRET_RES[0], '[приватный ключ скрыт]');
  t = t.replace(SECRET_RES[1], '[секрет скрыт]');
  t = t.replace(SECRET_RES[2], (_, k) => `${k}[скрыто]`);
  return t;
}

// Выжимка разговора: последние реплики, каждая подрезана — в контекст лезет смысл, а не простыни.
export function digest(messages, { limit = 24, perMessage = 1200 } = {}) {
  return messages.slice(-limit).map(m => {
    const who = m.role === 'user' ? 'Владелец' : m.companion ? 'Собеседник (ты)' : 'Агент';
    const t = redact(m.text).replace(/\s+/g, ' ').trim();
    return `${who}: ${t.length > perMessage ? t.slice(0, perMessage) + '…' : t}`;
  }).filter(s => s.length > 10).join('\n\n');
}

function run(cmd, args, { input = '', timeout = 90000, cwd = HOME } = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { cwd, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
    let out = '', err = '';
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch { } reject(new Error('Собеседник не ответил вовремя.')); }, timeout);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err = (err + d).slice(-4000); });
    ch.on('error', e => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? `${cmd} не установлен на этой машине.` : e.message)); });
    ch.on('close', code => {
      clearTimeout(t);
      if (code === 0 || out.trim()) return resolve(out);
      const e = new Error(err.trim().split('\n').slice(-2).join(' ') || `${cmd} вышел с кодом ${code}`);
      e.stderr = err.trim();
      reject(e);
    });
    ch.stdin.end(input);
  });
}

export function geminiError(raw) {
  const text = String(raw || '');
  if (/IneligibleTier|no longer supported|UNSUPPORTED_CLIENT/i.test(text))
    return new Error('Google закрыл бесплатный Gemini для этого CLI — выбери другого собеседника в настройках.');
  if (/Auth method|Error authenticating/i.test(text)) return new Error('Gemini не подключён — войди в него в настройках.');
  return new Error(text.trim().split('\n').slice(-2).join(' ') || 'Gemini вернул ошибку.');
}

// ── Gemini CLI: вход по аккаунту Google, запрос через stdin ──
async function askGemini(prompt, cwd) {
  let raw;
  try { raw = await run('gemini', ['-p', '', '--approval-mode', 'plan', '--output-format', 'json'], { input: prompt, cwd, timeout: 180000 }); }
  catch (e) { throw geminiError(e.stderr || e.message); }
  try {
    const j = JSON.parse(raw);
    if (j.error) throw geminiError(j.error.message || '');
    return (j.response ?? j.text ?? '').toString().trim();
  } catch (e) { if (e instanceof Error && !/JSON/.test(e.message)) throw e; return raw.trim(); }
}

// ── Codex: разовый ход без песочницы записи, нам нужен только текст ──
async function askCodex(prompt, cwd) {
  const raw = await run('codex', ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], { input: prompt, cwd, timeout: 180000 });
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const it = ev.item ?? {};
    if (ev.type === 'item.completed' && it.type === 'agent_message' && it.text) text = it.text;
    if (ev.type === 'turn.failed') throw new Error(ev.error?.message ?? 'Codex вернул ошибку.');
  }
  return text.trim();
}

// ── Claude: разовый ход в режиме плана, файлы не трогает ──
async function askClaude(prompt, cwd) {
  const raw = await run('claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--no-session-persistence'], { cwd, timeout: 180000 });
  try {
    const j = JSON.parse(raw);
    if (j.is_error) throw new Error(j.result || 'Claude вернул ошибку.');
    return String(j.result ?? '').trim();
  } catch (e) { if (e instanceof Error && !/JSON/.test(e.message)) throw e; return raw.trim(); }
}

// role — своя роль вместо собеседника чата (ассистенту можно читать файлы проекта); cwd — папка проекта.
export async function ask({ provider = DEFAULT, question, context = '', facts = '', voice = false, mode = 'explain', role = ROLE, cwd = HOME } = {}) {
  const who = PROVIDERS.includes(provider) ? provider : DEFAULT;
  if (!ready(who)) throw new Error(`Собеседник (${who}) не подключён — войди в него в настройках.`);
  const prompt = [role, mode === 'draft' ? DRAFT : '', voice ? VOICE : '',
    facts ? `\nФакты, проверенные Depo (а не догадки):\n${redact(facts)}` : '',
    context ? `\nВот разговор в чате:\n\n${context}` : '',
    `\n${mode === 'draft' ? 'Что владелец хочет уточнить' : 'Вопрос владельца'}: ${redact(question)}`].filter(Boolean).join('\n');
  const dir = cwd && fs.existsSync(cwd) ? cwd : HOME;
  const text = who === 'gemini' ? await askGemini(prompt, dir) : who === 'codex' ? await askCodex(prompt, dir) : await askClaude(prompt, dir);
  if (!text) throw new Error('Собеседник вернул пустой ответ.');
  return { text, provider: who };
}
