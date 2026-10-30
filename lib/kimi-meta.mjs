import { spawn } from 'node:child_process';
import os from 'node:os';
import { Screen } from './vt.mjs';
import { kimiEnv } from './accounts.mjs';

const relative = s => 'через ' + s.replace(/(\d+)([dhms])/g, (_, n, unit) =>
  `${n} ${({ d: 'дн.', h: 'ч', m: 'мин', s: 'с' })[unit]}`);

const tokens = (value, suffix) => Math.round(parseFloat(value) * (suffix?.toLowerCase() === 'm' ? 1e6 : suffix?.toLowerCase() === 'k' ? 1e3 : 1));

export function parseKimiUsage(text) {
  const limits = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/(5h|Weekly|Monthly|7d) limit\s+.*?(\d+)% used\s+resets in\s+([^│\n]+)/i);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    limits.push({
      label: kind === '5h' ? 'Сессия · 5 ч' : kind === 'monthly' ? 'Месяц' : 'Неделя',
      pct: +m[2], resets: relative(m[3].trim()),
    });
  }
  const c = String(text || '').match(/Context window[\s\S]*?(\d+)%\s*\(\s*([\d.]+)([kM]?)\s*\/\s*([\d.]+)([kM]?)\s*\)/i);
  const context = c ? { used: tokens(c[2], c[3]), window: tokens(c[4], c[5]), pct: +c[1] } : null;
  return limits.length || context ? { limits, context } : null;
}

export function readKimiUsage({ sessionId = '', cwd = os.homedir(), timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (sessionId && !/^[\w-]+$/.test(sessionId)) return reject(new Error('Некорректная сессия Kimi.'));
    const command = sessionId ? `kimi -S ${sessionId}` : 'kimi';
    const child = spawn('script', ['-qec', command, '/dev/null'], {
      cwd, detached: true,
      env: kimiEnv({ ...process.env, TERM: 'xterm-256color', CI: '', COLUMNS: '100', LINES: '30', KIMI_CODE_SESSION_LOCK: 'off' }),
    });
    const screen = new Screen(100, 30);
    let sent = false, settled = false, readyAt = 0;
    const stop = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } } };
    const timer = setTimeout(() => finish(new Error('Kimi Code не вернул /usage за 30 секунд.')), timeoutMs);
    const poll = setInterval(() => {
      const text = screen.text();
      if (!sent && /No session yet|context:\s*\d+%/.test(text)) {
        if (!readyAt) readyAt = Date.now();
        if (Date.now() - readyAt >= 500) {
          sent = true;
          try { child.stdin.write('/usage\r'); } catch (e) { finish(e); }
        }
      }
      const data = parseKimiUsage(text);
      if (data && (!sessionId || data.context)) finish(null, { at: Date.now(), ...data });
    }, 200);
    const take = buf => screen.write(buf.toString('utf8'));
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(poll); stop();
      if (error) reject(error); else resolve(data);
    };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', finish);
    child.on('close', () => finish(new Error('Kimi Code закрылся до вывода /usage.')));
  });
}
