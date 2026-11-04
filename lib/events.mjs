// SSE-шина: сервер шлёт события в браузер, WebSocket не нужен.
export class Hub {
  constructor() { this.clients = new Set(); this.seq = 0; }

  attach(res, req) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const c = { res, alive: true };
    this.clients.add(c);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 25000);
    const bye = () => { clearInterval(ping); this.clients.delete(c); };
    req.on('close', bye); res.on('error', bye);
    return c;
  }

  send(type, data) {
    const payload = `id: ${++this.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try { c.res.write(payload); } catch { this.clients.delete(c); }
    }
  }
}
