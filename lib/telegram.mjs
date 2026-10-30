import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const API = 'https://api.telegram.org/bot';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const sh = (cmd, args) => new Promise(res =>
  execFile(cmd, args, { timeout: 8000 }, (e, out) => res(e ? '' : String(out).trim())));

const KEYBOARD = {
  keyboard: [
    [{ text: '📊 Статус' }, { text: '📋 Доска' }],
    [{ text: '🖥️ Сервер' }, { text: '✍️ Ответить' }],
    [{ text: '🔕 Тишина' }, { text: '❔ Помощь' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export class Telegram {
  constructor(h, ctx = {}) {
    this.h = h; this.ctx = ctx;
    this.lastErr = null; this.offset = 0; this.polling = false; this.stopped = false;
  }

  get token() { return this.h.setting('tg_token') || ''; }
  get chat() { return this.h.setting('tg_chat') || ''; }
  get on() { return this.h.setting('tg_enabled') === '1' && !!this.token && !!this.chat; }
  get mutedUntil() { return +(this.h.setting('tg_muted_until') || 0); }
  get muted() { return this.mutedUntil > Date.now(); }

  config() {
    return {
      enabled: this.h.setting('tg_enabled') === '1',
      has_token: !!this.token, chat: this.chat,
      events: JSON.parse(this.h.setting('tg_events') || '["error","attention","limit","done_long"]'),
      muted_until: this.muted ? this.mutedUntil : 0,
      last_error: this.lastErr,
    };
  }
  setConfig({ token, chat, enabled, events }) {
    if (token !== undefined) this.h.setting('tg_token', String(token || ''));
    if (chat !== undefined) this.h.setting('tg_chat', String(chat || ''));
    if (enabled !== undefined) this.h.setting('tg_enabled', enabled ? '1' : '0');
    if (events !== undefined) this.h.setting('tg_events', JSON.stringify(events));
    this.restartPolling();
    return this.config();
  }
  wants(kind) {
    if (!this.on || this.muted) return false;
    try { return JSON.parse(this.h.setting('tg_events') || '[]').includes(kind); } catch { return false; }
  }

  async call(method, body, ms = 15000) {
    if (!this.token) return { ok: false, description: 'Нет токена.' };
    try {
      const r = await fetch(`${API}${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(ms),
      });
      const d = await r.json().catch(() => ({}));
      this.lastErr = d.ok ? null : (d.description || `HTTP ${r.status}`);
      return d;
    } catch (e) { this.lastErr = e.message; return { ok: false, description: e.message }; }
  }

  async send(text, { force = false, keyboard, buttons, chat } = {}) {
    if (!force && (!this.on || this.muted)) return { ok: false, skipped: true };
    const d = await this.call('sendMessage', {
      chat_id: chat || this.chat, text, parse_mode: 'HTML', disable_web_page_preview: true,
      reply_markup: buttons ? { inline_keyboard: buttons } : keyboard ? KEYBOARD : undefined,
    });
    return d.ok ? { ok: true, message_id: d.result.message_id } : { ok: false, error: d.description };
  }

  async whoami() {
    const d = await this.call('getMe', {}, 12000);
    return d.ok ? { ok: true, username: d.result.username } : { ok: false, error: d.description };
  }

  async lastChat() {
    const d = await this.call('getUpdates', { limit: 5, timeout: 0 }, 12000);
    if (!d.ok) return { ok: false, error: d.description };
    const last = [...d.result].reverse().find(u => u.message?.chat?.id);
    return last
      ? { ok: true, chat: String(last.message.chat.id), from: last.message.chat.first_name || last.message.chat.title || '' }
      : { ok: false, error: 'Напиши боту любое сообщение и нажми ещё раз.' };
  }

  askApproval({ id, title, project, tool, what }) {
    return this.send(
      `❓ <b>${esc(project)}</b> · ${esc(title)}\nПросит разрешить <b>${esc(tool)}</b>:\n<code>${esc(String(what).slice(0, 300))}</code>`,
      { buttons: [[{ text: '✅ Разрешить', callback_data: `ok:${id}` }, { text: '🚫 Отклонить', callback_data: `no:${id}` }]] });
  }

  restartPolling() {
    this.stopped = true;
    setTimeout(() => { this.stopped = false; if (!this.polling) this.poll(); }, 800);
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (;;) {
        if (this.stopped || !this.token || !this.chat) break;
        const d = await this.call('getUpdates', { offset: this.offset, timeout: 45, allowed_updates: ['message', 'callback_query'] }, 60000);
        if (!d.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
        for (const u of d.result) {
          this.offset = u.update_id + 1;
          try { await this.onUpdate(u); } catch (e) { this.h.log('warn', 'telegram', e.message); }
        }
      }
    } finally { this.polling = false; }
  }

  mine(id) { return String(id) === String(this.chat); }

  async onUpdate(u) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    const m = u.message;
    if (!m?.text || !this.mine(m.chat.id)) return;
    const t = m.text.trim();

    const target = this.h.setting('tg_reply_to');
    if (target && !t.startsWith('/') && !/^[\u{1F4CA}\u{1F4CB}\u{1F353}✍\u{1F515}\u{1F514}❔]/u.test(t)) {
      this.h.setting('tg_reply_to', '');
      return this.deliver(target, t);
    }

    if (/^\/start/.test(t)) return this.hello();
    if (/^\/help/.test(t) || t.startsWith('❔')) return this.help();
    if (/^\/status/.test(t) || t.startsWith('📊')) return this.status();
    if (/^\/board/.test(t) || t.startsWith('📋')) return this.board();
    if (/^\/pi/.test(t) || t.startsWith('🖥️')) return this.pi();
    if (/^\/reply/.test(t) || t.startsWith('✍')) return this.pickChat();
    if (/^\/mute/.test(t) || t.startsWith('🔕')) return this.muteMenu();
    if (/^\/unmute/.test(t) || t.startsWith('🔔')) return this.unmute();
    return this.send('Не понял. Жми кнопки снизу или /help.', { force: true, keyboard: true });
  }

  async onCallback(q) {
    if (!this.mine(q.message?.chat?.id)) return;
    const [cmd, arg] = String(q.data || '').split(':');
    const done = text => this.call('answerCallbackQuery', { callback_query_id: q.id, text });

    if (cmd === 'ok' || cmd === 'no') {
      const r = this.ctx.decide?.(arg, cmd === 'ok');
      await done(r ? (cmd === 'ok' ? 'Разрешил' : 'Отклонил') : 'Запрос уже закрыт');
      await this.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
      return r ? this.send(`${cmd === 'ok' ? '✅ Разрешено' : '🚫 Отклонено'} — через телеграм.`, { force: true }) : undefined;
    }
    if (cmd === 'chat') {
      this.h.setting('tg_reply_to', arg);
      await done('Пиши сообщение');
      return this.send(`Пишу в «${esc(this.ctx.chat?.(arg)?.title ?? 'чат')}». Следующее сообщение уйдёт агенту.\nПередумал — жми любую кнопку снизу.`, { force: true });
    }
    if (cmd === 'open') { await done(); return this.tail(arg); }
    if (cmd === 'mute') {
      const hrs = +arg;
      this.h.setting('tg_muted_until', String(Date.now() + hrs * 3600e3));
      await done(`Тишина на ${hrs} ч`);
      return this.send(`🔕 Молчу ${hrs} ч. Вернуть звук — 🔔 или /unmute.`, { force: true, keyboard: true });
    }
    await done();
  }

  hello() {
    return this.send(
      `<b>Depo</b> на связи.\nХост: <code>${esc(os.hostname())}</code>\nТвой chat id: <code>${esc(this.chat || '—')}</code>\n\n` +
      'Напишу, когда агент закончит, упадёт или попросит разрешение. Кнопки снизу — чтобы спросить самому.',
      { force: true, keyboard: true });
  }
  help() {
    return this.send(
      '<b>Что я умею</b>\n\n' +
      '📊 <b>Статус</b> — лимиты Claude и Codex, что сейчас работает\n' +
      '📋 <b>Доска</b> — кто ждёт ответа и что доделано без тебя\n' +
      '🖥️ <b>Малина</b> — диски, память, температура, службы, бэкап\n' +
      '✍️ <b>Ответить</b> — выбрать чат и написать в него прямо отсюда\n' +
      '🔕 <b>Тишина</b> — помолчать пару часов\n\n' +
      'Под уведомлением о разрешении будут кнопки «Разрешить / Отклонить» — отвечать можно не открывая панель.',
      { force: true, keyboard: true });
  }

  async status() {
    const m = this.ctx.meters?.() ?? {};
    const line = p => (m[p]?.limits ?? []).map(l => `  ${esc(l.label)} — <b>${l.pct}%</b>, сброс ${esc(l.resets)}`).join('\n') || '  нет данных';
    const running = this.ctx.running?.() ?? [];
    const att = this.ctx.attention?.() ?? [];
    const run = running.length
      ? running.map(c => `  ⏳ ${esc(c.project)} · ${esc(c.title.slice(0, 40))}`).join('\n')
      : '  никто не работает';
    const mute = this.muted ? `\n\n🔕 тишина до ${new Date(this.mutedUntil).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '';
    return this.send(
      `<b>Claude</b>\n${line('claude')}\n\n<b>Codex</b>\n${line('codex')}\n\n<b>Сейчас</b>\n${run}` +
      (att.length ? `\n  ❓ ждут ответа: ${att.length}` : '') + mute,
      { force: true, keyboard: true });
  }

  async board() {
    const items = this.ctx.board?.() ?? [];
    if (!items.length) return this.send('Доска пустая: никто ничего не ждёт.', { force: true, keyboard: true });
    const group = (k, title) => {
      const xs = items.filter(i => i.column === k);
      return xs.length ? `<b>${title}</b>\n` + xs.map(c =>
        `  • ${esc(c.project)} · ${esc(c.title.slice(0, 48))}${c.question ? `\n    <i>${esc(c.question.slice(0, 120))}</i>` : ''}`).join('\n') : '';
    };
    const text = [group('attention', '❓ Ждут тебя'), group('running', '⏳ В работе'), group('done', '✅ Готово, не смотрел')]
      .filter(Boolean).join('\n\n');
    const mark = c => (c.column === 'attention' ? '❓' : c.column === 'running' ? '⏳' : '✅');
    const buttons = items.slice(0, 6).map(c => [{ text: `${mark(c)} ${c.title.slice(0, 40)}`, callback_data: `open:${c.id}` }]);
    return this.send(text, { force: true, buttons });
  }

  async pi() {
    const [root, mem, temp, up, services] = await Promise.all([
      sh('df', ['-h', '/']).then(o => o.split('\n')[1]?.split(/\s+/) ?? []),
      sh('free', ['-m']).then(o => o.split('\n')[1]?.split(/\s+/) ?? []),
      fs.promises.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8').then(v => (+v / 1000).toFixed(1)).catch(() => null),
      sh('uptime', ['-p']),
      Promise.all(['depo', 'depo-voice']
        .map(async u => `${(await sh('systemctl', ['is-active', u])) === 'active' ? '🟢' : '🔴'} ${u}`)),
    ]);
    let bak = null; try { bak = JSON.parse(this.h.setting('last_backup') || 'null'); } catch { }
    return this.send(
      `<b>Сервер ${esc(os.hostname())}</b>\n` +
      `  система — ${esc(root[3] ?? '?')} свободно (${esc(root[4] ?? '?')})\n` +
      `  память — ${esc(mem[6] ?? '?')} МБ доступно из ${esc(mem[1] ?? '?')}\n` +
      (temp ? `  температура — ${esc(temp)} °C\n` : '') +
      `  нагрузка — ${esc(os.loadavg().map(n => n.toFixed(2)).join(' '))}\n  ${esc(up || '')}\n\n` +
      `<b>Службы</b>\n  ${services.join('\n  ')}\n\n` +
      `<b>Бэкап</b>\n  ${bak?.ok ? esc(new Date(bak.at).toLocaleString('ru-RU')) + ` · ${(bak.size / 1048576).toFixed(1)} МБ`
        : bak ? '❗ не прошёл: ' + esc(bak.error || '') : 'ещё не делался'}`,
      { force: true, keyboard: true });
  }

  async pickChat() {
    const items = this.ctx.recent?.() ?? [];
    if (!items.length) return this.send('Нет ни одного чата.', { force: true, keyboard: true });
    const buttons = items.slice(0, 8).map(c => [{ text: `${c.project} · ${c.title.slice(0, 36)}`, callback_data: `chat:${c.id}` }]);
    return this.send('В какой чат написать?', { force: true, buttons });
  }

  async deliver(chatId, text) {
    const r = await this.ctx.send?.(chatId, text);
    if (!r?.ok) return this.send(`Не отправилось: ${esc(r?.error || 'чат недоступен')}`, { force: true, keyboard: true });
    return this.send(`📨 Отправил в «${esc(this.ctx.chat?.(chatId)?.title ?? 'чат')}». Напишу, когда ответит.`, { force: true, keyboard: true });
  }

  async tail(chatId) {
    const c = this.ctx.chat?.(chatId);
    const msgs = this.ctx.tail?.(chatId, 4) ?? [];
    const body = msgs.length ? msgs.map(m => {
      const who = m.role === 'user' ? 'ты' : m.role === 'tool' ? '⚙' : (m.provider === 'codex' ? 'Codex' : 'Claude');
      return `<b>${esc(who)}</b>: ${esc((m.text || '').replace(/\s+/g, ' ').slice(0, 400))}`;
    }).join('\n\n') : 'пусто';
    return this.send(`<b>${esc(c?.title ?? 'чат')}</b>\n\n${body}`,
      { force: true, buttons: [[{ text: '✍️ Написать сюда', callback_data: `chat:${chatId}` }]] });
  }

  muteMenu() {
    return this.send('Сколько помолчать?', {
      force: true,
      buttons: [[{ text: '1 ч', callback_data: 'mute:1' }, { text: '4 ч', callback_data: 'mute:4' }, { text: 'до утра', callback_data: 'mute:10' }]],
    });
  }
  unmute() {
    this.h.setting('tg_muted_until', '0');
    return this.send('🔔 Снова на связи.', { force: true, keyboard: true });
  }
}
