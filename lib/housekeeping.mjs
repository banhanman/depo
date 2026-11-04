// Уборка, чтобы Depo годами жил на маленьком диске (Raspberry Pi, дешёвый VPS) и не забивал его.
// Что чистим и почему — только то, что не жалко:
//  • журнал Depo (таблица log): старше LOG_DAYS дней и сверх LOG_MAX строк;
//  • длинные выводы команд агентов (tool_result) старше TOOL_DAYS дней — обрезаем до TOOL_KEEP символов,
//    пометив это; сами реплики владельца и ответы агентов не трогаем никогда.
// Файлы проектов, вложения и переписку целиком Depo не удаляет.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_DAYS = 30, LOG_MAX = 20000, TOOL_DAYS = 60, TOOL_KEEP = 1000;
const DAY = 24 * 3600e3;
const MARK = '\n…[вывод сокращён: старше двух месяцев]';

export function prune(h, { now = Date.now() } = {}) {
  const logOld = h.run('DELETE FROM log WHERE ts < ?', now - LOG_DAYS * DAY).changes;
  const extra = h.get('SELECT COUNT(*) n FROM log').n - LOG_MAX;
  const logOver = extra > 0 ? h.run('DELETE FROM log WHERE id IN (SELECT id FROM log ORDER BY id LIMIT ?)', extra).changes : 0;
  const tools = h.run(`UPDATE messages SET text = substr(text, 1, ?) || ?
    WHERE kind='tool_result' AND ts < ? AND length(text) > ? AND text NOT LIKE ?`,
    TOOL_KEEP, MARK, now - TOOL_DAYS * DAY, TOOL_KEEP + MARK.length, '%' + MARK).changes;
  return { log: Number(logOld) + Number(logOver), tools: Number(tools) };
}

const dirSize = dir => {
  let n = 0;
  const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else try { n += fs.statSync(f).size; } catch { } } };
  walk(dir);
  return n;
};

export function usage(h, dataDir) {
  const size = f => { try { return fs.statSync(path.join(dataDir, f)).size; } catch { return 0; } };
  let free = null;
  try { const s = fs.statfsSync(dataDir); free = s.bavail * s.bsize; } catch { }
  return {
    db: size('depo.db') + size('depo.db-wal'), uploads: dirSize(path.join(dataDir, 'uploads')),
    log_rows: h.get('SELECT COUNT(*) n FROM log').n, free,
    rules: { log_days: LOG_DAYS, log_max: LOG_MAX, tool_days: TOOL_DAYS, tool_keep: TOOL_KEEP },
    last: (() => { try { return JSON.parse(h.setting('housekeeping:last') || 'null'); } catch { return null; } })(),
  };
}

export function start(h, { every = DAY, log = () => { } } = {}) {
  const go = () => {
    try {
      const r = prune(h);
      h.setting('housekeeping:last', JSON.stringify({ at: Date.now(), ...r }));
      if (r.log || r.tools) log(`уборка: журнал −${r.log}, сокращено выводов команд: ${r.tools}`);
    } catch (e) { log(`уборка не удалась: ${e.message}`); }
  };
  setTimeout(go, 60e3).unref?.();
  const t = setInterval(go, every); t.unref?.();
  return go;
}
