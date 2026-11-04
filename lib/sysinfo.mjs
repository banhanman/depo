// Состояние машины для карточки «Сервер» на главной: только локальные источники Node/Linux, без зависимостей и AI-запросов.
import fs from 'node:fs';
import os from 'node:os';

export function serverStats(dataDir = process.cwd(), proc = process) {
  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0];
  let memTotal = os.totalmem(), memAvail = os.freemem();
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const total = mi.match(/MemTotal:\s+(\d+)\s*kB/);
    const avail = mi.match(/MemAvailable:\s+(\d+)\s*kB/);
    if (total) memTotal = +total[1] * 1024;
    if (avail) memAvail = +avail[1] * 1024;
  } catch { }
  let diskFree = null, diskTotal = null;
  try {
    const s = fs.statfsSync(dataDir);
    diskFree = s.bavail * s.bsize; diskTotal = s.blocks * s.bsize;
  } catch { }
  let tempC = null;
  for (const zone of ['/sys/class/thermal/thermal_zone0/temp', '/sys/class/hwmon/hwmon0/temp1_input']) {
    try { tempC = Math.round(fs.readFileSync(zone, 'utf8').trim() / 100) / 10; break; } catch { }
  }
  return {
    cpu_pct: Math.min(100, Math.round(load / cpus * 100)), load: +load.toFixed(2), cpus,
    mem_used: memTotal - memAvail, mem_total: memTotal,
    disk_free: diskFree, disk_total: diskTotal,
    temp_c: tempC,
    uptime_s: Math.floor(os.uptime()),
    proc: { pid: proc.pid, uptime_s: Math.floor(proc.uptime()), rss: proc.memoryUsage().rss },
  };
}
