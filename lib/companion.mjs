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

export function digest(messages, { limit = 24, perMessage = 1200 } = {}) {
  return messages.slice(-limit).map(m => {
    const who = m.role === 'user' ? 'Владелец' : m.companion ? 'Собеседник (ты)' : 'Агент';
    const t = (m.text || '').replace(/\s+/g, ' ').trim();
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

async function askGemini(prompt) {
  let raw;
  try { raw = await run('gemini', ['-p', '', '--approval-mode', 'plan', '--output-format', 'json'], { input: prompt }); }
  catch (e) { throw geminiError(e.stderr || e.message); }
  try {
    const j = JSON.parse(raw);
    if (j.error) throw geminiError(j.error.message || '');
    return (j.response ?? j.text ?? '').toString().trim();
  } catch (e) { if (e instanceof Error && !/JSON/.test(e.message)) throw e; return raw.trim(); }
}

async function askCodex(prompt) {
  const raw = await run('codex', ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], { input: prompt });
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

async function askClaude(prompt) {
  const raw = await run('claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan', '--no-session-persistence']);
  try {
    const j = JSON.parse(raw);
    if (j.is_error) throw new Error(j.result || 'Claude вернул ошибку.');
    return String(j.result ?? '').trim();
  } catch (e) { if (e instanceof Error && !/JSON/.test(e.message)) throw e; return raw.trim(); }
}

export async function ask({ provider = DEFAULT, question, context = '', voice = false } = {}) {
  const who = PROVIDERS.includes(provider) ? provider : DEFAULT;
  if (!ready(who)) throw new Error(`Собеседник (${who}) не подключён — войди в него в настройках.`);
  const prompt = [ROLE, voice ? VOICE : '', context ? `\nВот разговор в чате:\n\n${context}` : '',
    `\nВопрос владельца: ${question}`].filter(Boolean).join('\n');
  const text = who === 'gemini' ? await askGemini(prompt) : who === 'codex' ? await askCodex(prompt) : await askClaude(prompt);
  if (!text) throw new Error('Собеседник вернул пустой ответ.');
  return { text, provider: who };
}
