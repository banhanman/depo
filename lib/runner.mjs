// Запуск провайдера на один ход: процесс поднимается, отдаёт поток, умирает.
// Поэтому перезагрузка малины не рвёт чаты — живёт только незаконченный ход.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { markOwnProgress } from './sessions.mjs';
import { kimiEnv } from './accounts.mjs';
import * as memory from './memory.mjs';
import { quotaDelta } from './usage.mjs';

const MAX_LINE = 8 * 1024 * 1024;
// Сколько ждать эха от Claude, если в stdin остались незабранные уточнения, а процесс молчит.
const IDLE_CLOSE_MS = +(process.env.DEPO_STEER_IDLE_MS || 60000);

export function phaseForTool(tool) {
  const name = tool?.name || '';
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return 'Изменяет файлы';
  if (/^(Read|Grep|Glob|LS)$/.test(name)) return 'Изучает проект';
  if (name === 'Bash') return /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:run\s+)?test|node\s+--test|pytest|go\s+test|cargo\s+test/.test(tool.input?.command || '') ? 'Запускает тесты' : 'Выполняет команды';
  return 'Анализирует код';
}

export function runInfo(run, now = Date.now()) {
  if (!run) return null;
  const ended = run.status === 'running' ? now : (run.ended_at ?? now);
  const waiting = (run.waiting_ms ?? 0) + (run.wait_started_at ? Math.max(0, ended - run.wait_started_at) : 0);
  const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
  const quotaStart = parse(run.quota_start), quotaEnd = parse(run.quota_end);
  return { ...run, duration_ms: Math.max(0, ended - run.started_at), active_ms: Math.max(0, ended - run.started_at - waiting),
    quota_start: quotaStart, quota_end: quotaEnd, quota_delta: quotaDelta(quotaStart, quotaEnd) };
}

export class Runner {
  constructor({ h, hub, env, envOf, notify, root, approvalEnv, onRateLimit, onRunEnd, onUndelivered, quotaSnapshot }) {
    this.h = h; this.hub = hub; this.env = env; this.envOf = envOf; this.root = root;
    this.notify = notify || (() => { });
    this.approvalEnv = approvalEnv; this.onRateLimit = onRateLimit; this.onRunEnd = onRunEnd; this.onUndelivered = onUndelivered; this.quotaSnapshot = quotaSnapshot;
    this.active = new Map();           // chatId -> {proc, runId, buf, provider}
  }

  isRunning(chatId) { return this.active.has(chatId); }
  activeChats() { return [...this.active.keys()]; }

  // Снять «зависшие» запуски после перезапуска сервиса
  reconcile() {
    const stale = this.h.all("SELECT id, chat_id, pid FROM runs WHERE status='running'");
    for (const r of stale) {
      // процесс провайдера мог пережить падение сервера — он больше никому не нужен
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
    if (kind === 'tool_use' && runId) this.setPhase(chatId, phaseForTool(json));
    return msg;
  }

  setState(chatId, state) {
    this.h.run('UPDATE chats SET state=?, updated_at=? WHERE id=?', state, Date.now(), chatId);
    this.emit(chatId, 'chat', { patch: { state } });
  }

  progress(chatId) {
    const st = this.active.get(chatId); if (!st) return;
    const run = runInfo(this.h.get('SELECT * FROM runs WHERE id=?', st.runId));
    this.emit(chatId, 'run-progress', { run });
  }

  setPhase(chatId, phase) {
    const st = this.active.get(chatId); if (!st || st.waiting) return;
    st.phase = phase;
    this.h.run('UPDATE runs SET phase=? WHERE id=?', phase, st.runId);
    this.progress(chatId);
  }

  setWaiting(chatId, waiting) {
    const st = this.active.get(chatId); if (!st || st.waiting === waiting) return;
    st.waiting = waiting;
    if (waiting) {
      st.phaseBeforeWait = st.phase || 'Анализирует код';
      st.phase = 'Ожидает подтверждения';
      this.h.run("UPDATE runs SET wait_started_at=?,phase='Ожидает подтверждения' WHERE id=?", Date.now(), st.runId);
    } else {
      const run = this.h.get('SELECT wait_started_at,waiting_ms FROM runs WHERE id=?', st.runId);
      const extra = run?.wait_started_at ? Date.now() - run.wait_started_at : 0;
      st.phase = st.phaseBeforeWait || 'Анализирует код';
      this.h.run('UPDATE runs SET waiting_ms=?,wait_started_at=NULL,phase=? WHERE id=?', (run?.waiting_ms ?? 0) + extra, st.phase, st.runId);
    }
    this.progress(chatId);
  }

  // ─────────── claude ───────────
  claudeArgs(chat, sharedContext = '') {
    const a = ['-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Claude возвращает эхо каждого сообщения из stdin, когда реально забирает его в работу:
      // это и есть подтверждение «уточнение принято агентом».
      '--replay-user-messages',
      '--permission-mode', chat.permission_mode || 'acceptEdits'];
    if (chat.claude_started) a.push('--resume', chat.id);
    else a.push('--session-id', chat.id);
    if (chat.model) a.push('--model', chat.model);
    if (chat.effort) a.push('--effort', chat.effort);
    if (sharedContext) a.push('--append-system-prompt', sharedContext);
    // В режимах, где Claude Code задаёт вопросы, вопросы идут в интерфейс Depo через MCP-инструмент
    if (['manual', 'acceptEdits', 'auto'].includes(chat.permission_mode || 'manual') && this.approvalEnv) {
      const cfg = { mcpServers: { depo: { command: process.execPath, args: [path.join(this.root, 'lib', 'approve-mcp.mjs')], env: this.approvalEnv(chat.id) } } };
      a.push('--permission-prompt-tool', 'mcp__depo__approve', '--mcp-config', JSON.stringify(cfg));
    }
    return a;
  }

  start(chat, text, prompt = text, attachments = []) {
    if (this.active.has(chat.id)) throw new Error('В этом чате уже идёт ход.');
    const provider = chat.provider || 'claude';
    memory.ensure({ name: path.basename(chat.cwd), path: chat.cwd });
    const started = Date.now();
    const quotaStart = this.quotaSnapshot?.(provider) ?? null;
    const rr = this.h.run('INSERT INTO runs(chat_id,provider,model,status,started_at,quota_start) VALUES(?,?,?,?,?,?)',
      chat.id, provider, chat.model ?? null, 'running', started, quotaStart ? JSON.stringify(quotaStart) : null);
    const runId = Number(rr.lastInsertRowid);

    // text === null — ход без реплики владельца в ленте (шаги команды агентов показываются своей карточкой)
    if (text !== null) this.save(chat.id, runId, 'user', 'text', text, attachments.length ? { attachments } : null);
    this.h.run('UPDATE chats SET unread=0 WHERE id=?', chat.id);
    this.setState(chat.id, 'running');
    this.emit(chat.id, 'run', { run_id: runId, status: 'running', started_at: started, phase: 'Изучает проект', run: runInfo(this.h.get('SELECT * FROM runs WHERE id=?', runId)) });

    const images = attachments.filter(a => a.image);
    const files = attachments.filter(a => !a.image);
    if (files.length) prompt += '\n\nПриложенные файлы (читай по пути):\n' + files.map(f => '- ' + f.path).join('\n');
    if (provider === 'kimi' && images.length)
      prompt += '\n\nПриложенные изображения (открой каждое инструментом просмотра изображений):\n' + images.map(im => '- ' + im.path).join('\n');
    const needsClaudeContext = ['CLAUDE.md', 'CLAUDE.local.md'].some(name => fs.existsSync(path.join(chat.cwd, name)));
    const sharedContext = needsClaudeContext ? memory.contextFor({ name: path.basename(chat.cwd), path: chat.cwd }, prompt) : '';
    const [cmd, args] = provider === 'codex' ? ['codex', codexArgs(chat, images)]
      : provider === 'kimi' ? ['kimi', kimiArgs(chat, prompt)]
      : ['claude', this.claudeArgs(chat, sharedContext)];
    if (['claude', 'kimi'].includes(provider) && attachments.length) args.push('--add-dir', path.dirname(attachments[0].path));
    if (provider === 'claude' && !chat.claude_started)
      this.h.run('UPDATE chats SET claude_started=1 WHERE id=?', chat.id);

    const env = this.envOf ? this.envOf(chat) : this.env;
    const proc = spawn(cmd, args, {
      cwd: chat.cwd, env: provider === 'kimi' ? kimiEnv(env, chat.effort) : env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    const st = { proc, runId, buf: '', err: '', provider, chat, cancelled: false, sawResult: false, phase: 'Изучает проект', waiting: false,
      inbox: [], inputClosed: false, idle: null };
    this.active.set(chat.id, st);
    this.h.run('UPDATE runs SET pid=? WHERE id=?', proc.pid ?? null, runId);

    // Быстрый CLI может завершиться сразу после первого ввода: слушатели должны
    // быть готовы до записи в stdin, иначе теряется ранний результат или stderr.
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => this.onData(chat.id, d));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { st.err = (st.err + d).slice(-8000); });
    proc.on('error', e => this.finish(chat.id, { error: `Не удалось запустить ${cmd}: ${e.message}` }));
    proc.on('close', code => this.finish(chat.id, { code }));

    if (provider === 'codex') { proc.stdin.write(prompt + '\n'); proc.stdin.end(); }
    else if (provider === 'kimi') { try { proc.stdin.end(); } catch { } }   // kimi -p берёт запрос аргументом
    else this.write(chat.id, prompt, images);
    return runId;
  }

  canWrite(chatId) {
    const st = this.active.get(chatId), pipe = st?.proc.stdin;
    return !!st && st.provider === 'claude' && !st.inputClosed && !!pipe && !pipe.destroyed && !pipe.writableEnded;
  }

  // Дополнить запрос, пока ход идёт. true — строка ушла в stdin живого процесса;
  // «принято агентом» наступает позже, по эху (см. onClaude → 'user').
  write(chatId, text, images = [], { msgId = null } = {}) {
    const st = this.active.get(chatId);
    if (!st || st.provider !== 'claude') return false;
    const pipe = st.proc.stdin;
    if (st.inputClosed || !pipe || pipe.destroyed || pipe.writableEnded) return false;
    const content = [{ type: 'text', text }];
    for (const im of images) {
      try { content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: fs.readFileSync(im.path).toString('base64') } }); }
      catch { }
    }
    const msg = { type: 'user', message: { role: 'user', content } };
    try { pipe.write(JSON.stringify(msg) + '\n'); } catch { return false; }
    st.inbox.push({ msgId, text });
    return true;
  }

  // Ход кончился, а в stdin ждут сообщения, которые Claude ещё не забрал: он возьмёт их
  // следующим ходом того же процесса. Закрываем вход, только когда ждать больше нечего,
  // а если процесс замолчал — через минуту, чтобы не висеть вечно.
  closeInput(chatId, st) {
    clearTimeout(st.idle); st.idle = null;
    if (st.inputClosed) return;
    if (st.inbox.length) { st.idle = setTimeout(() => this.endInput(st), IDLE_CLOSE_MS); return; }
    this.endInput(st);
  }
  endInput(st) {
    st.inputClosed = true;
    try { st.proc.stdin.end(); } catch { }
  }

  steerStatus(chatId, msgId, steer) {
    const row = this.h.get('SELECT json FROM messages WHERE id=? AND chat_id=?', msgId, chatId);
    if (!row) return;
    let json = {}; try { json = row.json ? JSON.parse(row.json) : {}; } catch { }
    json.steer = steer;
    this.h.run('UPDATE messages SET json=? WHERE id=?', JSON.stringify(json), msgId);
    this.emit(chatId, 'message-patch', { id: msgId, json });
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
    if (st.idle) { clearTimeout(st.idle); st.idle = setTimeout(() => this.endInput(st), IDLE_CLOSE_MS); }   // процесс жив и говорит — ждём дальше
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

      case 'stream_event': {           // живой набор текста
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
        const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [{ type: 'text' }];
        if (!blocks.some(b => b.type === 'tool_result')) {
          // эхо нашего сообщения: Claude забрал его в работу
          const got = st.inbox.shift();
          if (got?.msgId) this.steerStatus(chatId, got.msgId, 'accepted');
          break;
        }
        for (const b of blocks) {
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
        this.closeInput(chatId, st);   // ход закончен — закрываем вход (если никто не ждёт), процесс выйдет
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
      // Codex отдаёт usage накопительно по всему треду, поэтому размер текущего
      // промпта — это разница с предыдущим ходом. Иначе «контекст» уходит за 1000%.
      const prev = this.h.get("SELECT input_t FROM runs WHERE chat_id=? AND provider='codex' AND id<? ORDER BY id DESC LIMIT 1", chatId, runId);
      const total = u.input_tokens ?? 0;
      const ctx = prev && total > prev.input_t ? total - prev.input_t : total;
      this.h.run('UPDATE runs SET input_t=?, output_t=?, cache_r=?, ctx_used=?, ctx_window=? WHERE id=?',
        total, u.output_tokens ?? 0, u.cached_input_tokens ?? 0, ctx, 400000, runId);
    } else if (ev.type === 'turn.failed' || ev.type === 'error') {
      st.failed = ev.error?.message ?? ev.message ?? 'Codex сообщил об ошибке.';
    }
  }

  // ─────────── kimi ───────────
  // Kimi Code CLI пишет stream-json в OpenAI-стиле: см. reverse в памяти проекта.
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
      // turn.step.retrying — транзиентный ретрай, не показываем
    } else if (ev.role === 'error') {
      st.failed = ev.message ?? ev.content ?? 'Kimi сообщил об ошибке.';
    }
  }

  finish(chatId, { code, error } = {}) {
    const st = this.active.get(chatId); if (!st) return;
    this.active.delete(chatId);
    clearTimeout(st.idle);
    // Уточнения, которые процесс так и не забрал, не теряем: отдаём серверу в очередь.
    const lost = st.inbox.filter(x => x.msgId);
    for (const x of lost) this.steerStatus(chatId, x.msgId, 'requeued');
    if (lost.length) this.onUndelivered?.(chatId, lost.map(x => x.text));
    this.onRunEnd?.(chatId, st.runId);
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

    const quotaEnd = this.quotaSnapshot?.(st.provider) ?? null;
    this.h.run('UPDATE runs SET status=?, ended_at=?, error=?, phase=?, quota_end=? WHERE id=?',
      status, ended, note, status === 'error' ? 'Ошибка' : 'Завершено', quotaEnd ? JSON.stringify(quotaEnd) : null, runId);

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
      duration_ms: ended - (r?.started_at ?? ended), active_ms: runInfo(r).active_ms,
      phase: r?.phase, run: runInfo(r),
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

// Kimi Code CLI: один ход через -p, stream-json в OpenAI-стиле, resume по id сессии.
// Запрос уходит аргументом (-p), а не stdin — у kimi так.
export function kimiArgs(chat, prompt) {
  const a = [];
  if (chat.kimi_session) a.push('-S', chat.kimi_session);   // продолжить ту же сессию
  if (chat.model) a.push('-m', chat.model);
  if (chat.permission_mode === 'plan') a.push('--plan');   // только читает и планирует
  a.push('--output-format', 'stream-json', '-p', prompt);
  return a;
}

function codexArgs(chat, images = []) {
  // «Режим плана» — только чтение (раньше Codex всегда запускался с правом записи)
  const a = ['exec', '--json', '--skip-git-repo-check', '--sandbox', chat.permission_mode === 'plan' ? 'read-only' : 'workspace-write'];
  if (chat.model) a.push('--model', chat.model);
  if (chat.effort) a.push('-c', `model_reasoning_effort="${chat.effort}"`);
  for (const im of images) a.push('-i', im.path);
  if (chat.codex_thread) { a.push('resume', chat.codex_thread); }
  a.push('-');                       // промпт со stdin
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
