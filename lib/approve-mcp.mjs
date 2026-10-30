import readline from 'node:readline';

const URL_ = process.env.DEPO_URL, TOKEN = process.env.DEPO_TOKEN, CHAT = process.env.DEPO_CHAT;
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });

async function ask(args) {
  const h = { 'content-type': 'application/json', 'x-depo-token': TOKEN };
  const r = await fetch(`${URL_}/api/approvals`, { method: 'POST', headers: h,
    body: JSON.stringify({ chat_id: CHAT, tool_name: args.tool_name, input: args.input, tool_use_id: args.tool_use_id }) });
  const { id } = await r.json();
  for (;;) {
    const w = await fetch(`${URL_}/api/approvals/${id}/wait`, { headers: h });
    const d = await w.json();
    if (d.decided) return d;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  try {
    if (method === 'initialize') return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'depo', version: '1.0.0' } });
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: [{
      name: 'approve', description: 'Спрашивает владельца Depo, можно ли выполнить инструмент.',
      inputSchema: { type: 'object', properties: {
        tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] });
    if (method === 'tools/call') {
      const a = params?.arguments ?? {};
      let res;
      try { res = await ask(a); }
      catch (e) { res = { allow: false, message: 'Depo недоступен: ' + e.message }; }
      const payload = res.allow
        ? { behavior: 'allow', updatedInput: a.input }
        : { behavior: 'deny', message: res.message || 'Владелец отклонил.' };
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(payload) }] });
    }
    if (id !== undefined) fail(id, -32601, 'нет такого метода');
  } catch (e) { if (id !== undefined) fail(id, -32000, e.message); }
});
