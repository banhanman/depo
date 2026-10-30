import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { markOwnProgress } from './sessions.mjs';
import { kimiEnv } from './accounts.mjs';

const MAX_LINE = 8 * 1024 * 1024;

export class Runner {
  constructor({ h, hub, env, envOf, notify, root, approvalEnv, onRateLimit, onRunEnd }) {
    this.h = h; this.hub = hub; this.env = env; this.envOf = envOf; this.root = root;
    this.notify = notify || (() => { });
    this.approvalEnv = approvalEnv; this.onRateLimit = onRateLimit; this.onRunEnd = onRunEnd;
    this.active = new Map();
  }

  isRunning(chatId) { return this.active.has(chatId); }
  activeChats() { return [...this.active.keys()]; }

  reconcile() {
    const stale = this.h.all("SELECT id, chat_id, pid FROM runs WHERE status='running'");
    for (const r of stale) {
      if (r.pid) {
        try { process.kill(-r.pid, 'SIGTERM'); this.h.log('info', 'runner', `добит осиротевший процесс ${r.pid}`); }
        catch { try { process.kill(r.pid, 'SIGTERM'); } catch { } }
      }
      this.h.run("UPDATE runs SET status='interrupted', ended_at=? WHERE id=?", Date.now(), r.id);
      this.h.run("UPDATE chats SET state='attention' WHERE id=? AND state='running'", r.chat_id);
      this.h.run('INSERT INTO messages(chat_id,run_id,role,kind,text,ts) VALUES(?,?,?,?,?,?)',
        r.chat_id, r.id, 'system', 'notice', 'Ход прерван перезапуском Depo. Нажми «Продолжить», чтобы дочитать.', Date.now());
    }
    if (stale.length) this.h.log('warn', 'runner', `прервано запусков при старте: ${stale.length}`);
    return stale.length;
  }

  emit(chatId, type, data) { this.hub.send(type, { chat_id: chatId, ...data }); }

  save(chatId, runId, role, kind, text, json) {
    const ts = Date.now();
    const r = this.h.run('INSERT INTO messages(chat_id,run_id,role,kind,text,json,ts) VALUES(?,?,?,?,?,?,?)',
      chatId, runId, role, kind, text ?? null, json ? JSON.stringify(json) : null, ts);
    const provider = runId ? this.h.get('SELECT provider FROM runs WHERE id=?', runId)?.provider ?? null : null;
    const msg = { id: Number(r.lastInsertRowid), chat_id: chatId, run_id: runId, role, kind, text, json: json ?? null, ts, provider };
    this.emit(chatId, 'message', { message: msg });
    return msg;
  }

  setState(chatId, state) {
    this.h.run('UPDATE chats SET state=?, updated_at=? WHERE id=?', state, Date.now(), chatId);
    this.emit(chatId, 'chat', { patch: { state } });
  }

  claudeArgs(chat) {
    const a = ['-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', chat.permission_mode || 'acceptEdits'];
    if (chat.claude_started) a.push('--resume', chat.id);
    else a.push('--session-id', chat.id);
    if (chat.model) a.push('--model', chat.model);
    if (chat.effort) a.push('--effort', chat.effort);
    if (['manual', 'acceptEdits', 'auto'].includes(chat.permission_mode || 'manual') && this.approvalEnv) {
      const cfg = { mcpServers: { depo: { command: process.execPath, args: [path.join(this.root, 'lib', 'approve-mcp.mjs')], env: this.approvalEnv(chat.id) } } };
      a.push('--permission-prompt-tool', 'mcp__depo__approve', '--mcp-config', JSON.stringify(cfg));
    }
    return a;
  }

  start(chat, text, prompt = text, attachments = []) {
    if (this.active.has(chat.id)) throw new Error('В этом чате уже идёт ход.');
    const provider = chat.provider || 'claude';
    const started = Date.now();
    const rr = this.h.run('INSERT INTO runs(chat_id,provider,model,status,started_at) VALUES(?,?,?,?,?)',
      chat.id, provider, chat.model ?? null, 'running', started);
    const runId = Number(rr.lastInsertRowid);

    this.save(chat.id, runId, 'user', 'text', text, attachments.length ? { attachments } : null);
    this.h.run('UPDATE chats SET unread=0 WHERE id=?', chat.id);
    this.setState(chat.id, 'running');
    this.emit(chat.id, 'run', { run_id: runId, status: 'running' });

    const images = attachments.filter(a => a.image);
    const files = attachments.filter(a => !a.image);
    if (files.length) prompt += '\n\nПриложенные файлы (читай по пути):\n' + files.map(f => '- ' + f.path).join('\n');
    const [cmd, args] = provider === 'codex' ? ['codex', codexArgs(chat, images)]
      : provider === 'kimi' ? ['kimi', kimiArgs(chat, prompt)]
      : ['claude', this.claudeArgs(chat)];
    if (provider === 'claude' && attachments.length) args.push('--add-dir', path.dirname(attachments[0].path));
    if (provider === 'claude' && !chat.claude_started)
      this.h.run('UPDATE chats SET claude_started=1 WHERE id=?', chat.id);

    const env = this.envOf ? this.envOf(chat) : this.env;
    const proc = spawn(cmd, args, {
      cwd: chat.cwd, env: provider === 'kimi' ? kimiEnv(env, chat.effort) : env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const st = { proc, runId, buf: '', err: '', provider, chat, cancelled: false, sawResult: false };
    this.active.set(chat.id, st);
    this.h.run('UPDATE runs SET pid=? WHERE id=?', proc.pid ?? null, runId);

    if (provider === 'codex') { proc.stdin.write(prompt + '\n'); proc.stdin.end(); }
    else if (provider === 'kimi') { try { proc.stdin.end(); } catch { } }
    else this.write(chat.id, prompt, images);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => this.onData(chat.id, d));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { st.err = (st.err + d).slice(-8000); });
    proc.on('error', e => this.finish(chat.id, { error: `Не удалось запустить ${cmd}: ${e.message}` }));
    proc.on('close', code => this.finish(chat.id, { code }));
    return runId;
  }

  write(chatId, text, images = []) {
    const st = this.active.get(chatId);
    if (!st || st.provider !== 'claude') return false;
    const content = [{ type: 'text', text }];
    for (const im of images) {
      try { content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: fs.readFileSync(im.path).toString('base64') } }); }
      catch { }
    }
    const msg = { type: 'user', message: { role: 'user', content } };
    try { st.proc.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
  }

  cancel(chatId) {
    const st = this.active.get(chatId);
    if (!st) return false;
    st.cancelled = true;
    try { process.kill(-st.proc.pid, 'SIGTERM'); } catch { try { st.proc.kill('SIGTERM'); } catch { } }
    setTimeout(() => { try { process.kill(-st.proc.pid, 'SIGKILL'); } catch { } }, 4000);
    return true;
  }

  onData(chatId, chunk) {
    const st = this.active.get(chatId); if (!st) return;
    st.buf += chunk;
    if (st.buf.length > MAX_LINE) { st.buf = st.buf.slice(-MAX_LINE); }
    let i;
    while ((i = st.buf.indexOf('\n')) >= 0) {
      const line = st.buf.slice(0, i).trim();
      st.buf = st.buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      try {
        if (st.provider === 'codex') this.onCodex(chatId, st, ev);
        else if (st.provider === 'kimi') this.onKimi(chatId, st, ev);
        else this.onClaude(chatId, st, ev);
      }
      catch (e) { this.h.log('error', 'runner', `разбор события: ${e.message}`); }
    }
  }

  onClaude(chatId, st, ev) {
    const runId = st.runId;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.model) {
          this.h.run('UPDATE chats SET model=COALESCE(model,?) WHERE id=?', ev.model, chatId);
        } else if (ev.subtype === 'permission_denied') {
          this.save(chatId, runId, 'system', 'denied', `Не разрешено: ${ev.tool_name} — ${(ev.message || '').slice(0, 300)}`, { tool_name: ev.tool_name });
        }
        break;

      case 'rate_limit_event':
        if (ev.rate_limit_info) this.onRateLimit?.(ev.rate_limit_info);
        break;

      case 'stream_event': {
        const e = ev.event;
        if (e?.type === 'content_block_delta') {
          if (e.delta?.type === 'text_delta') this.emit(chatId, 'delta', { text: e.delta.text });
          else if (e.delta?.type === 'thinking_delta') this.emit(chatId, 'delta', { thinking: e.delta.thinking });
        } else if (e?.type === 'content_block_start' && e.content_block?.type === 'thinking') {
          this.emit(chatId, 'delta', { thinking_start: true });
        } else if (e?.type === 'content_block_stop') {
          this.emit(chatId, 'delta', { stop: true });
        }
        break;
      }

      case 'assistant': {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) this.save(chatId, runId, 'assistant', 'text', b.text);
          else if (b.type === 'thinking' && b.thinking?.trim()) this.save(chatId, runId, 'assistant', 'thinking', b.thinking);
          else if (b.type === 'tool_use') this.save(chatId, runId, 'tool', 'tool_use', toolLabel(b), { id: b.id, name: b.name, input: trimInput(b.input) });
        }
        const u = ev.message?.usage;
        if (u) this.h.run('UPDATE runs SET input_t=?, output_t=?, cache_r=?, cache_w=? WHERE id=?',
          u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, runId);
        break;
      }

      case 'user': {
        for (const b of ev.message?.content ?? []) {
          if (b.type !== 'tool_result') continue;
          const text = resultText(b.content);
          this.save(chatId, runId, 'tool', 'tool_result', text.slice(0, 4000),
            { tool_use_id: b.tool_use_id, is_error: !!b.is_error, truncated: text.length > 4000 });
        }
        break;
      }

      case 'result': {
        st.sawResult = true;
        const u = ev.usage ?? {};
        const mu = Object.values(ev.modelUsage ?? {})[0];
        const ctxUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        this.h.run(`UPDATE runs SET cost_usd=?, input_t=?, output_t=?, cache_r=?, cache_w=?, ctx_used=?, ctx_window=? WHERE id=?`,
          ev.total_cost_usd ?? 0, u.input_tokens ?? 0, u.output_tokens ?? 0,
          u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0,
          ctxUsed, mu?.contextWindow ?? 0, st.runId);
        st.result = ev;
        try { st.proc.stdin.end(); } catch { }
        break;
      }
    }
  }

  onCodex(chatId, st, ev) {
    const runId = st.runId;
    if (ev.type === 'thread.started' && ev.thread_id) {
      this.h.run('UPDATE chats SET codex_thread=? WHERE id=?', ev.thread_id, chatId);
    } else if (ev.type === 'item.completed') {
      const it = ev.item ?? {};
      if (it.type === 'agent_message' && it.text?.trim()) this.save(chatId, runId, 'assistant', 'text', it.text);
      else if (it.type === 'reasoning' && it.text?.trim()) this.save(chatId, runId, 'assistant', 'thinking', it.text);
      else if (it.type === 'command_execution') this.save(chatId, runId, 'tool', 'tool_use', `Bash  ${it.command ?? ''}`.trim(), { name: 'Bash', input: { command: it.command } });
      else if (it.type === 'file_change') this.save(chatId, runId, 'tool', 'tool_use', `Edit  ${(it.changes ?? []).map(c => c.path).join(', ')}`, { name: 'Edit', input: it });
    } else if (ev.type === 'turn.completed') {
      st.sawResult = true;
      const u = ev.usage ?? {};
      const prev = this.h.get("SELECT input_t FROM runs WHERE chat_id=? AND provider='codex' AND id<? ORDER BY id DESC LIMIT 1", chatId, runId);
      const total = u.input_tokens ?? 0;
      const ctx = prev && total > prev.input_t ? total - prev.input_t : total;
      this.h.run('UPDATE runs SET input_t=?, output_t=?, cache_r=?, ctx_used=?, ctx_window=? WHERE id=?',
        total, u.output_tokens ?? 0, u.cached_input_tokens ?? 0, ctx, 400000, runId);
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      st.failed = ev.error?.message ?? ev.message ?? 'Codex сообщил об ошибке.';
    }
  }

  onKimi(chatId, st, ev) {
    const runId = st.runId;
    if (ev.role === 'assistant') {
      if (typeof ev.content === 'string' && ev.content.trim()) { this.save(chatId, runId, 'assistant', 'text', ev.content); st.sawResult = true; }
      for (const tc of ev.tool_calls ?? []) {
        const name = tc.function?.name ?? 'tool';
        let input = {};
        try { input = JSON.parse(tc.function?.arguments ?? '{}'); } catch { input = { arguments: tc.function?.arguments }; }
        this.save(chatId, runId, 'tool', 'tool_use', toolLabel({ name, input }), { id: tc.id, name, input: trimInput(input) });
        st.sawResult = true;
      }
    } else if (ev.role === 'tool') {
      this.save(chatId, runId, 'tool', 'tool_result', resultText(ev.content), { tool_use_id: ev.tool_call_id, is_error: !!ev.is_error });
    } else if (ev.role === 'meta') {
      if (ev.type === 'session.resume_hint' && ev.session_id) {
        this.h.run('UPDATE chats SET kimi_session=? WHERE id=?', ev.session_id, chatId);
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        st.failed = ev.error_message ?? ev.message ?? 'Kimi сообщил об ошибке.';
      }
    } else if (ev.role === 'error') {
      st.failed = ev.message ?? ev.content ?? 'Kimi сообщил об ошибке.';
    }
  }

  finish(chatId, { code, error } = {}) {
    const st = this.active.get(chatId); if (!st) return;
    this.active.delete(chatId);
    this.onRunEnd?.(chatId);
    const { runId, chat } = st;
    const ended = Date.now();
    let status = 'done', note = null;

    if (st.cancelled) { status = 'cancelled'; note = 'Ход остановлен.'; }
    else if (error) { status = 'error'; note = error; }
    else if (st.failed) { status = 'error'; note = st.failed; }
    else if (!st.sawResult) {
      status = 'error';
      note = tailError(st.err) || `Процесс ${st.provider} завершился с кодом ${code} и не вернул результат.`;
    } else if (st.result?.is_error) {
      status = 'error';
      note = st.result.result || st.result.api_error_status || 'Провайдер вернул ошибку.';
    }

    this.h.run('UPDATE runs SET status=?, ended_at=?, error=? WHERE id=?', status, ended, note, runId);

    const r = this.h.get('SELECT * FROM runs WHERE id=?', runId);
    const chatRow = this.h.get('SELECT * FROM chats WHERE id=?', chatId);
    const turns = (chatRow?.turns ?? 0) + 1;
    const cost = (chatRow?.cost_usd ?? 0) + (r?.cost_usd ?? 0);
    this.h.run('UPDATE chats SET turns=?, cost_usd=?, ctx_used=?, ctx_window=?, updated_at=?, unread=? WHERE id=?',
      turns, cost, r?.ctx_used ?? chatRow?.ctx_used ?? 0, r?.ctx_window || chatRow?.ctx_window || 0, ended, status === 'done' ? 1 : 0, chatId);

    if (chat.provider === 'claude') markOwnProgress(this.h, chat, chat.cwd);
    if (note) this.save(chatId, runId, status === 'error' ? 'error' : 'system', 'notice', note);
    this.setState(chatId, status === 'error' ? 'attention' : 'idle');
    this.emit(chatId, 'run', {
      run_id: runId, status, unread: status === 'done' ? 1 : 0,
      cost_usd: r?.cost_usd ?? 0, turns, total_cost: cost,
      ctx_used: r?.ctx_used ?? 0, ctx_window: r?.ctx_window ?? 0,
      duration_ms: ended - (r?.started_at ?? ended),
    });
    if (status === 'error') this.h.log('error', 'runner', `${chat.id}: ${note}`);
    try {
      const title = chatRow?.title ?? 'чат';
      const project = this.h.get('SELECT name FROM projects WHERE id=?', chatRow?.project_id)?.name ?? '';
      const secs = Math.round((ended - (r?.started_at ?? ended)) / 1000);
      if (status === 'error') this.notify('error', { chat_id: chatId, title, project, text: note, secs });
      else if (status === 'done' && secs >= 120) {
        const answer = this.h.get(
          "SELECT text FROM messages WHERE chat_id=? AND role='assistant' AND kind='text' ORDER BY id DESC LIMIT 1", chatId)?.text;
        this.notify('done_long', { chat_id: chatId, title, project, secs, cost: r?.cost_usd ?? 0, answer });
      }
    } catch { }
  }
}

function kimiArgs(chat, prompt) {
  const a = [];
  if (chat.kimi_session) a.push('-S', chat.kimi_session);
  if (chat.model) a.push('-m', chat.model);
  a.push('--output-format', 'stream-json', '-p', prompt);
  return a;
}

function codexArgs(chat, images = []) {
  const a = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write'];
  if (chat.model) a.push('--model', chat.model);
  if (chat.effort) a.push('-c', `model_reasoning_effort="${chat.effort}"`);
  for (const im of images) a.push('-i', im.path);
  if (chat.codex_thread) { a.push('resume', chat.codex_thread); }
  a.push('-');
  return a;
}

const trimInput = inp => {
  const s = JSON.stringify(inp ?? {});
  return s.length > 4000 ? JSON.parse(JSON.stringify({ _truncated: s.slice(0, 4000) })) : inp;
};

function toolLabel(b) {
  const i = b.input ?? {};
  const one = i.file_path || i.path || i.command || i.pattern || i.url || i.prompt || i.description;
  return `${b.name}${one ? '  ' + String(one).replace(/\s+/g, ' ').slice(0, 180) : ''}`;
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(x => x?.text ?? (x?.type === 'image' ? '[изображение]' : '')).join('\n');
  return c ? JSON.stringify(c) : '';
}

function tailError(err) {
  const lines = (err || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.length ? lines.slice(-3).join(' · ').slice(0, 500) : null;
}
