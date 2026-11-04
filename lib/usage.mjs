// Единый снимок показателей: Claude из CLI, Codex из сессий, Kimi из `/usage`.
import { execFile } from 'node:child_process';
import * as codex from './codex-meta.mjs';
import { readKimiUsage } from './kimi-meta.mjs';
import { kimiReady } from './accounts.mjs';

// живые значения важнее разобранных из /usage, но недельный Fable есть только там
const merge = (live, slow) => [...live, ...slow.filter(s => !live.some(l => l.label === s.label))];

export function quotaDelta(start, end) {
  const before = new Map((start?.limits ?? []).map(l => [l.label, l]));
  const changes = [];
  for (const now of end?.limits ?? []) {
    const old = before.get(now.label);
    if (!old) continue;
    const reset = old.resets !== now.resets || now.pct < old.pct;
    changes.push({ label: now.label, from: old.pct, to: now.pct, delta: reset ? null : now.pct - old.pct, reset, resets: now.resets });
  }
  return { approximate: true, changes };
}

const run = (args, opts) => new Promise(res => {
  const p = execFile('claude', args, { timeout: 90000, maxBuffer: 8 << 20, ...opts },
    (err, stdout) => res({ err, stdout: stdout || '' }));
  p.stdin?.end();
});

async function slash(cmd, cwd) {
  const { stdout } = await run(['-p', cmd, '--output-format', 'json', '--no-session-persistence'], { cwd });
  try {
    const d = JSON.parse(stdout);
    return typeof d.result === 'string' ? d.result : null;
  } catch { return null; }
}

// "Current session: 11% used · resets Oct 28, 8:29pm (Europe/Moscow)"
export function parseUsage(text) {
  if (!text) return null;
  const out = { raw: text, limits: [], insights: [] };
  const re = /^(Current (?:session|week)[^:]*):\s*(\d+)%\s*used\s*·\s*resets\s*(.+?)\s*$/gim;
  const label = s => s.replace(/^Current session.*/i, 'Сессия · 5 ч')
    .replace(/^Current week \(all models\).*/i, 'Неделя · все модели')
    .replace(/^Current week \((.+)\).*/i, 'Неделя · $1');
  let m;
  while ((m = re.exec(text))) out.limits.push({ label: label(m[1]), pct: +m[2], resets: ruDate(m[3].replace(/\s*\([^)]*\)\s*$/, '')) });
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\d+% of your usage/.test(t) || /^Top (skills|subagents|MCP)/.test(t)) out.insights.push(t);
  }
  const req = text.match(/Last 24h\s*·\s*([\d\s]+)\s*requests\s*·\s*([\d\s]+)\s*sessions/i);
  if (req) out.today = { requests: +req[1].replace(/\s/g, ''), sessions: +req[2].replace(/\s/g, '') };
  return out;
}

// "Nov 2, 12:59am" → "2 нояб., 00:59"
function ruDate(s) {
  // минуты бывают опущены: "Nov 9, 1am"
  const m = s.match(/^([A-Z][a-z]{2}) (\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return s;
  const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[1].toLowerCase());
  let hh = +m[3] % 12; if (m[5].toLowerCase() === 'pm') hh += 12;
  const d = new Date(new Date().getFullYear(), mon, +m[2], hh, +(m[4] ?? 0));
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Таблица из /context: "| Системный промпт | 8.6k | 0.9% |"
export function parseContext(text) {
  if (!text) return null;
  const out = { raw: text, rows: [], used: 0, window: 0, model: null };
  const m = text.match(/\*\*Model:\*\*\s*(\S+)/);           if (m) out.model = m[1];
  const t = text.match(/\*\*Tokens:\*\*\s*([\d.]+)([km]?)\s*\/\s*([\d.]+)([km]?)/i);
  if (t) { out.used = num(t[1], t[2]); out.window = num(t[3], t[4]); }
  const sec = text.split('### Estimated usage by category')[1]?.split('###')[0] ?? '';
  for (const line of sec.split('\n')) {
    const c = line.split('|').map(s => s.trim()).filter((s, i, a) => !(i === 0 && !s) && !(i === a.length - 1 && !s));
    if (c.length < 3 || /^-+$/.test(c[1]) || c[0] === 'Category') continue;
    const tok = c[1].match(/^([\d.]+)\s*([km]?)$/i);
    if (!tok) continue;
    out.rows.push({ label: ru(c[0]), tokens: num(tok[1], tok[2]), pct: parseFloat(c[2]) || 0 });
  }
  return out;
}
const num = (v, suf) => Math.round(parseFloat(v) * (suf?.toLowerCase() === 'm' ? 1e6 : suf?.toLowerCase() === 'k' ? 1e3 : 1));
const RU = {
  'System prompt': 'Системный промпт', 'System tools': 'Инструменты', 'MCP tools': 'MCP',
  'MCP tools (deferred)': 'MCP (отложенные)', 'System tools (deferred)': 'Инструменты (отложенные)',
  'Memory files': 'Память проекта', 'Skills': 'Скиллы', 'Messages': 'Сообщения',
  'Free space': 'Свободно', 'Autocompact buffer': 'Буфер автосжатия', 'Custom agents': 'Агенты',
};
const ru = s => RU[s] ?? s;

// Точный контекст конкретного чата: /context с --resume отдаёт разбивку именно
// этой сессии и настоящий размер окна. Стоит ноль токенов, занимает пару секунд.
const chatCache = new Map();
export async function chatContext(chatId, cwd, sessionSize = 0) {
  const hit = chatCache.get(chatId);
  if (hit && hit.size === sessionSize && Date.now() - hit.at < 5 * 60e3) return hit.data;
  const { stdout } = await run(['-p', '/context', '--resume', chatId, '--output-format', 'json', '--no-session-persistence'], { cwd });
  let text = null;
  try { const d = JSON.parse(stdout); text = typeof d.result === 'string' ? d.result : null; } catch { }
  const data = parseContext(text);
  if (data) {
    const buf = data.rows.find(r => r.label === 'Буфер автосжатия')?.tokens ?? 0;
    data.untilCompact = Math.max(0, data.window - data.used - buf);
    data.rows = data.rows.filter(r => r.label !== 'Свободно');
    chatCache.set(chatId, { size: sessionSize, at: Date.now(), data });
  }
  return data;
}
export const dropChatContext = id => chatCache.delete(id);

export class Meters {
  constructor({ h, hub, home, notify, codexReady }) {
    this.h = h; this.hub = hub; this.home = home; this.codexReady = codexReady;
    this.notify = notify || (() => { });
    this.usage = null; this.kimi = null; this.context = null; this.at = 0; this.busy = false;
    this.warned = new Map();
  }

  // предупреждаем один раз на каждый перешагнутый порог, при сбросе — забываем
  checkLimits() {
    for (const l of this.usage?.limits ?? []) {
      const was = this.warned.get(l.label) ?? 0;
      const step = l.pct >= 95 ? 95 : l.pct >= 80 ? 80 : 0;
      if (step > was) { this.warned.set(l.label, step); this.notify('limit', { label: l.label, pct: l.pct, resets: l.resets }); }
      else if (l.pct < 50 && was) this.warned.set(l.label, 0);
    }
  }
  both() { return { claude: this.snapshot('claude'), codex: this.snapshot('codex'), kimi: this.snapshot('kimi') }; }

  snapshot(provider = 'claude') {
    if (provider === 'codex') {
      if (this.codexLive?.limits?.length) return { provider: 'codex', at: this.codexLive.at, limits: this.codexLive.limits, context: null, insights: [] };
      const c = codex.snapshot();
      return { provider: 'codex', at: c.at, limits: c.limits, context: null, insights: [] };
    }
    if (provider === 'kimi') return { provider: 'kimi', at: this.kimi?.at ?? 0, limits: this.kimi?.limits ?? [], context: null, insights: [] };
    const limits = this.live?.limits?.length ? merge(this.live.limits, this.usage?.limits ?? []) : (this.usage?.limits ?? []);
    return { provider: 'claude', at: this.at || this.live?.at || 0, limits, context: this.context, insights: this.usage?.insights ?? [] };
  }

  // rate_limit_event приходит в каждом ходе — это точнее и дешевле, чем парсить /usage
  fromEvent(info) {
    const w = info?.unifiedWindows; if (!w) return;
    const fmt = s => new Date(s * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    this.live = {
      at: Date.now(), status: info.status,
      limits: [
        w.five_hour && { label: 'Сессия · 5 ч', pct: Math.round(w.five_hour.utilization * 100), resets: fmt(w.five_hour.resetsAt) },
        w.seven_day && { label: 'Неделя · все модели', pct: Math.round(w.seven_day.utilization * 100), resets: fmt(w.seven_day.resetsAt) },
      ].filter(Boolean),
    };
    this.usage = this.usage || { limits: [], insights: [] };
    for (const l of this.live.limits) {
      const i = this.usage.limits.findIndex(x => x.label === l.label);
      if (i >= 0) this.usage.limits[i] = { ...this.usage.limits[i], ...l }; else this.usage.limits.push(l);
    }
    this.checkLimits();
    this.hub.send('meters', this.both());
  }

  // Сменился аккаунт — прежние цифры чужие: забываем и тянем заново.
  async reset(provider) {
    if (provider === 'claude') { this.usage = null; this.live = null; this.context = null; this.at = 0; }
    if (provider === 'kimi') this.kimi = null;
    if (provider === 'codex') this.codexLive = null;
    this.hub.send('meters', this.both());
    if (provider === 'codex') await this.refreshCodex(true);
    else await this.refresh({ force: true });
    return this.snapshot(provider);
  }

  // Codex: живые лимиты через app-server не чаще раза в 5 минут (или по требованию).
  async refreshCodex(force = false) {
    if (!force && this.codexLive && Date.now() - this.codexLive.at < 300000) return;
    if (!this.codexReady?.() || this.codexBusy) return this.codexBusy;
    this.codexBusy = codex.readLiveLimits()
      .then(r => { this.codexLive = r; this.hub.send('meters', this.both()); })
      .catch(e => this.h.log('warn', 'meters', `Codex лимиты: ${e.message}`))
      .finally(() => { this.codexBusy = null; });
    return this.codexBusy;
  }

  async refresh({ force = false, cwd } = {}) {
    this.refreshCodex(force).catch(() => { });
    if (this.busy) return this.snapshot();
    if (!force && Date.now() - this.at < 55000) return this.snapshot();
    this.busy = true;
    try {
      const k = kimiReady() ? readKimiUsage().catch(e => { this.h.log('warn', 'meters', `Kimi /usage: ${e.message}`); return null; }) : null;
      const [u, c, kData] = await Promise.all([slash('/usage', this.home), slash('/context', cwd || this.home), k]);
      if (u) this.usage = parseUsage(u);
      if (c) this.context = parseContext(c);
      if (kData) this.kimi = kData;
      else if (!kimiReady()) this.kimi = null;
      this.at = Date.now();
      this.checkLimits();
      this.hub.send('meters', this.both());
    } catch (e) { this.h.log('warn', 'meters', e.message); }
    finally { this.busy = false; }
    return this.snapshot();
  }

  startLoop() {
    const tick = () => this.refresh().catch(() => { });
    tick();
    this.timer = setInterval(tick, 60000);
    this.timer.unref?.();
  }
}
