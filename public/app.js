const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  user: null, projects: [], chats: [], meters: null, running: [],
  pid: null, cid: null, messages: [], archOpen: false, live: null, host: null, connected: true, models: null, approvals: [], prefs: {}, https: null, atts: [], ctx: {},
};
const STATE_RU = { running: 'работает', attention: 'нужен ответ', idle: 'ожидает', done: 'завершён', error: 'ошибка' };
const CTX_COLORS = ['#d9a94c', '#7fa3d1', '#6fb98a', '#c98f6f', '#9a8fd1', '#cf7fa3', '#5f8fb0', '#33343a'];
const modelName = (prov, id) => {
  const list = S.models?.[prov]?.items ?? [];
  if (!id) return list[0]?.name ?? 'По умолчанию';
  return list.find(m => m.id === id)?.name ?? id;
};
const permName = id => (S.models?.permissions ?? []).find(p => p.id === id)?.name ?? id;

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/login'; throw new Error('Нужен вход.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Ошибка ${r.status}`);
  return d;
}

const ICONS = {
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  ok: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
  x: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  tw: '<svg class="tw" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  more: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
  un: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v8a2 2 0 002 2h12a2 2 0 002-2v-8M3 6h18v4H3zM10 14h4"/></svg>',
  pin: '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2l8 8-4 1-3 3 1 5-3 1-3-5-5 5-1-1 5-5-5-3 1-3 5 1 3-3z"/></svg>',
};
function toast(text, kind = 'warn', ms = 6000) {
  const t = el('div', 'toast ' + kind);
  t.innerHTML = `<span class="ic">${ICONS[kind === 'ok' ? 'ok' : 'warn']}</span><span class="tx">${esc(text)}</span><button class="x" aria-label="Закрыть">${ICONS.x}</button>`;
  t.querySelector('.x').onclick = () => t.remove();
  $('#toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}
async function copyText(text, button) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area = el('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(area);
      area.select(); area.setSelectionRange(0, area.value.length);
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('copy');
    }
    button.dataset.label ??= button.getAttribute('aria-label') || '';
    button.innerHTML = ICONS.ok;
    button.setAttribute('aria-label', 'Скопировано');
    button.classList.add('copied');
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      button.innerHTML = ICONS.copy;
      button.setAttribute('aria-label', button.dataset.label);
      button.classList.remove('copied');
    }, 1600);
  } catch { toast('Не удалось скопировать.', 'err'); }
}
document.addEventListener('click', e => {
  const button = e.target.closest('.copy-code');
  if (button) copyText(button.closest('pre').querySelector('code').textContent, button);
});

const SLOT = '␟';
function md(src) {
  const code = [];
  let s = String(src ?? '').replace(/\r\n/g, '\n');
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, b) =>
    `${SLOT}B${code.push(`<pre><button type="button" class="copy-btn copy-code" aria-label="Скопировать команду" title="Скопировать команду">${ICONS.copy}</button><code>${esc(b.replace(/\n$/, ''))}</code></pre>`) - 1}${SLOT}`);
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `${SLOT}I${code.push(`<code>${c}</code>`) - 1}${SLOT}`);

  const out = [];
  let list = null, quote = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  const lines = s.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (new RegExp(`^${SLOT}B\\d+${SLOT}$`).test(L.trim())) { closeList(); closeQuote(); out.push(L.trim()); continue; }
    if (!L.trim()) { closeList(); closeQuote(); continue; }

    if (L.includes('|') && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1] || '')) {
      closeList(); closeQuote();
      const cells = r => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const head = cells(L); i++;
      let body = '';
      while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim())
        body += '<tr>' + cells(lines[++i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    const q = L.match(/^&gt;\s?(.*)$/);
    if (q) { closeList(); if (!quote) { out.push('<blockquote>'); quote = true; } out.push(`<p>${inline(q[1])}</p>`); continue; }
    closeQuote();
    const hd = L.match(/^(#{1,3})\s+(.*)$/);
    if (hd) { closeList(); out.push(`<h${hd[1].length}>${inline(hd[2])}</h${hd[1].length}>`); continue; }
    const ul = L.match(/^\s*[-*+]\s+(.*)$/), ol = L.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(L)}</p>`);
  }
  closeList(); closeQuote();
  return out.join('').replace(new RegExp(`${SLOT}[BI](\\d+)${SLOT}`, 'g'), (_, n) => code[+n]);
}
function inline(t) {
  return String(t)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

const ago = ts => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'сейчас';
  if (d < 3600) return `${Math.floor(d / 60)} мин`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч`;
  if (d < 172800) return 'вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const hhmm = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const plural = (n, [a, b, c]) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? b : c}`;
};
const kt = n => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n ?? 0));
const projectOf = id => S.projects.find(p => p.id === id);
const chatOf = id => S.chats.find(c => c.id === id);
const curChat = () => chatOf(S.cid);
const curProject = () => projectOf(S.pid);
const chatsOf = pid => {
  const seen = new Set();
  return S.chats.filter(c => c.project_id === pid && !seen.has(c.id) && seen.add(c.id));
};
const isRunning = id => S.running.includes(id) || chatOf(id)?.state === 'running';
function upsertChat(c) {
  if (!c?.id) return null;
  const i = S.chats.findIndex(x => x.id === c.id);
  if (i >= 0) { S.chats[i] = { ...S.chats[i], ...c }; return S.chats[i]; }
  S.chats.unshift(c); return c;
}

function badgeOf(p) {
  const cs = chatsOf(p.id).filter(c => !c.archived);
  if (cs.some(c => c.state === 'attention')) return 'attention';
  if (cs.some(c => isRunning(c.id))) return 'running';
  if (cs.some(c => c.unread)) return 'done';
  return '';
}
function renderRail() {
  const live = S.projects.filter(p => !p.archived);
  $('#rail').innerHTML = live.map(p => {
    const b = badgeOf(p);
    return `<button class="pbtn" data-p="${p.id}" title="${esc(p.name)} — ${esc(p.short)}" aria-current="${p.id === S.pid}">
      ${esc(p.glyph)}${b ? `<span class="d ${b}"></span>` : ''}</button>`;
  }).join('');
}

function chatRow(c) {
  const meta = [STATE_RU[c.state] || c.state, ago(c.updated_at)];
  return `<div class="crow" role="button" tabindex="0" data-c="${c.id}" data-state="${c.state}" data-unread="${c.unread ? 1 : 0}" aria-current="${c.id === S.cid}">
    <span class="ln"></span>
    <span class="col"><span class="t">${esc(c.title)}</span>
      <span class="s">${meta[0]}<span class="dot"></span>${meta[1]}${c.provider && c.provider !== 'claude' ? `<span class="cx" title="${esc(agName(c.provider))}">${agIcon(c.provider)}</span>` : ''}</span></span>
    ${c.pinned ? `<span class="pin">${ICONS.pin}</span>` : ''}
    ${stateBadge(c)}
    <button class="more" data-menu="${c.id}" aria-label="Действия с чатом">${ICONS.more}</button></div>`;
}
function stateBadge(c) {
  if (c.state === 'attention') return '<span class="st" title="Ждёт твоего ответа"><span class="ask">?</span></span>';
  if (isRunning(c.id)) return '<span class="st" title="Работает"><span class="run"><i></i><i></i><i></i></span></span>';
  if (c.unread) return '<span class="st" title="Закончил, ты ещё не смотрел"><span class="ok">✓</span></span>';
  return '';
}
function chatListHTML(pid, withArchive) {
  const all = chatsOf(pid);
  const act = all.filter(c => !c.archived);
  const now = act.filter(c => c.state === 'running' || c.state === 'attention' || isRunning(c.id));
  const rest = act.filter(c => !now.includes(c)).sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at);
  const arc = all.filter(c => c.archived).sort((a, b) => b.updated_at - a.updated_at);
  let h = '';
  if (now.length) h += `<div class="gh"><b>Сейчас</b><span class="n">${now.length}</span></div>` + now.map(chatRow).join('');
  if (rest.length) h += `<div class="gh"><b>${now.length ? 'Недавние' : 'Чаты'}</b><span class="n">${rest.length}</span></div>` + rest.map(chatRow).join('');
  if (!act.length) h += `<div class="empty">Здесь пока нет чатов. Нажми «Новый чат».</div>`;
  if (withArchive && arc.length) {
    const show = arc.slice(0, 12);
    h += `<div class="arch">
      <button class="ahead" id="ahead" aria-expanded="${S.archOpen}">${ICONS.tw}<b>Архив</b><span class="n">${arc.length}</span></button>
      <div class="alist" ${S.archOpen ? '' : 'hidden'}>${show.map(c => `
        <div class="arow" role="button" tabindex="0" data-c="${c.id}"><span class="t">${esc(c.title)}</span>
          <span class="w">${ago(c.updated_at)}</span>
          <button class="un" data-unarch="${c.id}" title="Вернуть в активные">${ICONS.un}</button></div>`).join('')}
      </div></div>`;
  }
  return h;
}
function renderSide() {
  const p = curProject();
  $('#pname').textContent = p ? p.name : '—';
  $('#ppath').textContent = p ? p.short : '';
  $('#clist').innerHTML = p ? chatListHTML(p.id, true) : '<div class="empty">Создай проект — это папка на сервере.</div>';
  $('#btn-newchat').hidden = !p;
  $('#btn-pmenu').hidden = !p;
  $('#uname').textContent = S.user?.login ?? '—';
  $('#uav').textContent = (S.user?.login ?? '?')[0];
  $('#umeta').textContent = S.host?.name ?? '';
}

const AG = { claude: ['Claude', '#d97757'], codex: ['Codex', '#f2f2f3'], kimi: ['Kimi', '#b7b1ff'], gemini: ['Gemini', '#8e75b2'] };
const compWho = () => S.models?.companion?.who ?? 'codex';
const agName = p => p === 'companion' ? `Собеседник · ${(AG[compWho()] ?? AG.codex)[0]}` : (AG[p] ?? AG.claude)[0];
const agIcon = p => {
  const id = p === 'companion' ? compWho() : p;
  return `<i class="pico" style="--src:url(/icons/providers/${AG[id] ? id : 'claude'}.svg);color:${(AG[id] ?? AG.claude)[1]}"></i>`;
};
const showTools = () => (S.prefs?.tools ?? '0') === '1';
const applyFeedPrefs = () => document.body.classList.toggle('notools', !showTools());
function msgNode(m, chat, scope) {
  if (m.role === 'user') {
    const atts = m.json?.attachments ?? [];
    const att = atts.length ? `<div class="att">${atts.map(a => a.image && a.url
      ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name)}"></a>`
      : `<span class="f">📎 ${esc(a.name)}</span>`).join('')}</div>` : '';
    return el('div', 'turn u', `<div class="who"><span class="av">${esc((S.user?.login ?? 'H')[0].toUpperCase())}</span><b>${esc(S.user?.login ?? 'ты')}</b><span class="t">${hhmm(m.ts)}</span></div><div class="md">${esc(m.text)}${att}</div>`);
  }
  if (m.role === 'assistant' && m.kind === 'text') {
    const prov = m.provider ?? (chat ?? curChat())?.provider ?? 'claude';
    const n = el('div', `turn a ${prov}`, `<div class="who"><span class="av">${agIcon(prov)}</span><b>${agName(prov)}</b><span class="t">${hhmm(m.ts)}</span><button type="button" class="copy-btn copy-answer" aria-label="Скопировать ответ" title="Скопировать ответ">${ICONS.copy}</button></div><div class="md">${md(m.text)}</div>`);
    n.querySelector('.copy-answer').onclick = e => copyText(m.text, e.currentTarget);
    return n;
  }
  if (m.role === 'assistant' && m.kind === 'thinking') {
    const n = el('div', 'think');
    n.innerHTML = `<button class="hd">${ICONS.tw}Размышление · ${plural(Math.round((m.text || '').length / 5), ['слово', 'слова', 'слов'])}</button><div class="body" hidden>${esc(m.text)}</div>`;
    n.querySelector('.hd').onclick = e => {
      const b = n.querySelector('.body'); b.hidden = !b.hidden;
      e.currentTarget.querySelector('.tw').style.transform = b.hidden ? '' : 'rotate(90deg)';
    };
    return n;
  }
  if (m.role === 'tool' && m.kind === 'tool_use') {
    const [name, ...rest] = (m.text || '').split('  ');
    const n = el('div', 'act');
    n.dataset.tool = m.json?.id || '';
    n.innerHTML = `<button class="hd"><span class="n">${esc(name)}</span><span class="a">${esc(rest.join('  '))}</span><span class="m"></span><span class="ok spin-slot"><span class="spin"></span></span></button><div class="body" hidden></div>`;
    n.querySelector('.hd').onclick = () => {
      const b = n.querySelector('.body');
      if (!b.dataset.filled) { b.innerHTML = `<pre>${esc(JSON.stringify(m.json?.input ?? {}, null, 2))}${b.dataset.result ? '\n\n— результат —\n' + b.dataset.result : ''}</pre>`; b.dataset.filled = '1'; }
      b.hidden = !b.hidden;
    };
    return n;
  }
  if (m.role === 'tool' && m.kind === 'tool_result') {
    const host = (scope ?? $('#fw')).querySelector(`.act[data-tool="${CSS.escape(m.json?.tool_use_id || '')}"]`);
    if (host) {
      const bad = m.json?.is_error;
      host.querySelector('.ok').className = 'ok' + (bad ? ' bad' : '');
      host.querySelector('.ok').textContent = bad ? '!' : '✓';
      const lines = (m.text || '').split('\n').length;
      host.querySelector('.m').textContent = m.text ? `${lines} стр.` : '';
      const b = host.querySelector('.body');
      b.dataset.result = m.text || ''; b.dataset.filled = '';
      return null;
    }
    return el('div', 'notice', `<span class="ic">${ICONS.warn}</span><span>${esc((m.text || '').slice(0, 400))}</span>`);
  }
  if (m.role === 'handoff') {
    const n = el('div', 'notice');
    n.style.boxShadow = 'inset 0 0 0 1px rgba(127,163,209,.3)';
    n.innerHTML = `<span class="ic" style="color:var(--info)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg></span><span>${esc(m.text)}</span>`;
    if (m.json?.files?.length) {
      const b = el('button', 'act-btn', `${m.json.files.length} файлов`);
      b.onclick = () => toast(m.json.files.join('\n'), 'ok', 12000);
      n.append(b);
    }
    return n;
  }
  if (m.role === 'error' || (m.role === 'system' && (m.kind === 'notice' || m.kind === 'denied'))) {
    const bad = m.role === 'error' || m.kind === 'denied';
    const n = el('div', 'notice' + (bad ? ' err' : ''));
    n.innerHTML = `<span class="ic">${ICONS.warn}</span><span>${esc(m.text)}</span>`;
    if (/Продолжить/.test(m.text || '')) {
      const b = el('button', 'act-btn', 'Продолжить');
      b.onclick = () => send('продолжай');
      n.append(b);
    }
    return n;
  }
  return null;
}

function renderFeed() {
  const fw = $('#fw');
  fw.innerHTML = '';
  for (const m of S.messages) { const n = msgNode(m, curChat(), fw); if (n) fw.append(n); }
  S.live = null;
  if (isRunning(S.cid)) ensureLive();
  for (const a of S.approvals) if (a.chat_id === S.cid) showApproval(a);
  scrollFeed(true);
}
function appendMessage(m) {
  S.messages.push(m);
  const atBottom = nearBottom();
  if (m.role === 'assistant' && m.kind === 'text' && S.live) { S.live.remove(); S.live = null; }
  const n = msgNode(m, curChat(), $('#fw'));
  if (n) $('#fw').append(n);
  if (isRunning(S.cid) && !S.live) ensureLive();
  else if (S.live) $('#fw').append(S.live);
  if (atBottom) scrollFeed();
}
function ensureLive() {
  if (S.live) return S.live;
  const prov = curChat()?.provider ?? 'claude';
  S.live = el('div', 'turn a', `<div class="who"><span class="av">${agIcon(prov)}</span><b>${agName(prov)}</b></div><div class="md live-md"><span class="typing"><i></i><i></i><i></i></span></div>`);
  S.live.dataset.buf = '';
  $('#fw').append(S.live);
  return S.live;
}
function onDelta(d) {
  if (d.chat_id !== S.cid) return;
  const node = ensureLive();
  if (d.text) {
    node.dataset.buf += d.text;
    node.querySelector('.live-md').innerHTML = md(node.dataset.buf) + '<span class="typing"><i></i><i></i><i></i></span>';
    if (nearBottom()) scrollFeed();
  }
}
const nearBottom = () => { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 140; };
const scrollFeed = instant => { const f = $('#feed'); f.scrollTo({ top: f.scrollHeight, behavior: instant ? 'auto' : 'smooth' }); };

function showApproval(a) {
  if (document.querySelector(`.appr[data-id="${CSS.escape(a.id)}"]`)) return;
  const n = el('div', 'appr');
  n.dataset.id = a.id;
  const inp = a.input ?? {};
  const main = inp.command || inp.file_path || inp.path || inp.pattern || inp.url || '';
  n.innerHTML = `<div class="ah"><span class="ai">?</span><b>Claude просит разрешение</b><span class="at">${esc(a.tool_name)}</span></div>
    <pre class="ab">${esc(main || JSON.stringify(inp, null, 2)).slice(0, 1200)}</pre>
    <div class="ar"><button class="btn" data-no>Отклонить</button><button class="btn primary" data-yes>Разрешить</button></div>`;
  const send = allow => api(`/api/approvals/${a.id}/decide`, { method: 'POST', body: { allow } }).catch(e => toast(e.message));
  n.querySelector('[data-yes]').onclick = () => send(true);
  n.querySelector('[data-no]').onclick = () => send(false);
  $('#fw').append(n); scrollFeed();
}
async function refetchTail() {
  if (!S.cid) return;
  const last = S.messages.length ? S.messages[S.messages.length - 1].id : 0;
  try {
    const d = await api(`/api/chats/${S.cid}/messages?after=${last}`);
    for (const m of d.messages) appendMessage(m);
    const i = S.chats.findIndex(c => c.id === S.cid); if (i >= 0) S.chats[i] = d.chat;
    renderAll();
  } catch { }
}

const draft = () => {
  const preferred = S.prefs?.provider || 'claude';
  return S.draft ??= {
    provider: agents().includes(preferred) ? preferred : (agents()[0] ?? preferred),
    model: S.prefs?.model || '',
    permission_mode: S.prefs?.permission_mode || 'manual',
    effort: S.prefs?.effort || '',
  };
};
const resetDraft = () => { S.draft = null; };
const settingsOf = () => curChat() ?? draft();
const setSettings = patch => {
  const c = curChat();
  if (c) return patchChat(c.id, patch);
  Object.assign(draft(), patch); renderHead();
};
const curProvider = () => settingsOf().provider ?? 'claude';
const metersOf = p => S.meters?.[p ?? curProvider()] ?? null;
const lvl = p => (p > 80 ? 'e' : p > 45 ? 'w' : '');
function ctxText(c) {
  if (c?.ctx_over) return 'Старое суммарное значение хода скрыто: оно не является заполнением контекстного окна.';
  if (!c?.ctx_used) return null;
  if (!c.ctx_window) return `Контекст чата: ${kt(c.ctx_used)} токенов. Размер окна станет известен после первого хода через Depo.`;
  return `Контекст чата: занято ${kt(c.ctx_used)} из ${kt(c.ctx_window)}, свободно ${kt(c.ctx_window - c.ctx_used)}`
    + (c.ctx_exact ? '' : ' (окно — по прошлым ходам этой модели)');
}
function ctxBar(c) {
  const t = ctxText(c); if (!t) return '';
  if (c?.ctx_over) return `<span class="sep"></span><span class="g" title="${esc(t)}"><span class="k">ctx</span><b>—</b></span>`;
  const body = c.ctx_window
    ? `<span class="lb"><i class="${lvl(c.ctx_pct)}" style="--p:${Math.min(c.ctx_pct, 100)}%"></i></span><b>${c.ctx_pct}%</b>`
    : `<b>${kt(c.ctx_used)}</b>`;
  return `<span class="sep"></span><span class="g" title="${esc(t)}"><span class="k">ctx</span>${body}</span>`;
}
function renderLimits() {
  const chip = $('#chip-gauge'), c = curChat();
  const m = metersOf();
  const lim = m?.limits ?? [];
  if (!lim.length && !c) { chip.hidden = true; return; }
  chip.hidden = false;
  const short = l => /5 ч|Сесси/.test(l.label) ? '5ч' : /Месяц/.test(l.label) ? 'мес' : 'нед';
  const bar = l => `<span class="g" title="${esc(l.label)} · сброс ${esc(l.resets)}"><span class="k">${short(l)}</span><span class="lb"><i class="${lvl(l.pct)}" style="--p:${Math.min(l.pct, 100)}%"></i></span><b>${l.pct}%</b></span>`;
  const five = lim.find(l => /5 ч|Сесси/.test(l.label));
  const week = lim.find(l => /все модели/.test(l.label)) ?? lim.find(l => /Недел/.test(l.label));
  const month = lim.find(l => /Месяц/.test(l.label));
  chip.innerHTML = (five ? bar(five) : '') + (week ? bar(week) : '') + (month ? bar(month) : '') + ctxBar(c);
  chip.title = `Показатели ${agName(curProvider())} · ${modelName(curProvider(), settingsOf().model)}`;
}
const agents = () => ['claude', 'codex', 'kimi'].filter(p => S.models?.ready?.[p]);
function applyModels(models) {
  S.models = models;
  if (!curChat() && S.draft && !agents().includes(S.draft.provider)) {
    const fallback = agents()[0];
    if (fallback) Object.assign(S.draft, { provider: fallback, model: '', effort: '' });
  }
  composerBar();
}
const refreshModels = async () => applyModels(await api('/api/models'));
function renderAgentRail() {
  const btn = $('#btn-agent'), s2 = settingsOf();
  if (!btn) return;
  btn.innerHTML = `${agIcon(s2.provider)}<span>${esc(agName(s2.provider))}</span>`;
  btn.title = `Агент: ${agName(s2.provider)}`;
}
function composerBar() {
  const s2 = settingsOf();
  renderAgentRail();
  const cbtn = $('#btn-gemini');
  cbtn.hidden = !S.models?.ready?.companion;
  cbtn.title = `Спросить собеседника (${agName('companion')})`;
  cbtn.innerHTML = agIcon('companion');
  $('#btn-model').textContent = modelName(s2.provider, s2.model);
  $('#btn-perm').textContent = permName(s2.permission_mode);
  const list = effortsFor(s2.provider, s2.model);
  $('#btn-effort').hidden = !list.length;
  const def = defaultEffortName(s2.provider, s2.model);
  $('#btn-effort').textContent = s2.effort
    ? (list.find(e => e.id === s2.effort)?.name ?? s2.effort)
    : (def ? `${def} ·` : 'скорость');
  $('#btn-effort').classList.toggle('dim', !s2.effort);
  ctxDot();
}
function ctxDot() {
  const dot = $('#btn-ctxdot'), c = curChat();
  const used = c?.ctx_used ?? 0, win = c?.ctx_window ?? 0;
  if (!c || !used) { dot.hidden = true; return; }
  dot.hidden = false;
  const pct = win ? Math.min(999, Math.round(used / win * 100)) : 0;
  dot.className = 'ctxdot' + (win ? (pct > 80 ? ' e' : pct > 50 ? ' w' : '') : ' idle');
  dot.querySelector('.ring').style.setProperty('--v', win ? Math.min(pct, 100) : 0);
  dot.querySelector('.pc').textContent = win ? `${pct}%` : kt(used);
  dot.title = ctxText(c) ?? '';
}
$('#btn-ctxdot').onclick = e => { e.stopPropagation(); togglePop($('#chip-gauge')); };
const modelEntry = (prov, id) => (S.models?.[prov]?.items ?? []).find(m => m.id === (id || ''));
const effortsFor = (prov, id) => modelEntry(prov, id)?.efforts ?? S.models?.[prov]?.items?.[0]?.efforts ?? [];
function defaultEffortName(prov, id) {
  const def = modelEntry(prov, id)?.effort;
  if (!def) return null;
  return effortsFor(prov, id).find(e => e.id === def)?.name ?? def;
}
function renderHead() {
  renderLimits();
  composerBar();
  const c = curChat(), p = curProject();
  const has = !!c;
  $('#feed').hidden = !has; $('#cmp').hidden = !p; $('#blank').hidden = has;
  $('#chip-state').hidden = !has;
  $('#chip-files').hidden = !p; $('#chip-split').hidden = !p;

  if (!p) {
    $('#ctitle').textContent = 'Depo';
    $('#csub').textContent = '';
    $('#blank-title').textContent = 'Создай проект';
    $('#blank-text').textContent = 'Проект — это настоящая папка на сервере. Внутри проекта заводятся чаты.';
    const b = $('#blank-btn'); b.hidden = false; b.textContent = 'Новый проект'; b.onclick = newProjectDialog;
    return;
  }
  if (!has) {
    $('#ctitle').textContent = p.name;
    $('#csub').textContent = p.short;
    $('#cb').classList.remove('run');
    $('#blank-title').textContent = p.name;
    $('#blank-text').textContent = `${p.short} · ${plural(chatsOf(p.id).filter(x => !x.archived).length, ['активный чат', 'активных чата', 'активных чатов'])}. Напиши задачу внизу — заведу новый чат.`;
    $('#blank-btn').hidden = true;
    return;
  }
  const run = isRunning(c.id);
  $('#ctitle').textContent = c.title;
  $('#csub').textContent = `${p.short} · ${plural(c.turns, ['ход', 'хода', 'ходов'])}${c.cost_usd ? ' · $' + c.cost_usd.toFixed(3) : ''}`;
  const st = $('#chip-state');
  st.className = 'chip' + (run ? ' live' : c.state === 'attention' ? ' warn' : '');
  $('#state-text').textContent = run ? 'работает' : STATE_RU[c.state] || c.state;
  $('#cb').classList.toggle('run', run);
  $('#csub').textContent += c.origin === 'claude' ? ' · из Claude Code' : '';
  const snd = $('#btn-send');
  snd.classList.toggle('stop', run);
  snd.setAttribute('aria-label', run ? 'Остановить' : 'Отправить');
  snd.innerHTML = run
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $('#inp').placeholder = run ? 'Дополнить запрос на ходу…' : 'Что сделать в этом проекте?';

}
function renderAll() { renderRail(); renderSide(); renderHead(); }

async function selectProject(id, { keepChat = false } = {}) {
  S.pid = id; closeFly();
  if (!keepChat) {
    const cs = chatsOf(id).filter(c => !c.archived).sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at);
    await selectChat(cs[0]?.id ?? null);
  }
  renderAll();
  save();
}
async function selectChat(id) {
  S.cid = id; S.live = null; S.messages = []; if (id) resetDraft();
  renderAll();
  if (!id) return;
  try {
    const d = await api(`/api/chats/${id}/messages`);
    if (S.cid !== id) return;
    S.messages = d.messages;
    upsertChat({ ...d.chat, unread: false });
    if (d.running && !S.running.includes(id)) S.running.push(id);
    S.pid = d.chat.project_id;
    renderAll(); renderFeed();
    loadChatContext(id);
  } catch (e) { toast(e.message); }
  save();
}
const save = () => { try { localStorage.setItem('depo.sel', JSON.stringify({ pid: S.pid, cid: S.cid })); } catch { } };

async function send(forced) {
  const inp = $('#inp');
  const text = (forced ?? inp.value).trim();
  const p = curProject();
  if (!p) return;
  if (!agents().includes(curProvider())) return toast(`${agName(curProvider())} не подключён. Войди в настройках или выбери другого агента.`, 'err', 7000);
  if (!text && !S.atts.length) { inp.focus(); return; }

  let cid = S.cid;
  if (!cid) {
    try {
      const d = await api('/api/chats', { method: 'POST', body: { project_id: p.id, ...draft() } });
      upsertChat(d.chat); cid = d.chat.id; S.cid = cid; S.messages = []; resetDraft();
      renderAll(); renderFeed();
    } catch (e) { return toast(e.message); }
  }
  if (!forced) inp.value = '', autosize();
  const ready = S.atts.filter(a => a.done).map(a => a.meta);
  if (S.atts.some(a => !a.done)) return toast('Подожди, вложения ещё грузятся.');
  S.atts = []; renderAtts();
  try {
    await api(`/api/chats/${cid}/send`, { method: 'POST', body: { text, attachments: ready } });
    if (!S.running.includes(cid)) S.running.push(cid);
    renderHead(); renderSide();
  } catch (e) { toast(e.message); }
}
async function stop() {
  if (!S.cid) return;
  try { await api(`/api/chats/${S.cid}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message); }
}
function autosize() {
  const t = $('#inp');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 260) + 'px';
}

function connect() {
  const es = new EventSource('/api/stream');
  const onOpen = () => { setOffline(false); };
  es.addEventListener('open', onOpen);
  es.addEventListener('error', () => { setOffline(true); });

  es.addEventListener('message', e => {
    const d = JSON.parse(e.data);
    if (d.chat_id === S.cid) appendMessage(d.message);
    if (P2.on && d.chat_id === P2.cid) { P2.messages.push(d.message); renderSecond(); }
    touchChat(d.chat_id);
  });
  es.addEventListener('delta', e => onDelta(JSON.parse(e.data)));
  es.addEventListener('run', e => {
    const d = JSON.parse(e.data);
    if (d.status === 'running') { if (!S.running.includes(d.chat_id)) S.running.push(d.chat_id); }
    else {
      S.running = S.running.filter(x => x !== d.chat_id);
      const c = chatOf(d.chat_id);
      if (c) Object.assign(c, {
        unread: d.chat_id === S.cid && document.visibilityState === 'visible' ? false : !!d.unread,
        turns: d.turns ?? c.turns, cost_usd: d.total_cost ?? c.cost_usd,
        ctx_used: d.ctx_used || c.ctx_used, ctx_window: d.ctx_window || c.ctx_window,
        ctx_pct: (d.ctx_window || c.ctx_window) ? Math.min(100, Math.round((d.ctx_used || c.ctx_used) / (d.ctx_window || c.ctx_window) * 100)) : c.ctx_pct,
        ctx_over: false,
      });
      if (d.chat_id === S.cid && S.live) { S.live.remove(); S.live = null; }
      if (S.ctx) delete S.ctx[d.chat_id];
      if (d.chat_id === S.cid) loadChatContext(d.chat_id, { force: true });
      if (P2.on && d.chat_id === P2.cid) renderSecond();
      if (d.chat_id !== S.cid && d.status === 'done') notifyDone(d.chat_id);
    }
    renderAll();
  });
  es.addEventListener('chat', e => {
    const d = JSON.parse(e.data);
    if (d.chat) upsertChat(d.chat);
    else if (d.patch) {
      const i = S.chats.findIndex(c => c.id === (d.chat_id ?? d.id));
      if (i >= 0) Object.assign(S.chats[i], d.patch);
    }
    renderAll();
  });
  es.addEventListener('chat-removed', e => {
    const { id } = JSON.parse(e.data);
    S.chats = S.chats.filter(c => c.id !== id);
    if (S.cid === id) selectChat(chatsOf(S.pid).filter(c => !c.archived)[0]?.id ?? null);
    else renderAll();
  });
  es.addEventListener('project', e => {
    const { project } = JSON.parse(e.data);
    const i = S.projects.findIndex(p => p.id === project.id);
    if (i >= 0) S.projects[i] = project; else S.projects.push(project);
    renderAll();
  });
  es.addEventListener('project-removed', e => {
    const { id } = JSON.parse(e.data);
    S.projects = S.projects.filter(p => p.id !== id);
    S.chats = S.chats.filter(c => c.project_id !== id);
    if (S.pid === id) selectProject(S.projects.filter(p => !p.archived)[0]?.id ?? null);
    else renderAll();
  });
  es.addEventListener('meters', e => { S.meters = { ...S.meters, ...JSON.parse(e.data) }; renderLimits(); if (!$('#pop-ctx').hidden) renderCtxPop(); });
  es.addEventListener('approval', e => { const a = JSON.parse(e.data); S.approvals.push(a); if (a.chat_id === S.cid) showApproval(a); renderAll();
    sysNotify('Depo · нужен ответ', `${chatOf(a.chat_id)?.title ?? ''}: разрешить ${a.tool_name}?`, a.chat_id); });
  es.addEventListener('approval-decided', e => { const d = JSON.parse(e.data); S.approvals = S.approvals.filter(a => a.id !== d.id); document.querySelector(`.appr[data-id="${CSS.escape(d.id)}"]`)?.remove(); });
  es.addEventListener('reload', () => api('/api/state').then(d => { S.chats = d.chats; S.projects = d.projects; renderAll(); }).catch(() => { }));
  es.addEventListener('prefs', e => { S.prefs = JSON.parse(e.data).prefs; applyFeedPrefs(); });
  es.addEventListener('models', e => applyModels(JSON.parse(e.data)));
  es.addEventListener('link', e => linkPaint(JSON.parse(e.data)));
  es.addEventListener('chat-appended', e => { const d = JSON.parse(e.data); if (d.chat_id === S.cid) refetchTail(); if (P2.on && d.chat_id === P2.cid) loadSecond(P2.cid); });
  return es;
}
function touchChat(id) { const c = chatOf(id); if (c) { c.updated_at = Date.now(); renderSide(); } }
function setOffline(off) {
  S.connected = !off;
  let bar = $('#offline');
  if (off && !bar) {
    bar = el('div', 'offline'); bar.id = 'offline';
    bar.innerHTML = '<span class="spin"></span>Связь с сервером потеряна, переподключаюсь…';
    document.body.append(bar);
  } else if (!off && bar) bar.remove();
}
function sysNotify(title, body, chatId) {
  if (localStorage.getItem('depo.notif') !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && chatId === S.cid) return;
  try { const n = new Notification(title, { body, icon: '/icons/icon-180.png', tag: chatId, data: { chat: chatId } }); n.onclick = () => { focus(); selectChat(chatId); n.close(); }; } catch { }
}
function notifyDone(chatId) {
  const c = chatOf(chatId); if (!c) return;
  sysNotify('Depo · ход закончен', c.title, chatId);
  const t = toast(`«${c.title}» — ход закончен`, 'ok', 8000);
  t.querySelector('.tx').style.cursor = 'pointer';
  t.querySelector('.tx').onclick = () => { selectChat(chatId); t.remove(); };
}

function renderCtxPop() {
  const pop = $('#pop-ctx'), c = curChat(), prov = curProvider();
  const m = metersOf(prov), lim = m?.limits ?? [];
  const name = agName(prov), model = modelName(prov, settingsOf().model);
  const det = c ? S.ctx?.[c.id] : null;
  const used = det?.used ?? c?.ctx_used ?? 0;
  const win = det?.window ?? c?.ctx_window ?? 0;
  const pct = win ? Math.min(999, Math.round(used / win * 100)) : 0;
  let h = `<div class="ph"><b>${esc(name)} · ${esc(model)}</b><span class="v">${m?.at ? 'обновлено ' + hhmm(m.at) : '—'}</span></div>`;

  if (used) {
    h += `<div class="gl2">Контекст этого чата</div>`;
    if (win) {
      h += `<div class="lmr"><div class="lb">занято ${kt(used)} из ${kt(win)}<span class="p">${pct}%</span></div>
        <div class="g ${lvl(pct)}"><i style="width:${Math.min(pct, 100)}%"></i></div>
        <div class="rs">свободно ${kt(win - used)}${det?.untilCompact ? ` · до автосжатия ${kt(det.untilCompact)}` : ''}</div></div>`;
    } else {
      h += `<div class="lmr"><div class="lb">занято ${kt(used)}<span class="p">—</span></div>
        <div class="rs">размер окна станет известен после первого хода через Depo</div></div>`;
    }
    if (det?.rows?.length) {
      const tot = det.rows.reduce((s, r) => s + r.tokens, 0) || 1;
      h += `<div class="stk" style="margin-top:11px">${det.rows.map((r, i) => `<i style="width:${r.tokens / tot * 100}%;background:${CTX_COLORS[i % CTX_COLORS.length]}"></i>`).join('')}</div>
        <div class="rws">${det.rows.map((r, i) => `<div class="r"><span class="sw" style="background:${CTX_COLORS[i % CTX_COLORS.length]}"></span><span class="nm">${esc(r.label)}</span><span class="tk">${kt(r.tokens)}</span></div>`).join('')}</div>`;
    } else if (prov === 'claude' && c && !det) {
      h += `<div class="hint" id="ctx-load">смотрю, из чего он состоит…</div>`;
    }
  } else if (c && prov === 'claude') {
    h += `<div class="gl2">Контекст этого чата</div><div class="hint" id="ctx-load">считаю…</div>`;
  }

  if (lim.length) {
    h += `<div class="gl2">Лимиты подписки ${esc(name)} · ${esc(model)}</div>` + lim.map(l =>
      `<div class="lmr"><div class="lb">${esc(l.label)}<span class="p">${l.pct}%</span></div>
        <div class="g ${lvl(l.pct)}"><i style="width:${Math.min(l.pct, 100)}%"></i></div>
        <div class="rs">сброс ${esc(l.resets)}</div></div>`).join('');
  } else h += `<div class="gl2">Лимиты</div><div class="hint">${prov === 'codex' ? 'Codex ещё не отчитывался — появятся после первого хода.' : 'Снимаю данные…'}</div>`;

  h += `<div class="hint">${prov === 'codex' ? 'общие лимиты аккаунта · файлы сессий Codex' : prov === 'kimi' ? '/usage Kimi Code · общая квота аккаунта; Highspeed расходует её быстрее' : '/usage и /context стоят ноль токенов'}</div>`;
  pop.innerHTML = h;
}

async function loadChatContext(id, { force = false } = {}) {
  const c = chatOf(id);
  if (!c) return;
  if (!force && S.ctx?.[id]) return;
  try {
    const d = await api(`/api/chats/${id}/context`);
    (S.ctx ??= {})[id] = d;
    const i = S.chats.findIndex(x => x.id === id);
    if (i >= 0) Object.assign(S.chats[i], { ctx_used: d.used, ctx_window: d.window, ctx_pct: d.pct, ctx_exact: true });
    if (id === S.cid) { renderLimits(); if (!$('#pop-ctx').hidden) renderCtxPop(); }
  } catch { }
}

function closeMenus() { document.querySelectorAll('.menu').forEach(m => m.remove()); }
function menu(anchor, items) {
  closeMenus();
  const m = el('div', 'menu');
  for (const it of items) {
    if (it === '-') { m.append(el('div', 'sep')); continue; }
    if (it.label) { m.append(el('div', 'lbl', esc(it.label))); continue; }
    const b = el('button', (it.danger ? 'danger' : '') + (it.hint ? ' has-hint' : ''),
      `<span class="mi"><span class="mt1">${esc(it.text)}</span>${it.hint ? `<span class="mh">${esc(it.hint)}</span>` : ''}</span>${it.active ? '<span class="mk">✓</span>' : ''}`);
    b.onclick = () => { closeMenus(); it.run(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 10) + 'px';
  m.style.top = Math.min(r.bottom + 5, innerHeight - m.offsetHeight - 10) + 'px';
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }), 0);
}

function modal(html, { onOpen, wide } = {}) {
  const scrim = el('div', 'scrim' + (wide ? ' wide' : ''));
  scrim.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  onOpen?.(scrim.querySelector('.modal'), close);
  return close;
}
const confirmBox = (title, sub, okText, run, danger = true) => modal(
  `<h3>${esc(title)}</h3><p class="sub">${esc(sub)}</p>
   <div class="row"><button class="btn" data-no>Отмена</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button></div>`,
  {
    onOpen(m, close) {
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-yes]').onclick = () => { close(); run(); };
      m.querySelector('[data-yes]').focus();
    }
  });

function promptBox(title, sub, value, okText, run) {
  return modal(`<h3>${esc(title)}</h3>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
    <label><input type="text" id="pv" value="${esc(value)}"></label>
    <p class="err" id="pe"></p>
    <div class="row"><button class="btn" data-no>Отмена</button><button class="btn primary" data-yes>${esc(okText)}</button></div>`, {
    onOpen(m, close) {
      const inp = m.querySelector('#pv');
      inp.focus(); inp.select();
      const go = async () => {
        try { await run(inp.value.trim()); close(); }
        catch (e) { m.querySelector('#pe').textContent = e.message; }
      };
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-yes]').onclick = go;
      inp.onkeydown = e => { if (e.key === 'Enter') go(); };
    }
  });
}

async function newProjectDialog() {
  let sugg = [];
  try { sugg = (await api('/api/projects/suggest')).items; } catch { }
  modal(`<h3>Новый проект</h3><p class="sub">Проект — это папка на сервере. Напиши название — папка подставится сама в домашнем каталоге; если её нет, создам.</p>
    <label>Название<input type="text" id="np-name" placeholder="Demo Project"></label>
    <label>Папка<input type="text" id="np-path" placeholder="~/demo-project"></label>
    <label class="check"><input type="checkbox" id="np-create" checked> создать папку, если её нет</label>
    ${sugg.length ? `<div class="gl2" style="margin-top:4px">Папки рядом</div><div class="sugg">${sugg.map(s =>
    `<button data-p="${esc(s.path)}" data-n="${esc(s.name)}"><span class="nm">${esc(s.name)}</span><span class="pt">${esc(s.short)}</span><span class="mk">${esc(s.marks.join(' '))}</span></button>`).join('')}</div>` : ''}
    <p class="err" id="np-err"></p>
    <div class="row"><button class="btn" data-no>Отмена</button><button class="btn primary" data-yes>Подключить</button></div>`, {
    onOpen(m, close) {
      const name = m.querySelector('#np-name'), pth = m.querySelector('#np-path'), err = m.querySelector('#np-err');
      name.focus();
      let touched = false;
      pth.oninput = () => { touched = true; };
      const slug = v => v.toLowerCase().trim()
        .replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '')
        .replace(/[а-яё]/g, c => ({ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }[c] ?? c));
      name.oninput = () => { if (!touched) pth.value = name.value.trim() ? '~/' + slug(name.value) : ''; };
      m.querySelectorAll('.sugg button').forEach(b => b.onclick = () => {
        pth.value = b.dataset.p; touched = true; if (!name.value.trim()) name.value = b.dataset.n;
      });
      const go = async () => {
        err.textContent = '';
        try {
          const d = await api('/api/projects', {
            method: 'POST',
            body: { name: name.value.trim(), path: pth.value.trim(), create: m.querySelector('#np-create').checked },
          });
          close();
          await selectProject(d.project.id);
          toast(`Проект «${d.project.name}» подключён${d.created ? ', папка создана' : ''}`, 'ok', 4000);
        } catch (e) { err.textContent = e.message; }
      };
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-yes]').onclick = go;
      m.querySelectorAll('input[type=text]').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') go(); });
    }
  });
}

function chatMenu(anchor, c) {
  menu(anchor, [
    { text: c.pinned ? 'Открепить' : 'Закрепить', run: () => patchChat(c.id, { pinned: !c.pinned }) },
    { text: 'Переименовать', run: () => promptBox('Переименовать чат', '', c.title, 'Сохранить', v => v && patchChat(c.id, { title: v })) },
    { text: c.archived ? 'Вернуть из архива' : 'В архив', run: () => patchChat(c.id, { archived: !c.archived }) },
    '-',
    { text: 'Удалить чат', danger: true, run: () => confirmBox('Удалить чат?', `«${c.title}» и вся переписка исчезнут. Файлы проекта не трогаем.`, 'Удалить', () => api(`/api/chats/${c.id}`, { method: 'DELETE' }).catch(e => toast(e.message))) },
  ]);
}
const patchChat = (id, body) => api(`/api/chats/${id}`, { method: 'PATCH', body }).catch(e => toast(e.message));

async function sessionsDialog() {
  const p = curProject(); if (!p) return;
  const close = modal(`<div class="smodal"><h3>Поднять разговор из Claude Code</h3>
    <p class="sub">Сессии Claude Code в папке ${esc(p.short)} — из терминала, с ноутбука, из Remote Control.
      Поднятый разговор продолжается здесь с того же места: контекст и файлы на месте.</p>
    <div id="ss-list" class="sslist">читаю сессии…</div>
    <div class="row"><button class="btn" data-no>Закрыть</button></div></div>`, {
    onOpen(m, close) { m.querySelector('[data-no]').onclick = close; }
  });
  const box = document.querySelector('#ss-list');
  try {
    const d = await api(`/api/projects/${p.id}/sessions`);
    const items = d.items ?? [];
    if (!items.length) { box.textContent = 'Сессий Claude Code в этой папке нет.'; return; }
    box.innerHTML = items.map(s => `<div class="ssrow" data-s="${esc(s.id)}">
      <div class="c"><b>${esc(s.title || 'без названия')}</b>
        <span>${esc(ago(s.mtime))} назад${s.turns ? ' · ходов ' + s.turns : ''}${s.model ? ' · ' + esc(s.model) : ''}</span></div>
      ${s.imported
        ? `<button class="btn" data-open="${esc(s.id)}">${s.archived ? 'В архиве — открыть' : 'Уже здесь'}</button>`
        : `<button class="btn primary" data-up="${esc(s.id)}">Поднять</button>`}</div>`).join('');
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
      close();
      if (!chatOf(b.dataset.open)) await api('/api/state').then(st => { S.chats = st.chats; });
      selectChat(b.dataset.open);
    });
    box.querySelectorAll('[data-up]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Поднимаю…';
      try {
        await api(`/api/projects/${p.id}/sessions/${b.dataset.up}/import`, { method: 'POST' });
        const st = await api('/api/state'); S.chats = st.chats; S.projects = st.projects;
        close(); renderAll(); selectChat(b.dataset.up);
        toast('Разговор поднят — можно продолжать', 'ok', 4000);
      } catch (e) { toast(e.message, 'err'); b.disabled = false; b.textContent = 'Поднять'; }
    });
  } catch (e) { box.textContent = e.message; }
}

function projectMenu(anchor) {
  const p = curProject(); if (!p) return;
  menu(anchor, [
    { label: p.short },
    { text: 'Переименовать', run: () => promptBox('Переименовать проект', '', p.name, 'Сохранить', v => v && api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: v } })) },
    { text: 'Сменить значок', run: () => promptBox('Значок проекта', 'Одна-две буквы для рейки слева.', p.glyph, 'Сохранить', v => v && api(`/api/projects/${p.id}`, { method: 'PATCH', body: { glyph: v } })) },
    { text: 'Поднять разговор из Claude Code', hint: 'сессии из терминала и с ноутбука', run: sessionsDialog },
    { text: 'Сохранить копию чатов в папку проекта', hint: 'папка .depo рядом с кодом', run: () => api(`/api/projects/${p.id}/snapshot`, { method: 'POST' }).then(d => toast(d.error ? d.error : `Копия обновлена: файлов ${d.written ?? 0}`, d.error ? 'err' : 'ok', 4000)).catch(e => toast(e.message)) },
    { text: 'Новый проект', run: newProjectDialog },
    { text: 'В архив всё старше недели', hint: 'закреплённые и работающие не трогаю', run: () => api(`/api/projects/${p.id}/archive-old`, { method: 'POST', body: { days: 7 } }).then(d => toast(`В архив: ${d.archived}`, 'ok', 3000)).catch(e => toast(e.message)) },
    '-',
    {
      text: 'Отключить проект', danger: true, run: () => confirmBox('Отключить проект?',
        `«${p.name}» пропадёт из Depo вместе со своими чатами. Папка ${p.short} останется на диске нетронутой.`,
        'Отключить', () => api(`/api/projects/${p.id}`, { method: 'DELETE' }).catch(e => toast(e.message)))
    },
  ]);
}

function userMenu(anchor) {
  menu(anchor, [
    { label: S.host?.name ?? '' },
    { text: 'Настройки', run: settingsDialog },
    { text: 'Сменить пароль', run: passwordDialog },
    { text: 'Обновить показатели', run: () => api('/api/meters?force=1').then(d => { S.meters = { ...S.meters, [d.provider]: d }; renderLimits(); renderCtxPop(); toast('Показатели обновлены', 'ok', 2500); }).catch(e => toast(e.message)) },
    '-',
    { text: 'Выйти', run: () => api('/api/logout', { method: 'POST' }).then(() => location.href = '/login') },
  ]);
}
function passwordDialog() {
  modal(`<h3>Сменить пароль</h3><p class="sub">После смены придётся войти заново на всех устройствах.</p>
    <label>Текущий пароль<input type="password" id="p0"></label>
    <label>Новый пароль<input type="password" id="p1"></label>
    <p class="err" id="pe"></p>
    <div class="row"><button class="btn" data-no>Отмена</button><button class="btn primary" data-yes>Сменить</button></div>`, {
    onOpen(m, close) {
      m.querySelector('#p0').focus();
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-yes]').onclick = async () => {
        try {
          await api('/api/password', { method: 'POST', body: { current: m.querySelector('#p0').value, next: m.querySelector('#p1').value } });
          location.href = '/login';
        } catch (e) { m.querySelector('#pe').textContent = e.message; }
      };
    }
  });
}

const P2 = { cid: null, messages: [], on: false };
function splitOn(on) {
  P2.on = on;
  $('#pane2').hidden = !on;
  document.querySelector('.main').classList.toggle('split', on);
  $('#chip-split').setAttribute('aria-pressed', on);
  if (on) { renderSecond(); P2.cid ? loadSecond(P2.cid) : pickSecond(); }
}
function pickSecond() {
  const items = S.chats.filter(c => !c.archived && c.id !== S.cid)
    .sort((a, b) => b.updated_at - a.updated_at).slice(0, 14)
    .map(c => ({ text: `${projectOf(c.project_id)?.glyph ?? ''}  ${c.title.slice(0, 40)}`, run: () => loadSecond(c.id) }));
  if (!items.length) return toast('Других чатов пока нет.');
  menu($('#p2-pick'), [{ label: 'Показать рядом' }, ...items]);
}
async function loadSecond(id) {
  P2.cid = id;
  if (!id) return;
  try {
    const d = await api(`/api/chats/${id}/messages`);
    P2.messages = d.messages;
    renderSecond();
  } catch (e) { toast(e.message); }
}
function renderSecond() {
  const c = chatOf(P2.cid);
  $('#p2-pick').textContent = c ? c.title : 'выбрать чат';
  const run = c && isRunning(c.id);
  $('#p2-state').className = 'p2state' + (run ? ' run' : '');
  $('#p2-state').textContent = c ? (run ? 'работает' : STATE_RU[c.state] || '') : '';
  const box = $('#p2-feed');
  box.innerHTML = '';
  if (!c) { box.append(el('div', 'empty', 'Выбери чат сверху — будешь видеть его, пока работаешь в основном.')); return; }
  for (const m of P2.messages.slice(-40)) { const n = msgNode(m, c, box); if (n) box.append(n); }
  if (run) box.append(el('div', 'turn a', '<div class="md"><span class="typing"><i></i><i></i><i></i></span></div>'));
  box.scrollTop = box.scrollHeight;
}
$('#chip-split').onclick = () => splitOn(!P2.on);
$('#p2-close').onclick = () => splitOn(false);
$('#p2-pick').onclick = e => { e.stopPropagation(); pickSecond(); };
$('#p2-send').onclick = async () => {
  const t = $('#p2-inp'), text = t.value.trim();
  if (!text || !P2.cid) return;
  t.value = '';
  try { await api(`/api/chats/${P2.cid}/send`, { method: 'POST', body: { text } }); }
  catch (e) { toast(e.message); }
};
$('#p2-inp').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#p2-send').click(); } };

function renderAtts() {
  const box = $('#atts');
  box.hidden = !S.atts.length;
  box.innerHTML = S.atts.map((a, i) => `<span class="a ${a.done ? '' : 'up'}">${a.preview ? `<img src="${a.preview}" alt="">` : '📎'}<span class="n">${esc(a.file.name)}</span><button class="x" data-i="${i}" aria-label="Убрать">${ICONS.x}</button></span>`).join('');
  box.querySelectorAll('.x').forEach(b => b.onclick = () => { S.atts.splice(+b.dataset.i, 1); renderAtts(); });
}
async function addFiles(list) {
  const files = [...list].filter(f => f && f.size);
  if (!files.length) return;
  let cid = S.cid;
  if (!cid) {
    const p = curProject(); if (!p) return;
    try { const d = await api('/api/chats', { method: 'POST', body: { project_id: p.id, ...draft() } }); upsertChat(d.chat); S.cid = cid = d.chat.id; S.messages = []; resetDraft(); renderAll(); renderFeed(); }
    catch (e) { return toast(e.message); }
  }
  for (const file of files) {
    if (file.size > 32 * 1048576) { toast(`${file.name}: больше 32 МБ, не возьму.`); continue; }
    const a = { file, done: false, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    S.atts.push(a); renderAtts();
    try {
      const r = await fetch(`/api/chats/${cid}/attach`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name) }, body: file });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Не загрузилось.');
      a.meta = d; a.done = true;
    } catch (e) { toast(`${file.name}: ${e.message}`, 'err'); S.atts = S.atts.filter(x => x !== a); }
    renderAtts();
  }
  $('#inp').focus();
}
$('#btn-attach').onclick = () => $('#file-inp').click();
$('#file-inp').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

const PASTE_LIMIT = 6000;
$('#inp').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); return addFiles(files); }
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text.length > PASTE_LIMIT) {
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    addFiles([new File([text], `вставка-${stamp}.txt`, { type: 'text/plain' })]);
    toast(`Текст на ${text.length.toLocaleString('ru-RU')} символов приложил файлом`, 'ok', 4000);
  }
});
{
  const cb = $('#cb'); let depth = 0;
  cb.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { depth++; cb.classList.add('drop'); } });
  cb.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  cb.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; cb.classList.remove('drop'); } });
  cb.addEventListener('drop', e => { e.preventDefault(); depth = 0; cb.classList.remove('drop'); addFiles(e.dataTransfer.files); });
}

{
  const rail = $('#rail');
  let drag = null;
  const order = () => [...rail.querySelectorAll('.pbtn')].map(b => +b.dataset.p);
  rail.addEventListener('pointerdown', e => {
    const b = e.target.closest('.pbtn'); if (!b || e.button) return;
    const start = { x: e.clientX, y: e.clientY };
    const begin = () => {
      drag = { el: b, ghost: el('div', 'rail-ghost', b.textContent.trim()), from: order() };
      b.classList.add('drag'); document.body.append(drag.ghost); move(e);
      try { b.setPointerCapture(e.pointerId); } catch { }
    };
    const timer = e.pointerType === 'touch' ? setTimeout(() => { begin(); if (navigator.vibrate) navigator.vibrate(12); }, 320) : null;
    const move = ev => {
      if (!drag) {
        if (e.pointerType !== 'touch' && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) begin();
        else if (e.pointerType === 'touch' && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) clearTimeout(timer);
        return;
      }
      ev.preventDefault();
      drag.ghost.style.left = (ev.clientX - 18) + 'px'; drag.ghost.style.top = (ev.clientY - 18) + 'px';
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.pbtn');
      if (over && over !== drag.el) {
        const r = over.getBoundingClientRect();
        over.parentNode.insertBefore(drag.el, ev.clientY < r.top + r.height / 2 ? over : over.nextSibling);
      }
    };
    const up = async () => {
      clearTimeout(timer);
      b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up); b.removeEventListener('pointercancel', up);
      if (!drag) return;
      const was = drag.from, now = order();
      drag.ghost.remove(); drag.el.classList.remove('drag'); drag = null;
      if (now.join() === was.join()) return;
      S.projects.sort((a, c) => now.indexOf(a.id) - now.indexOf(c.id));
      S.projects.forEach((p, i) => p.position = i + 1);
      try { await api('/api/projects/reorder', { method: 'POST', body: { ids: now } }); } catch (e2) { toast(e2.message); }
      renderRail();
    };
    b.addEventListener('pointermove', move); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  });
  rail.addEventListener('click', e => { if (drag) e.stopImmediatePropagation(); }, true);
  rail.style.touchAction = 'pan-y';
}

const colorDiff = patch => esc(patch).split('\n').map(l =>
  l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? `<span class="hd2">${l}</span>`
    : l.startsWith('@@') ? `<span class="hunk">${l}</span>`
      : l.startsWith('+') ? `<span class="add">${l}</span>`
        : l.startsWith('-') ? `<span class="del">${l}</span>` : l).join('\n');

async function filesDialog() {
  const p = curProject(); if (!p) return;
  let tab = 'tree', cwd = '.';
  modal(`<div class="fmodal"><h3>Файлы · ${esc(p.name)}</h3><p class="sub">${esc(p.short)}</p>
    <div class="ftabs" role="tablist">
      <button role="tab" data-t="tree" aria-selected="true">Дерево</button>
      <button role="tab" data-t="diff" aria-selected="false">Изменения (git)</button></div>
    <div id="fbody"></div>
    <div class="row"><button class="btn" data-no>Закрыть</button></div></div>`, {
    onOpen(m, close) {
      const bodyEl = m.querySelector('#fbody');
      m.querySelector('[data-no]').onclick = close;
      m.querySelectorAll('.ftabs button').forEach(b => b.onclick = () => {
        tab = b.dataset.t;
        m.querySelectorAll('.ftabs button').forEach(x => x.setAttribute('aria-selected', x === b));
        draw();
      });
      const icon = d => d
        ? '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7a2 2 0 012-2h3l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/></svg>'
        : '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>';
      const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : n > 1024 ? Math.round(n / 1024) + ' КБ' : n + ' Б';

      async function draw() {
        bodyEl.innerHTML = '<p class="sub">Читаю…</p>';
        try {
          if (tab === 'diff') {
            const d = await api(`/api/projects/${p.id}/diff`);
            if (!d.repo) { bodyEl.innerHTML = '<p class="sub">Здесь показывается, что агент поменял в файлах с последнего коммита — но в этой папке нет git, сравнивать не с чем.</p>'; return; }
            const body = d.patch
              ? `<div class="fstat">ветка ${esc(d.branch)}\n${esc(d.stat)}</div><div class="fview"><pre>${colorDiff(d.patch)}</pre></div>`
              : `<div class="fstat">ветка ${esc(d.branch)} — изменений нет.</div>`;
            const unt = d.untracked?.length ? `<div class="fstat">новые файлы вне git:\n${esc(d.untracked.join('\n'))}</div>` : '';
            bodyEl.innerHTML = body + unt;
            return;
          }
          const d = await api(`/api/projects/${p.id}/files?path=${encodeURIComponent(cwd)}`);
          bodyEl.innerHTML = `<div class="fcrumb">${d.up !== null ? '<button data-up>↑ наверх</button> · ' : ''}${esc(d.path || '/')}</div>
            <div class="ftree" id="ftree">${d.items.map(it => `<button data-rel="${esc(it.rel)}" data-dir="${it.dir}" class="${it.dir ? 'dir' : ''}">
              ${icon(it.dir)}<span class="nm">${esc(it.name)}</span><span class="sz">${it.dir ? (it.heavy ? 'большая' : '') : size(it.size)}</span></button>`).join('')}</div>
            <div class="fdrop" id="fdrop">перетащи сюда файлы — лягут в ${esc(d.path || 'корень проекта')} · <button data-pick style="color:var(--accent)">или выбери</button><input type="file" multiple hidden data-finp></div>`;
          bodyEl.querySelector('[data-up]')?.addEventListener('click', () => { cwd = d.up; draw(); });
          const upload = async list => {
            for (const f of [...list]) {
              try {
                const r = await fetch(`/api/projects/${p.id}/upload?dir=${encodeURIComponent(cwd)}`, { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) }, body: f });
                const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Не загрузилось.');
                toast(`${j.path} загружен`, 'ok', 3000);
              } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
            }
            draw();
          };
          for (const z of bodyEl.querySelectorAll('#ftree,#fdrop')) {
            z.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); z.classList.add('drop'); } });
            z.addEventListener('dragleave', () => z.classList.remove('drop'));
            z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('drop'); upload(e.dataTransfer.files); });
          }
          bodyEl.querySelector('[data-pick]').onclick = () => bodyEl.querySelector('[data-finp]').click();
          bodyEl.querySelector('[data-finp]').onchange = e => upload(e.target.files);
          bodyEl.querySelectorAll('[data-rel]').forEach(b => b.onclick = async () => {
            if (b.dataset.dir === 'true') { cwd = b.dataset.rel; return draw(); }
            try {
              const rel = b.dataset.rel;
              if (/\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
                bodyEl.innerHTML = `<div class="fcrumb"><button data-back>↑ назад</button> · ${esc(rel)}</div><div class="fview"><img src="/api/projects/${p.id}/raw?path=${encodeURIComponent(rel)}" alt=""></div>`;
                bodyEl.querySelector('[data-back]').onclick = draw; return;
              }
              const f = await api(`/api/projects/${p.id}/file?path=${encodeURIComponent(rel)}`);
              bodyEl.innerHTML = `<div class="fcrumb"><button data-back>↑ назад</button> · ${esc(f.path)} · ${f.lines ?? '?'} строк</div>
                <div class="fview"><pre>${f.text != null ? esc(f.text) : f.binary ? 'двоичный файл' : 'файл слишком большой (' + size(f.size) + ')'}</pre></div>`;
              bodyEl.querySelector('[data-back]').onclick = draw;
            } catch (e) { toast(e.message); }
          });
        } catch (e) { bodyEl.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
      }
      draw();
    }
  });
}
$('#chip-files').onclick = filesDialog;

const V = { available: false, secure: false, rec: null };
const httpsUrl = () => S.https ? `https://${location.hostname}:${S.https}/` : null;
const MIC_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>';

async function voiceInit() {
  const b = $('#btn-mic');
  V.secure = !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  try { Object.assign(V, await api('/api/voice/status')); } catch { }
  b.style.opacity = V.secure && V.available ? '' : '.5';
  b.title = !V.secure ? 'Микрофон работает только по HTTPS'
    : !V.available ? 'Движок распознавания не запущен'
      : V.whisper ? `Голосовой ввод · ${V.vosk} + whisper ${V.whisper}` : 'Голосовой ввод · только черновик';
}

function drawWave(analyser, canvas) {
  const ctx = canvas.getContext('2d');
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
  const W = canvas.width, H = canvas.height, bars = 22, bw = W / bars;
  let raf, level = new Array(bars).fill(0);
  const tick = () => {
    analyser.getByteFrequencyData(buf);
    const step = Math.floor(buf.length / bars) || 1;
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) sum += buf[i * step + j] || 0;
      const v = Math.min(1, (sum / step) / 150);
      level[i] = level[i] * 0.55 + v * 0.45;
      const h = Math.max(2 * dpr, level[i] * H);
      ctx.fillStyle = `rgba(217,169,76,${0.35 + level[i] * 0.65})`;
      ctx.beginPath();
      ctx.roundRect(i * bw + bw * 0.22, (H - h) / 2, bw * 0.56, h, bw * 0.28);
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

function toPcm16(chunks, from) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const src = new Float32Array(total);
  let o = 0; for (const c of chunks) { src.set(c, o); o += c.length; }
  const ratio = from / 16000, out = new Int16Array(Math.floor(total / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio, i0 = Math.floor(p), f = p - i0;
    const v = (src[i0] ?? 0) * (1 - f) + (src[i0 + 1] ?? src[i0] ?? 0) * f;
    out[i] = Math.max(-32768, Math.min(32767, v * 32768));
  }
  return out;
}

async function micToggle() {
  if (V.rec) return;
  if (!V.secure) {
    const u = httpsUrl();
    const t = toast(u ? `Браузер даёт микрофон только по HTTPS. Открой ${u} — сертификат для телефона есть на экране входа.` : 'Браузер даёт микрофон только по HTTPS.', 'warn', 12000);
    if (u) { t.querySelector('.tx').style.cursor = 'pointer'; t.querySelector('.tx').onclick = () => location.href = u; }
    return;
  }
  if (!V.available) return void toast(V.hint || 'Движок распознавания не запущен.', 'warn', 9000);

  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true } }); }
  catch { return void toast('Браузер не дал доступ к микрофону.'); }

  let sid;
  try { sid = (await api('/api/voice/start', { method: 'POST' })).id; }
  catch (e) { stream.getTracks().forEach(t => t.stop()); return void toast(e.message, 'err'); }

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = .6;
  const proc = ac.createScriptProcessor(4096, 1, 1);
  src.connect(analyser); src.connect(proc);
  const silent = ac.createGain(); silent.gain.value = 0; proc.connect(silent); silent.connect(ac.destination);

  const box = $('#dictate'), dtext = $('#dtext'), dtime = $('#dtime'), btn = $('#btn-mic'), inp = $('#inp');
  box.hidden = false; btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true');
  dtext.textContent = 'слушаю…'; dtext.classList.add('empty');
  const put = t => { if (!t) return; inp.value = (inp.value.trim() ? inp.value.trimEnd() + ' ' : '') + t; autosize(); inp.scrollTop = inp.scrollHeight; };
  const stopWave = drawWave(analyser, $('#wave'));
  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    dtime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);

  let pending = [], busy = false, draft = '', dead = false;
  proc.onaudioprocess = e => pending.push(new Float32Array(e.inputBuffer.getChannelData(0)));

  const flush = async final => {
    if (busy && !final) return;
    const chunks = pending; pending = [];
    const pcm = chunks.length ? toPcm16(chunks, ac.sampleRate) : new Int16Array(0);
    busy = true;
    try {
      const url = `/api/voice/${final ? 'stop' : 'feed'}?id=${encodeURIComponent(sid)}`;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm.buffer });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Движок не ответил.');
      if (!final && d.draft !== undefined) {
        draft = d.draft;
        dtext.textContent = draft || 'слушаю…';
        dtext.classList.toggle('empty', !draft);
      }
      return d;
    } finally { busy = false; }
  };
  const feeder = setInterval(() => { flush(false).catch(() => { }); }, 900);

  const teardown = () => {
    if (dead) return; dead = true;
    clearInterval(feeder); clearInterval(timer); stopWave();
    proc.onaudioprocess = null;
    try { proc.disconnect(); src.disconnect(); silent.disconnect(); } catch { }
    ac.close().catch(() => { });
    stream.getTracks().forEach(t => t.stop());
    box.hidden = true; btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false'); btn.innerHTML = MIC_SVG;
    V.rec = null;
  };

  const finish = async () => {
    clearInterval(feeder); clearInterval(timer); stopWave();
    proc.onaudioprocess = null;
    dtext.textContent = draft || 'расшифровываю…'; dtext.classList.remove('empty');
    btn.innerHTML = '<span class="spin"></span>';
    $('#d-done').disabled = true; $('#d-done').textContent = 'Секунду…';
    let text = draft;
    try { const d = await flush(true); if (d?.text) text = d.text; }
    catch (e) { toast(e.message, 'err'); }
    teardown();
    $('#d-done').disabled = false; $('#d-done').textContent = 'Готово';
    put(text);
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
    if (!text) toast('Ничего не разобрал — попробуй ещё раз.', 'warn', 4000);
  };

  V.rec = { finish, cancel: () => { teardown(); fetch(`/api/voice/stop?id=${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => { }); } };
  $('#d-done').onclick = finish;
  $('#d-cancel').onclick = () => V.rec?.cancel();
}
$('#btn-mic').onclick = () => (V.rec ? V.rec.finish() : micToggle());

const qm = t => `<span class="qm" tabindex="0" role="note" aria-label="${esc(t)}">
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.9 5.9a2.1 2.1 0 1 1 2.9 2q-.8.5-.8 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".95" fill="currentColor"/></svg>
  <span class="tip">${esc(t)}</span></span>`;
const LV = { on: false, stop: null, busy: false, speaking: null };

const lvSay = (kind, text) => {
  const cap = $('#live-cap');
  if (kind === 'user') cap.innerHTML = `<b>ты:</b> ${esc(text)}`;
  else if (kind === 'gemini') cap.innerHTML = `<b>${esc((AG[compWho()] ?? AG.codex)[0])}:</b> ${esc(text)}`;
  else cap.textContent = text;
};
const lvStatus = t => { $('#live-st').textContent = t; };

function lvSpeak(text) {
  return new Promise(resolve => {
    const S2 = window.speechSynthesis;
    if (!S2 || !text) return resolve();
    S2.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const ru = S2.getVoices().filter(v => /ru/i.test(v.lang));
    if (ru.length) u.voice = ru.find(v => /Milena|Yuri|Google/i.test(v.name)) ?? ru[0];
    u.lang = 'ru-RU'; u.rate = 1.03;
    u.onend = u.onerror = () => { LV.speaking = null; resolve(); };
    LV.speaking = u;
    S2.speak(u);
  });
}
const lvHush = () => { try { window.speechSynthesis?.cancel(); } catch { } LV.speaking = null; };

async function lvListen(stream, ac, analyser) {
  const sid = (await api('/api/voice/start', { method: 'POST' })).id;
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const silent = ac.createGain(); silent.gain.value = 0;
  ac.createMediaStreamSource(stream).connect(proc); proc.connect(silent); silent.connect(ac.destination);
  let chunks = [], busy = false, draft = '';
  proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));

  const send = async final => {
    const part = chunks; chunks = [];
    const pcm = part.length ? toPcm16(part, ac.sampleRate) : new Int16Array(0);
    const r = await fetch(`/api/voice/${final ? 'stop' : 'feed'}?id=${encodeURIComponent(sid)}`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm.buffer });
    return r.json();
  };

  const level = () => {
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);
    let sum = 0; for (const v of buf) sum += (v - 128) ** 2;
    return Math.sqrt(sum / buf.length) / 128;
  };

  let spoke = false, quiet = 0;
  const t0 = Date.now();
  while (LV.on) {
    await new Promise(r => setTimeout(r, 180));
    const l = level();
    if (l > 0.035) { spoke = true; quiet = 0; } else if (spoke) quiet += 180;
    if (!busy && Date.now() - t0 > 900) {
      busy = true;
      send(false).then(d => { if (d?.draft) { draft = d.draft; lvSay('user', draft); } }).catch(() => { }).finally(() => { busy = false; });
    }
    if (spoke && quiet >= 1100) break;
    if (!spoke && Date.now() - t0 > 20000) break;
  }
  proc.onaudioprocess = null;
  try { proc.disconnect(); silent.disconnect(); } catch { }
  const fin = await send(true).catch(() => null);
  return (fin?.text || draft || '').trim();
}

async function liveStart() {
  if (LV.on) return;
  if (!S.cid) return toast('Сначала открой чат — Gemini говорит про разговор.', 'err');
  if (!S.models?.ready?.companion) return toast('Собеседник не подключён — выбери его в настройках.', 'err', 7000);
  if (!V.secure) return toast('Браузер даёт микрофон только по HTTPS — открой Depo по https.', 'warn', 9000);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { return toast('Браузер не дал доступ к микрофону.', 'err'); }

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const analyser = ac.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = .5;
  ac.createMediaStreamSource(stream).connect(analyser);

  LV.on = true;
  $('#live').hidden = false;
  $('#live-ball').classList.add('rec');
  lvSay('', 'Говори — слушаю. Файлы не трогаю, только разговор.');
  LV.stop = () => { try { ac.close(); } catch { } stream.getTracks().forEach(t => t.stop()); };

  while (LV.on) {
    lvStatus('слушаю'); $('#live-ball').classList.add('rec');
    let said = '';
    try { said = await lvListen(stream, ac, analyser); }
    catch (e) { toast(e.message, 'err', 6000); break; }
    if (!LV.on) break;
    if (!said) { lvSay('', 'Не разобрал — скажи ещё раз.'); continue; }
    lvSay('user', said);
    $('#live-ball').classList.remove('rec'); lvStatus('думает');
    try {
      const d = await api(`/api/chats/${S.cid}/companion`, { method: 'POST', body: { text: said, voice: true } });
      if (!LV.on) break;
      lvSay('gemini', d.text);
      lvStatus('говорит');
      await lvSpeak(d.text);
      refetchTail();
    } catch (e) { lvSay('', e.message); lvStatus('ошибка'); await new Promise(r => setTimeout(r, 1500)); }
  }
  liveStop(false);
}

function liveStop(hide = true) {
  LV.on = false;
  lvHush();
  LV.stop?.(); LV.stop = null;
  $('#live-ball').classList.remove('rec');
  if (hide) $('#live').hidden = true;
  lvStatus('закончили');
}

const LINKS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi' };
const LINK_HINT = {
  codex: 'Открой ссылку на любом своём устройстве, там введи код, показанный ниже, и войди в свой ChatGPT. Как только войдёшь — Depo сам это увидит и закроет окно.',
  kimi: 'Открой ссылку на любом своём устройстве, там введи код, показанный ниже, и войди в свой Kimi. Как только войдёшь — Depo сам это увидит и закроет окно.',
  claude: 'Открой ссылку, войди в свой аккаунт — страница покажет код. Вставь его в поле ниже.',
  gemini: 'Выбери «Sign in with Google» на экране ниже. Вставь сюда ответ терминалу или, если браузер вернул localhost-адрес, передай его отдельным полем.',
};
let LINKBOX = null;

function linkDialog(prov) {
  const title = LINKS[prov] ?? prov;
  const close = modal(`<div class="smodal linkbox"><h3>${agIcon(prov)}Вход в ${esc(title)}</h3>
    <p class="sub">${esc(LINK_HINT[prov] ?? 'Открой ссылку, войди в аккаунт и следуй подсказкам.')}</p>
    <ol class="lksteps">
      <li><div class="lkn">1</div><div class="lkc"><b>Открой ссылку входа</b><span>на этом или на любом своём устройстве — телефоне, ноутбуке</span>
        <div class="lk-links" id="lk-links">готовлю ссылку…</div></div></li>
      <li id="lk-codestep" hidden><div class="lkn">2</div><div class="lkc"><b>Введи этот код на открывшейся странице</b>
        <button class="lk-code" id="lk-code" title="Нажми — скопируется"></button></div></li>
      <li id="lk-paststep" hidden><div class="lkn">2</div><div class="lkc"><b>Передай ответ терминалу</b><span>код, номер пункта или другой текст, который просит Gemini/Claude. Поле не очищается: результат виден ниже.</span>
        <div class="row" style="margin-top:8px"><input class="fld" id="lk-inp" placeholder="код со страницы" autocomplete="off" spellcheck="false"><button class="btn primary" id="lk-send">Готово</button></div></div></li>
      <li id="lk-returnstep"><div class="lkn">3</div><div class="lkc"><b>Если браузер открыл localhost и страница не загрузилась</b><span>скопируй из адресной строки весь адрес и передай его на сервер — это завершает OAuth там.</span>
        <div class="row" style="margin-top:8px"><input class="fld" id="lk-return" placeholder="http://localhost:порт/..." autocomplete="off" spellcheck="false"><button class="btn" id="lk-return-send">Передать</button></div></div></li>
      <li><div class="lkn lkw"><span class="spin"></span></div><div class="lkc"><b id="lk-wait">Жду, когда ты войдёшь…</b><span id="lk-waitsub">как войдёшь — окно закроется само</span></div></li>
    </ol><details class="lk-terminal"><summary>Экран входа агента</summary><pre id="lk-term">запускаю…</pre></details>
    <div class="row"><div class="grow"></div><button class="btn" id="lk-cancel">Отмена</button></div></div>`, {
    onOpen(m, close) {
      LINKBOX = { prov, m, close };
      const stop = () => api(`/api/link/${prov}/cancel`, { method: 'POST' }).catch(() => { });
      m.querySelector('#lk-cancel').onclick = () => { stop(); LINKBOX = null; close(); };
      const put = () => {
        const inp = m.querySelector('#lk-inp'), text = inp.value.trim();
        if (!text) return;
        api(`/api/link/${prov}/send`, { method: 'POST', body: { text } }).then(st => {
          m.querySelector('#lk-wait').textContent = 'Ответ отправлен — смотрю реакцию агента…';
          linkPaint(st);
        }).catch(e => toast(e.message, 'err'));
      };
      m.querySelector('#lk-send').onclick = put;
      m.querySelector('#lk-inp').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); put(); } };
      const callback = () => {
        const input = m.querySelector('#lk-return'), url = input.value.trim();
        if (!url) return;
        api(`/api/link/${prov}/callback`, { method: 'POST', body: { url } }).then(linkPaint).catch(e => toast(e.message, 'err'));
      };
      m.querySelector('#lk-return-send').onclick = callback;
      m.querySelector('#lk-return').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); callback(); } };
      api(`/api/link/${prov}/start`, { method: 'POST' }).then(linkPaint).catch(e => { toast(e.message, 'err'); close(); });
    }
  });
  return close;
}

function linkPaint(st) {
  if (!LINKBOX || !st || st.provider !== LINKBOX.prov) return;
  const m = LINKBOX.m;
  const term = m.querySelector('#lk-term');
  if (term) term.textContent = st.text || 'жду вывода от агента…';
  const links = st.links ?? [];
  const box = m.querySelector('#lk-links');
  if (links.length) {
    const u = links[links.length - 1];
    box.innerHTML = `<a class="btn primary go" href="${esc(u)}" target="_blank" rel="noopener">Открыть ссылку входа</a>
      <button class="btn" data-copy="${esc(u)}">Скопировать</button>`;
    box.querySelector('[data-copy]').onclick = () => navigator.clipboard?.writeText(u).then(() => toast('Ссылка скопирована', 'ok', 2500), () => { });
  }
  const codeStep = m.querySelector('#lk-codestep'), pasteStep = m.querySelector('#lk-paststep');
  if (st.code) {
    codeStep.hidden = false;
    const el = m.querySelector('#lk-code');
    el.textContent = st.code;
    el.onclick = () => navigator.clipboard?.writeText(st.code).then(() => toast('Код скопирован', 'ok', 2500), () => { });
  } else {
    pasteStep.hidden = prov_needs_paste(st.provider) ? false : true;
  }
  if (st.status === 'done') {
    toast(`${LINKS[st.provider] ?? st.provider}: вход выполнен`, 'ok', 5000);
    LINKBOX.close(); LINKBOX = null; settingsDialog();
  } else if (st.status === 'error') {
    m.querySelector('#lk-wait').textContent = 'Вход не удался';
    m.querySelector('#lk-waitsub').textContent = st.error || 'попробуй ещё раз';
  }
}
const prov_needs_paste = p => p === 'claude' || p === 'gemini';

async function settingsDialog() {
  let cfg = { enabled: false, events: [] }, logs = [], last = null, acc = null;
  try { [cfg, logs, last, acc] = await Promise.all([
    api('/api/telegram'),
    api('/api/log').then(d => d.items),
    api('/api/backup').then(d => d.last).catch(() => null),
    api('/api/accounts').catch(() => null),
  ]); } catch (e) { toast(e.message); }

  const EV = [
    ['error', 'Ход упал', 'Агент запустился, но не довёл дело до конца: оборвалась связь, кончился лимит, провайдер вернул ошибку. В сообщении будет проект, чат и сама ошибка.'],
    ['done_long', 'Долгий ход закончен', 'Агент доработал задачу, которая заняла больше двух минут. Короткие ходы не беспокоят — ты и так на них смотришь.'],
    ['limit', 'Лимит перевалил за 80%', 'Израсходовано больше 80% пятичасового или недельного лимита подписки. Присылается один раз на каждый порог: 80% и 95%.'],
    ['attention', 'Нужен ответ', 'Агент остановился и ждёт тебя: просит разрешение на команду или правку. Пока не ответишь — ход стоит.'],
    ['service', 'Перезапуск Depo', 'Сама панель перезапустилась — после перезагрузки сервера, обновления или сбоя. Если в этот момент шли ходы, в сообщении будет, сколько их прервалось.'],
  ];
  const accRow = (prov, title, hint, { profiles = true } = {}) => {
    const a = acc?.[prov] ?? {};
    const on = !!a.current?.ok;
    const cur = on ? (typeof a.current.ok === 'string' ? a.current.ok : a.current.plan ?? 'подключён') : 'не подключён';
    return `<div class="srow acard"><div class="c"><b>${agIcon(prov)}${title}${qm(hint)}</b>
        <span>${esc(cur)}${a.profiles?.length ? ' · профилей: ' + a.profiles.length : ''}</span></div>
      <div class="ctl"><button class="btn ${on ? '' : 'primary'}" data-acc-link="${prov}">${on ? 'Войти заново' : 'Подключить'}</button>
        ${on ? `<button class="btn danger" data-acc-logout="${prov}">Выйти</button>` : ''}
        ${profiles ? `<button class="btn" data-acc-save="${prov}">Сохранить как…</button><button class="btn" data-acc-menu="${prov}">Профили</button>` : ''}</div></div>`;
  };
  const soonRow = (prov, title, hint, why) =>
    `<div class="srow acard"><div class="c"><b>${agIcon(prov)}${title}${qm(hint)}</b><span>${esc(why)}</span></div>
      <div class="ctl"><button class="btn" disabled>Нет входа</button></div></div>`;
  const v = V.available ? 'работает' : 'не запущен';

  modal(`<div class="smodal sfull">
    <div class="shead"><div><h3>Настройки</h3><span class="shsub">Depo на ${esc(S.host?.name ?? '')} · ${esc(S.version ?? '')}</span></div><button class="bb shx" data-no aria-label="Закрыть">✕</button></div>
    <div class="sbody">
    <nav class="stabs" id="stabs" aria-label="Разделы настроек">
      <button data-st="acc" aria-selected="true">Аккаунты</button>
      <button data-st="chat" aria-selected="false">Чат</button>
      <button data-st="tg" aria-selected="false">Телеграм</button>
      <button data-st="dev" aria-selected="false">Устройство</button>
      <button data-st="data" aria-selected="false">Данные</button>
    </nav>
    <div class="spanes">
    <section data-st="acc">
<div class="gl2">Аккаунты агентов</div>
    <p class="sub" style="margin:-4px 0 10px">Вход везде одинаковый и только через браузер: Depo открывает окно агента,
      ты жмёшь ссылку, входишь в свой аккаунт — и всё. Ключей API Depo не спрашивает и не хранит.</p>
    ${accRow('claude', 'Claude Code', 'Depo запустит claude auth login и покажет его экран: ссылку откроешь в браузере, код вставишь обратно. Учётные данные лягут на эту машину — туда же, куда их кладёт вход в терминале.')}
    ${accRow('codex', 'Codex', 'То же самое: вход через аккаунт ChatGPT. Если браузер перекинет на адрес вида localhost:1455 и страница не откроется — скопируй этот адрес в поле «вернулся из браузера», Depo доведёт вход до конца сам.')}
    ${accRow('gemini', 'Gemini', 'Собеседник в чате, а не исполнитель: читает разговор и отвечает словами, файлы не трогает. Вход — обычный аккаунт Google: Depo покажет ссылку, на странице Google ты получишь код и вставишь его обратно. Если Gemini уже подключён и нужно сменить аккаунт — напиши в его окне /auth.', { profiles: false })}
    ${accRow('kimi', 'Kimi K2', 'Исполнитель, как Claude и Codex. Вход по подписке Kimi: Depo откроет ссылку, введёшь код на странице kimi.ai — и готово. Работает через Kimi Code CLI.', { profiles: false })}

    </section>
    <section data-st="chat" hidden>
<div class="gl2">Новый чат по умолчанию</div>
    <div class="srow"><div class="c"><b>Агент</b><span>кем открывается свежий чат; показаны только подключённые аккаунты</span></div><div class="ctl"><select id="pf-provider">${agents().map(p => `<option value="${p}">${esc(agName(p))}</option>`).join('')}</select></div></div>
    <div class="srow"><div class="c"><b>Модель</b><span>«По умолчанию» = та же, что в Claude Code</span></div><div class="ctl"><select id="pf-model"></select></div></div>
    <div class="srow"><div class="c"><b>Сколько думать${qm('Уровень раздумий модели. Быстрее — дешевле и шустрее, глубже — лучше на сложных задачах. «По умолчанию» берёт настройку самого агента.')}</b><span>Claude: --effort · Codex: reasoning effort</span></div><div class="ctl"><select id="pf-effort"></select></div></div>
    <div class="srow"><div class="c"><b>Разрешения${qm('Что агенту можно без вопросов. «По умолчанию» — спрашивает перед командами и правками, как Claude Code в терминале.')}</b><span>можно поменять в любом чате внизу</span></div><div class="ctl"><select id="pf-perm">${(S.models?.permissions ?? []).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div></div>

    <div class="gl2">Собеседник</div>
    <div class="srow"><div class="c"><b>Кто отвечает на вопросы о чате${qm('Собеседник читает разговор и отвечает словами — текстом или голосом. Он ничего не выполняет и файлов не трогает. Работать им может любой подключённый агент: Codex (аккаунт ChatGPT), Claude или Gemini.')}</b>
        <span>кнопка со значком рядом с микрофоном · им же говорит голосовой режим</span></div>
      <div class="ctl"><select id="pf-comp">${(S.models?.companion ? Object.entries(S.models.companion.ready) : []).map(([k, okk]) =>
        `<option value="${k}" ${k === compWho() ? 'selected' : ''} ${okk ? '' : 'disabled'}>${esc((AG[k] ?? AG.codex)[0])}${okk ? '' : ' — не подключён'}</option>`).join('')}</select></div></div>

    <div class="gl2">Лента чата</div>
    <div class="srow"><div class="c"><b>Показывать команды и инструменты${qm('Строки Bash, Read, Edit и прочее, что агент делает по ходу. Выключено — в ленте только твой запрос и ответ агента; упавшие команды всё равно видно.')}</b><span>выключено — чище читать, включено — видно каждый шаг</span></div>
      <div class="ctl"><button class="sw2" id="pf-tools" role="switch" aria-checked="${showTools()}"></button></div></div>

    <div class="srow"><div class="c"><b>Копия переписки в папке проекта${qm('После каждого хода Depo кладёт разговор в папку .depo внутри проекта — по файлу markdown на чат, только реплики. Git её не видит: внутри лежит .gitignore со звёздочкой. Нужна, чтобы история жила рядом с кодом, а не только в базе Depo.')}</b><span>папка .depo рядом с кодом · обновляется через полминуты после хода</span></div>
      <div class="ctl"><button class="sw2" id="pf-snap" role="switch" aria-checked="${S.prefs.snapshot !== '0'}"></button></div></div>

    <div class="gl2">Зеркало Claude Code</div>
    <div class="srow"><div class="c"><b>Показывать сессии из терминала и Remote Control${qm('Depo читает файлы сессий Claude Code в ~/.claude/projects и показывает их как чаты проекта. Поэтому то, что ты делал в терминале или с телефона через Remote Control, видно здесь — и наоборот.')}</b><span>проверяет каждые 45 секунд</span></div>
      <div class="ctl"><button class="sw2" id="pf-mirror" role="switch" aria-checked="${S.prefs.mirror !== '0'}"></button></div></div>
    <div class="srow"><div class="c"><b>Импортированные чаты старше N дней — сразу в архив${qm('Касается только чужих сессий, которые Depo подбирает из Claude Code, и только в момент, когда видит их впервые. Твои чаты в Depo и то, что уже в списке, никуда не уезжает — архивируй сам или кнопкой в меню проекта.')}</b><span>чтобы при первом знакомстве с проектом не вываливать сотню старых разговоров</span></div>
      <div class="ctl"><input type="number" id="pf-days" min="1" max="365" value="${esc(S.prefs.archive_days || '14')}"></div></div>

    </section>
    <section data-st="tg" hidden>
<div class="gl2">Уведомления в телеграм</div>
    <label>Токен бота от @BotFather<input type="text" id="tg-token" placeholder="${cfg.has_token ? '•••••• сохранён, впиши новый чтобы заменить' : '123456:AA…'}"></label>
    <label>Кому слать (chat id)<input type="text" id="tg-chat" value="${esc(cfg.chat || '')}" placeholder="нажми «Определить» после сообщения боту"></label>
    <div class="row" style="margin:-4px 0 12px"><button class="btn" id="tg-detect">Определить</button><button class="btn" id="tg-test">Проверить</button><div class="grow"></div></div>
    <div class="srow"><div class="c"><b>Слать уведомления</b><span>общий выключатель</span></div>
      <div class="ctl"><button class="sw2" id="tg-on" role="switch" aria-checked="${cfg.enabled}"></button></div></div>
    ${EV.map(([k, t, d]) => `<label class="chk"><input type="checkbox" data-ev="${k}" ${cfg.events?.includes(k) ? 'checked' : ''}><span class="cl">${t}<i>${esc(d)}</i></span></label>`).join('')}
    <p class="err" id="tg-err">${esc(cfg.last_error || '')}</p>

    </section>
    <section data-st="dev" hidden>
<div class="gl2">Это устройство</div>
    <div class="srow"><div class="c"><b>Уведомления в браузере${qm('Всплывают, когда ход закончился или агент ждёт ответа, а вкладка Depo не на виду. Нужен HTTPS и разрешение браузера.')}</b><span>работают и когда панель свёрнута</span></div>
      <div class="ctl"><button class="sw2" id="pf-notif" role="switch" aria-checked="${localStorage.getItem('depo.notif') === '1'}"></button></div></div>
    <div class="srow"><div class="c"><b>HTTPS${qm('Микрофон и уведомления браузер отдаёт только защищённому соединению. Сертификат свой, его нужно один раз поставить на телефон.')}</b><span>${S.https ? `<a style="color:var(--accent)" href="https://${esc(location.hostname)}:${S.https}/">открыть по https</a> · <a style="color:var(--accent)" href="/ca.crt">сертификат для телефона</a>` : 'сертификата нет — запусти scripts/make-cert.sh'}</span></div>
      <div class="ctl"><span class="v">${location.protocol === 'https:' ? 'включён' : 'выключен'}</span></div></div>

    <div class="gl2">Голосовой ввод</div>
    <div class="srow"><div class="c"><b>Движок распознавания${qm('Пока говоришь — черновик даёт быстрый Vosk. Когда отпускаешь — текст переписывает Whisper: он ставит знаки препинания и оставляет английские слова латиницей. Всё считается на сервере.')}</b><span>${esc(V.vosk || 'vosk')}${V.whisper ? ' + whisper ' + esc(V.whisper) : V.whisper_loading ? ' · whisper загружается' : ' · без чистовика'}</span></div>
      <div class="ctl"><span class="v">${v}</span></div></div>
    ${V.available ? '' : '<p class="sub" style="margin:0 0 6px">Запусти один раз: <code style="font:11.5px var(--mono);color:var(--accent)">bash ~/depo/scripts/voice-install.sh</code></p>'}

    </section>
    <section data-st="data" hidden>
<div class="gl2">Резервные копии</div>
    <div class="srow"><div class="c"><b>Последняя копия${qm('По расписанию Depo сохраняет согласованную копию базы и вложений. Количество архивов и каталог хранения настраиваются в .env.')}</b><span>${last?.ok ? esc(new Date(last.at).toLocaleString('ru-RU')) : last ? 'не прошла: ' + esc(last.error || '') : 'ещё не делалась'}</span></div>
      <div class="ctl"><button class="btn" id="bk-now">Сделать сейчас</button></div></div>

    <div class="gl2">Журнал</div>
    <div class="logbox">${logs.length ? logs.slice(0, 80).map(l =>
      `<div class="l ${esc(l.level)}"><span class="t">${hhmm(l.ts)}</span><span class="s">${esc(l.scope || '')}</span><span>${esc(l.text)}</span></div>`).join('') : '<div class="l">пусто</div>'}</div>

    </section>
    </div></div>
    <div class="sfoot"><div class="row"><button class="btn" id="pw">Сменить пароль</button><button class="btn" id="lo">Выйти</button><div class="grow"></div>
      <button class="btn" data-no>Закрыть</button><button class="btn primary" id="save">Сохранить</button></div></div>`, {
    onOpen(m, close) {
      const err = m.querySelector('#tg-err');
      m.querySelectorAll('[data-no]').forEach(b => b.onclick = close);
      m.querySelectorAll('#stabs button').forEach(b => b.onclick = () => {
        m.querySelectorAll('#stabs button').forEach(x => x.setAttribute('aria-selected', x === b));
        m.querySelectorAll('.spanes > section').forEach(sec => sec.hidden = sec.dataset.st !== b.dataset.st);
        m.querySelector('.spanes').scrollTop = 0;
      });
      m.querySelector('#pw').onclick = () => { close(); passwordDialog(); };
      m.querySelector('#lo').onclick = () => api('/api/logout', { method: 'POST' }).then(() => location.href = '/login');
      m.querySelectorAll('[data-acc-link]').forEach(b => b.onclick = () => { close(); linkDialog(b.dataset.accLink); });
      m.querySelectorAll('[data-acc-logout]').forEach(b => b.onclick = () => {
        const prov = b.dataset.accLogout;
        confirmBox(`Выйти из ${agName(prov)}?`,
          'Агент исчезнет из выбора для новой работы. Его чаты и сохранённые профили останутся; подключить аккаунт снова можно здесь.',
          'Выйти', async () => {
            try {
              await api(`/api/accounts/${prov}/logout`, { method: 'POST' });
              await refreshModels(); close(); await settingsDialog();
              toast(`${agName(prov)}: выход выполнен`, 'ok', 4000);
            } catch (e2) { toast(e2.message, 'err', 7000); }
          });
      });
      m.querySelectorAll('[data-acc-save]').forEach(b => b.onclick = () => {
        const prov = b.dataset.accSave;
        promptBox(`Сохранить аккаунт ${prov}`, 'Запомню текущие учётные данные под этим именем, чтобы потом переключаться одной кнопкой.', '', 'Сохранить',
          async v2 => { await api(`/api/accounts/${prov}/save`, { method: 'POST', body: { name: v2 } }); close(); toast('Профиль сохранён', 'ok', 3000); });
      });
      m.querySelectorAll('[data-acc-menu]').forEach(b => b.onclick = e => {
        e.stopPropagation();
        const prov = b.dataset.accMenu, a = acc?.[prov] ?? {};
        const items = (a.profiles ?? []).map(pr => ({
          text: pr.name, hint: pr.active ? 'сейчас активен' : 'переключиться', active: pr.active,
          run: () => api(`/api/accounts/${prov}/use`, { method: 'POST', body: { name: pr.name } })
            .then(async () => { await refreshModels(); close(); toast(`${prov}: включён профиль ${pr.name}`, 'ok', 4000); }).catch(e2 => toast(e2.message, 'err')),
        }));
        menu(b, [
          { label: `Профили ${prov}` },
          ...(items.length ? items : [{ text: 'пока ничего не сохранено', run: () => { } }]),
        ]);
      });
      const sw = m.querySelector('#tg-on');
      sw.onclick = () => sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') !== 'true');
      const payload = () => ({
        token: m.querySelector('#tg-token').value.trim() || undefined,
        chat: m.querySelector('#tg-chat').value.trim(),
        enabled: sw.getAttribute('aria-checked') === 'true',
        events: [...m.querySelectorAll('[data-ev]')].filter(c => c.checked).map(c => c.dataset.ev),
      });
      const pfProv = m.querySelector('#pf-provider'), pfModel = m.querySelector('#pf-model'), pfPerm = m.querySelector('#pf-perm'), pfEff = m.querySelector('#pf-effort');
      const fillModels = () => {
        pfModel.innerHTML = (S.models?.[pfProv.value]?.items ?? []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
        pfModel.value = S.prefs.model || '';
        fillEfforts();
      };
      const fillEfforts = () => {
        const list = effortsFor(pfProv.value, pfModel.value);
        pfEff.innerHTML = '<option value="">По умолчанию</option>' + list.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
        pfEff.value = S.prefs.effort || '';
      };
      pfProv.value = agents().includes(S.prefs.provider) ? S.prefs.provider : (agents()[0] ?? ''); fillModels();
      pfProv.onchange = fillModels; pfModel.onchange = fillEfforts;
      pfPerm.value = S.prefs.permission_mode || 'manual';
      const sw2 = m.querySelector('#pf-mirror'); sw2.onclick = () => sw2.setAttribute('aria-checked', sw2.getAttribute('aria-checked') !== 'true');
      const swT = m.querySelector('#pf-tools'); swT.onclick = () => swT.setAttribute('aria-checked', swT.getAttribute('aria-checked') !== 'true');
      const swS = m.querySelector('#pf-snap'); swS.onclick = () => swS.setAttribute('aria-checked', swS.getAttribute('aria-checked') !== 'true');
      const sw3 = m.querySelector('#pf-notif'); sw3.onclick = async () => {
        const want = sw3.getAttribute('aria-checked') !== 'true';
        if (want && !('Notification' in window)) return toast('Этот браузер не умеет уведомления (нужен https и установка на экран).');
        if (want && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') return toast('Браузер не дал разрешение на уведомления.'); }
        sw3.setAttribute('aria-checked', want); localStorage.setItem('depo.notif', want ? '1' : '0');
      };
      m.querySelector('#save').onclick = async () => {
        try {
          await api('/api/telegram', { method: 'POST', body: payload() });
          const d = await api('/api/settings', { method: 'POST', body: { provider: pfProv.value, model: pfModel.value, effort: pfEff.value, permission_mode: pfPerm.value, mirror: sw2.getAttribute('aria-checked') === 'true' ? '1' : '0', archive_days: m.querySelector('#pf-days').value, tools: swT.getAttribute('aria-checked') === 'true' ? '1' : '0', snapshot: swS.getAttribute('aria-checked') === 'true' ? '1' : '0',
            companion: m.querySelector('#pf-comp')?.value || '' } });
          S.prefs = d.prefs; applyFeedPrefs();
          try { await refreshModels(); } catch { }
          close(); toast('Настройки сохранены', 'ok', 3000);
        } catch (e) { err.textContent = e.message; }
      };
      m.querySelector('#tg-detect').onclick = async () => {
        err.textContent = '';
        try {
          await api('/api/telegram', { method: 'POST', body: { token: m.querySelector('#tg-token').value.trim() || undefined } });
          const d = await api('/api/telegram/detect', { method: 'POST' });
          m.querySelector('#tg-chat').value = d.chat;
          err.textContent = `нашёл: ${d.from || d.chat}`;
        } catch (e) { err.textContent = e.message; }
      };
      m.querySelector('#tg-test').onclick = async () => {
        err.textContent = '';
        try { await api('/api/telegram', { method: 'POST', body: payload() }); const d = await api('/api/telegram/test', { method: 'POST' }); err.textContent = `отправил через @${d.username}`; }
        catch (e) { err.textContent = e.message; }
      };
      m.querySelector('#bk-now').onclick = async e => {
        e.target.disabled = true; e.target.textContent = 'Делаю…';
        try { const d = await api('/api/backup', { method: 'POST' }); toast(d.ok ? `Копия готова: ${(d.size / 1048576).toFixed(1)} МБ` : d.error, d.ok ? 'ok' : 'err', 7000); }
        catch (e2) { toast(e2.message, 'err'); }
        finally { e.target.disabled = false; e.target.textContent = 'Сделать сейчас'; }
      };
    }
  });
}

const collapsed = () => $('#app').dataset.side === '0';
function setSide(open) {
  $('#app').dataset.side = open ? '1' : '0';
  $('#btn-side').title = open ? 'Свернуть панель  [' : 'Развернуть панель  [';
  if (open) closeFly();
  try { localStorage.setItem('depo.side', open ? '1' : '0'); } catch { }
}
const closeFly = () => { $('#fly').hidden = true; };
function openFly(top, p) {
  const f = $('#fly');
  f.innerHTML = `<div class="fh"><b>${esc(p.name)}</b><span>${chatsOf(p.id).filter(c => !c.archived).length}</span></div>` + chatListHTML(p.id, false);
  f.style.top = '0px'; f.hidden = false;
  f.style.top = Math.max(8, Math.min(top, innerHeight - f.offsetHeight - 16)) + 'px';
}

$('#rail').addEventListener('click', e => {
  const b = e.target.closest('.pbtn'); if (!b) return;
  const p = projectOf(+b.dataset.p); if (!p) return;
  if (innerWidth <= 760) { selectProject(p.id, { keepChat: true }).then(() => { renderAll(); setSide(true); }); return; }
  if (collapsed()) {
    const same = !$('#fly').hidden && p.id === S.pid;
    const top = b.getBoundingClientRect().top;
    selectProject(p.id).then(() => same ? closeFly() : openFly(top, p));
  } else { closeFly(); selectProject(p.id); }
});

function listClick(e) {
  const more = e.target.closest('[data-menu]');
  if (more) { e.stopPropagation(); const c = chatOf(more.dataset.menu); if (c) chatMenu(more, c); return; }
  const un = e.target.closest('[data-unarch]');
  if (un) { e.stopPropagation(); patchChat(un.dataset.unarch, { archived: false }); return; }
  const row = e.target.closest('[data-c]');
  if (row) { selectChat(row.dataset.c); closeFly(); if (innerWidth <= 760) setSide(false); return; }
  const ah = e.target.closest('.ahead');
  if (ah) {
    S.archOpen = !S.archOpen;
    const l = ah.nextElementSibling; l.hidden = !S.archOpen;
    ah.setAttribute('aria-expanded', S.archOpen);
  }
}
$('#clist').addEventListener('click', listClick);
$('#fly').addEventListener('click', listClick);
$('#clist').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-c]')) { e.preventDefault(); selectChat(e.target.dataset.c); }
});

$('#btn-side').onclick = () => setSide(collapsed());
$('#btn-exp').onclick = () => setSide(true);
$('#btn-newproject').onclick = newProjectDialog;
$('#btn-pmenu').onclick = e => { e.stopPropagation(); projectMenu(e.currentTarget); };
$('#btn-user').onclick = e => { e.stopPropagation(); userMenu(e.currentTarget); };
$('#btn-newchat').onclick = () => {
  if (!curProject()) return;
  S.cid = null; S.messages = []; S.live = null; S.atts = []; resetDraft(); renderAtts();
  renderAll(); renderFeed(); $('#inp').focus(); save();
  if (innerWidth <= 760) setSide(false);
};
$('#btn-gemini').onclick = async () => {
  if (!S.cid) return toast('Сначала открой чат — Gemini отвечает про разговор.', 'err');
  const inp = $('#inp'), text = inp.value.trim();
  if (!text) return liveStart();
  const b = $('#btn-gemini');
  b.disabled = true; b.classList.add('busy');
  try {
    await api(`/api/chats/${S.cid}/companion`, { method: 'POST', body: { text } });
    inp.value = ''; autosize();
  } catch (e) { toast(e.message, 'err', 6000); }
  finally { b.disabled = false; b.classList.remove('busy'); }
};
$('#btn-board').onclick = () => boardDialog();
$('#live-stop').onclick = () => liveStop();
$('#live-ball').onclick = () => lvHush();
$('#live-send').onclick = async () => {
  const i = $('#live-text'); const t = i.value.trim(); if (!t || !S.cid) return;
  i.value = ''; lvHush(); lvSay('user', t); lvStatus('думает');
  try {
    const d = await api(`/api/chats/${S.cid}/companion`, { method: 'POST', body: { text: t, voice: true } });
    lvSay('gemini', d.text); lvStatus('говорит'); await lvSpeak(d.text); refetchTail(); lvStatus('слушаю');
  } catch (e) { toast(e.message, 'err', 6000); lvStatus('ошибка'); }
};
$('#live-text').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#live-send').click(); } };
$('#btn-settings').onclick = () => settingsDialog();

function togglePop(btn) {
  const on = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', !on);
  $('#pop-ctx').hidden = on;
  if (!on) {
    renderCtxPop();
    api(`/api/meters?provider=${curProvider()}`)
      .then(d => { S.meters = { ...S.meters, [d.provider]: d }; renderCtxPop(); renderLimits(); }).catch(() => { });
    if (S.cid) loadChatContext(S.cid);
  }
}
$('#chip-gauge').onclick = e => { e.stopPropagation(); togglePop(e.currentTarget); };
$('#chip-state').onclick = () => { if (isRunning(S.cid)) stop(); };
document.addEventListener('click', e => {
  if (!e.target.closest('#pop-ctx') && !e.target.closest('#chip-gauge') && !$('#pop-ctx').hidden) {
    $('#pop-ctx').hidden = true; $('#chip-gauge').setAttribute('aria-expanded', 'false');
  }
  if (!e.target.closest('#fly') && !e.target.closest('#rail')) closeFly();
  if (innerWidth <= 760 && !collapsed() && !e.target.closest('.side') && !e.target.closest('.rail')
      && !e.target.closest('.exp') && !e.target.closest('.scrim') && !e.target.closest('.menu')) setSide(false);
});

$('#btn-agent').onclick = e => {
  const s2 = settingsOf();
  menu(e.currentTarget, [
    { label: 'Кем выполнить задачу' },
    ...agents().map(p => ({
      text: agName(p), active: p === s2.provider,
      run: () => setSettings({ provider: p, model: null, effort: '' }),
    })),
  ]);
};
$('#btn-model').onclick = e => {
  const s2 = settingsOf();
  const items = S.models?.[s2.provider]?.items ?? [];
  const mk = m => ({ text: m.name, hint: m.description || '', active: (s2.model || '') === m.id, run: () => setSettings({ model: m.id || null, effort: '' }) });
  const main = items.filter(m => m.section !== 'more'), more = items.filter(m => m.section === 'more');
  menu(e.currentTarget, [{ label: s2.provider === 'codex' ? 'Модель Codex' : 'Модель' }, ...main.map(mk),
    ...(more.length ? [{ label: 'Остальные' }, ...more.map(mk)] : [])]);
};
$('#btn-effort').onclick = e => {
  const s2 = settingsOf();
  const list = effortsFor(s2.provider, s2.model);
  if (!list.length) return;
  const def = defaultEffortName(s2.provider, s2.model);
  menu(e.currentTarget, [
    { label: 'Сколько думать' },
    { text: def ? `По умолчанию · ${def}` : 'По умолчанию', hint: 'как настроено в самом агенте', active: !s2.effort, run: () => setSettings({ effort: '' }) },
    ...list.map(x => ({ text: x.name, hint: x.hint, active: s2.effort === x.id, run: () => setSettings({ effort: x.id }) })),
  ]);
};
$('#btn-perm').onclick = e => {
  const s2 = settingsOf();
  menu(e.currentTarget, [{ label: 'Разрешения' }, ...(S.models?.permissions ?? []).map(p =>
    ({ text: p.name, hint: p.hint, active: s2.permission_mode === p.id, run: () => setSettings({ permission_mode: p.id }) }))]);
};
$('#btn-send').onclick = () => (isRunning(S.cid) ? stop() : send());
$('#inp').addEventListener('input', autosize);
$('#inp').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '[') { e.preventDefault(); setSide(collapsed()); }
  if (e.key === 'Escape') { closeFly(); closeMenus(); if (!$('#pop-ctx').hidden) { $('#pop-ctx').hidden = true; $('#chip-ctx').setAttribute('aria-expanded', 'false'); } }
  if (e.key === 'n' && curProject()) { e.preventDefault(); $('#btn-newchat').click(); }
  if (e.key === '/') { e.preventDefault(); $('#inp').focus(); }
});

{
  let sw = null;
  document.addEventListener('touchstart', e => {
    if (innerWidth > 760 || e.touches.length !== 1) return;
    const t = e.touches[0];
    const open = !collapsed();
    if (!open && t.clientX > 28) return;
    sw = { x: t.clientX, y: t.clientY, open, fired: false };
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!sw || sw.fired) return;
    const t = e.touches[0];
    const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (Math.abs(dy) > 46 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
    if (!sw.open && dx > 56) { sw.fired = true; setSide(true); }
    else if (sw.open && dx < -56) { sw.fired = true; setSide(false); }
  }, { passive: true });
  document.addEventListener('touchend', () => { sw = null; }, { passive: true });
}

async function boardDialog() {
  let items = [];
  try { items = (await api('/api/board')).items; } catch (e) { return toast(e.message); }
  const cols = [['attention', 'Ждут тебя', 'var(--warn)'], ['running', 'В работе', 'var(--accent)'], ['done', 'Готово, не смотрел', 'var(--ok)']];
  const card = c => `<div class="bcard" data-id="${c.id}">
      <div class="p"><span class="g">${esc(c.glyph)}</span>${esc(c.project)}
        <span class="pv">${esc(agName(c.provider))}</span>
        ${c.ctx_window ? `<span class="cx">ctx ${c.ctx_pct}%</span>` : ''}<span class="t">${ago(c.updated_at)}</span></div>
      <div class="ti">${esc(c.title)}</div>
      ${c.question ? `<div class="q ask">${esc(c.question)}</div>` : c.snippet ? `<div class="q">${esc(c.snippet)}</div>` : ''}
      <div class="tail" hidden></div>
      <div class="acts">
        ${c.approval_id ? `<button class="btn" data-dec="${c.approval_id}" data-allow="0">Отклонить</button><button class="btn primary" data-dec="${c.approval_id}" data-allow="1">Разрешить</button>` : ''}
        <button class="btn ghost" data-more="${c.id}">Показать ход</button>
        <button class="btn ghost" data-open="${c.id}">Открыть чат</button>
      </div>
    </div>`;
  modal(`<div class="bmodal"><h3>Доска</h3><p class="sub">Что ждёт твоего ответа, что работает, что закончилось без тебя. Собирается само по всем проектам.</p>
    <div class="bcols">${cols.map(([k, t, col]) => { const xs = items.filter(i => i.column === k);
      return `<div class="bcol"><div class="bh"><span class="d" style="background:${col}"></span>${t}<span class="n">${xs.length}</span></div>
        <div class="list">${xs.length ? xs.map(card).join('') : '<div class="bempty">пусто</div>'}</div></div>`; }).join('')}</div>
    <div class="row"><button class="btn" data-no>Закрыть</button></div></div>`, { wide: true,
    onOpen(m, close) {
      m.querySelector('[data-no]').onclick = close;
      m.querySelectorAll('[data-dec]').forEach(b => b.onclick = e => { e.stopPropagation();
        api(`/api/approvals/${b.dataset.dec}/decide`, { method: 'POST', body: { allow: b.dataset.allow === '1' } }).then(() => { close(); boardDialog(); }).catch(e2 => toast(e2.message)); });
      m.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { close(); selectChat(b.dataset.open); });
      m.querySelectorAll('[data-more]').forEach(b => b.onclick = async () => {
        const card2 = b.closest('.bcard'), tail = card2.querySelector('.tail');
        if (!tail.hidden) { tail.hidden = true; b.textContent = 'Показать ход'; return; }
        b.textContent = 'Читаю…'; b.disabled = true;
        try {
          const d = await api(`/api/chats/${b.dataset.more}/messages`);
          const last = d.messages.filter(x => x.text && x.role !== 'system' && (showTools() || x.role !== 'tool')).slice(-6);
          tail.innerHTML = last.length ? last.map(x => {
            const who = x.role === 'user' ? 'ты' : x.role === 'tool' ? (x.text.split('  ')[0] || 'инструмент') : agName(x.provider);
            const body = x.role === 'tool' ? x.text.split('  ').slice(1).join('  ') : x.text;
            return `<div class="tl ${x.role}"><span class="w">${esc(who)}</span><span class="b">${esc((body || '').replace(/\s+/g, ' ').slice(0, 320))}</span></div>`;
          }).join('') : '<div class="tl"><span class="b">пока ничего не записано</span></div>';
          tail.hidden = false; b.textContent = 'Свернуть';
        } catch (e2) { toast(e2.message); b.textContent = 'Показать ход'; }
        finally { b.disabled = false; }
      });
    }
  });
}
(async function boot() {
  const narrow = () => innerWidth <= 760;
  try {
    const pref = localStorage.getItem('depo.side');
    if (pref === '0' || (pref === null && narrow())) setSide(false);
  } catch { if (narrow()) setSide(false); }
  try {
    const d = await api('/api/state');
    Object.assign(S, { user: d.user, projects: d.projects, chats: d.chats, meters: d.meters, running: d.running, host: d.host, version: d.version, models: d.models, approvals: d.approvals ?? [], prefs: d.prefs ?? {}, https: d.https ?? null });
    applyFeedPrefs();
  } catch (e) { return void toast('Не удалось загрузить состояние: ' + e.message, 'err', 0); }

  let sel = {};
  try { sel = JSON.parse(localStorage.getItem('depo.sel') || '{}'); } catch { }
  const live = S.projects.filter(p => !p.archived);
  S.pid = live.some(p => p.id === sel.pid) ? sel.pid : live[0]?.id ?? null;
  const want = chatOf(sel.cid);
  renderAll();
  if (want && want.project_id === S.pid) await selectChat(want.id);
  else if (S.pid) await selectProject(S.pid);
  connect();
  autosize();
  voiceInit();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  navigator.serviceWorker?.addEventListener?.('message', e => { if (e.data?.open) selectChat(e.data.open); });
  const wantChat = new URLSearchParams(location.search).get('chat');
  if (wantChat && chatOf(wantChat)) { history.replaceState(null, '', '/'); selectChat(wantChat); }
})();
