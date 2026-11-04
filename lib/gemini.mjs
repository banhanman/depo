// Gemini — собеседник в чате, а не исполнитель.
//
// Он не запускает команд, не трогает файлы и не просит разрешений: получает выжимку
// текущего разговора и отвечает словами. Нужен, чтобы спросить «что тут вообще
// происходит» или «куда дальше», не отвлекая того, кто работает руками.
//
// Ходим через **Gemini CLI** с входом по Google-аккаунту — ключей API в Depo нет нигде:
// владелец логинится в браузере, как в Claude Code и Codex.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
// после входа Gemini CLI кладёт сюда свои учётные данные — по ним и понимаем, подключён ли он
const CREDS = [path.join(HOME, '.gemini', 'oauth_creds.json'), path.join(HOME, '.gemini', 'google_accounts.json')];
export const ready = () => CREDS.some(f => { try { return fs.statSync(f).size > 10; } catch { return false; } });

const ROLE = `Ты — Gemini, собеседник внутри Depo: панели, через которую владелец ведёт работу
с агентами Claude Code и Codex. Тебе дают выжимку чата: задачи владельца и ответы агента.
Ты ничего не выполняешь и не читаешь файлы — ты объясняешь, подсказываешь и помогаешь решить,
что делать дальше. Отвечай по-русски, коротко и по делу, без вступлений.`;

const VOICE = `\nОтвет будет прочитан вслух, поэтому: две-три фразы, живым языком,
без списков, без разметки, без чтения кода вслух.`;

// Выжимка разговора: последние реплики, каждая подрезана — в контекст лезет смысл, а не простыни.
export function digest(messages, { limit = 24, perMessage = 1200 } = {}) {
  return messages.slice(-limit).map(m => {
    const who = m.role === 'user' ? 'Владелец' : m.provider === 'gemini' ? 'Gemini (ты)' : 'Агент';
    const t = (m.text || '').replace(/\s+/g, ' ').trim();
    return `${who}: ${t.length > perMessage ? t.slice(0, perMessage) + '…' : t}`;
  }).filter(s => s.length > 10).join('\n\n');
}

// Запуск CLI одним ходом. Промпт уходит через stdin: в аргументах он упёрся бы в длину командной строки.
function run(args, input, { timeout = 90000, cwd = HOME } = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn('gemini', args, { cwd, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } });
    let out = '', err = '';
    const t = setTimeout(() => { try { ch.kill('SIGKILL'); } catch { } reject(new Error('Gemini не ответил за полторы минуты.')); }, timeout);
    ch.stdout.on('data', d => { out += d; });
    ch.stderr.on('data', d => { err = (err + d).slice(-4000); });
    ch.on('error', e => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'Gemini CLI не установлен на сервере.' : e.message)); });
    ch.on('close', code => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `Gemini CLI вышел с кодом ${code}`));
    });
    ch.stdin.end(input ?? '');
  });
}

export async function ask({ question, context = '', model = '', voice = false, timeout } = {}) {
  if (!ready()) throw new Error('Gemini не подключён — войди в него в настройках.');
  const prompt = [ROLE, voice ? VOICE : '', context ? `\nВот разговор в чате:\n\n${context}` : '',
    `\nВопрос владельца: ${question}`].filter(Boolean).join('\n');
  const args = ['-p', '', '--approval-mode', 'plan', '--output-format', 'json'];
  if (model) args.push('-m', model);
  const raw = await run(args, prompt, { timeout });
  let text = '';
  try {
    const j = JSON.parse(raw);
    // CLI выходит с нулём даже на ошибке — она лежит внутри json
    if (j.error) throw new Error(/Auth method/i.test(j.error.message || '')
      ? 'Gemini не подключён — войди в него в настройках.' : (j.error.message || 'Gemini вернул ошибку.'));
    text = (j.response ?? j.text ?? j.output ?? '').toString().trim();
    if (!text && Array.isArray(j.messages)) text = j.messages.map(m => m.content ?? '').join('\n').trim();
  } catch (e) { if (e instanceof Error && !/JSON/.test(e.message)) throw e; text = raw.trim(); }
  if (!text) throw new Error('Gemini вернул пустой ответ.');
  return { text };
}
