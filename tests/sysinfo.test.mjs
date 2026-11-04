import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serverStats } from '../lib/sysinfo.mjs';

test('состояние сервера: поля в разумных пределах', () => {
  const s = serverStats(process.cwd());
  assert.ok(Number.isInteger(s.cpu_pct) && s.cpu_pct >= 0 && s.cpu_pct <= 100, `cpu_pct=${s.cpu_pct}`);
  assert.ok(s.cpus >= 1);
  assert.ok(s.mem_used > 0 && s.mem_total >= s.mem_used, 'RAM');
  if (s.disk_total != null) assert.ok(s.disk_free >= 0 && s.disk_total > s.disk_free, 'диск');
  if (s.temp_c != null) assert.ok(s.temp_c > -20 && s.temp_c < 120, `temp=${s.temp_c}`);
  assert.ok(s.uptime_s >= 0 && s.proc.pid > 0 && s.proc.rss > 0, 'процесс');
});
