/* ───────── Depo · клиент ───────── */
import { projectFileUrl, isImagePath } from './file-links.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  user: null, projects: [], chats: [], meters: null, running: [],
  pid: null, cid: null, messages: [], archOpen: false, live: null, host: null, connected: true, models: null, approvals: [], prefs: {}, https: null, atts: [], ctx: {},
  queues: {}, steering: {}, sendMode: 'now', runs: {}, history: new Map(), loadingChats: new Map(), chatState: new Map(), feedFrom: 0, scrollKeep: null,
  view: 'chat', dash: null,
};
const STATE_RU = { running: 'работает', attention: 'нужен ответ', idle: 'ожидает', done: 'завершён', error: 'ошибка' };
const CTX_COLORS = ['#d9a94c', '#7fa3d1', '#6fb98a', '#c98f6f', '#9a8fd1', '#cf7fa3', '#5f8fb0', '#33343a'];
const modelName = (prov, id) => {
  const list = S.models?.[prov]?.items ?? [];
  if (!id) return list[0]?.name ?? 'По умолчанию';
  return list.find(m => m.id === id)?.name ?? id;
};
const permName = id => (S.models?.permissions ?? []).find(p => p.id === id)?.name ?? id;

/* ───────── сеть ───────── */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) { location.href = '/'; throw new Error('Нужен вход.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Ошибка ${r.status}`), { status: r.status, data: d });
  return d;
}

/* ───────── уведомления ───────── */
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
  const drop = () => { if (!t.isConnected || t.classList.contains('bye')) return; t.classList.add('bye'); setTimeout(() => t.remove(), 220); };
  t.querySelector('.x').onclick = drop;
  // на телефоне — как пуш сверху: новое сверху, смахивается вверх
  if (innerWidth <= 760) $('#toasts').prepend(t); else $('#toasts').append(t);
  let y0 = null;
  t.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  t.addEventListener('touchmove', e => { if (y0 != null && y0 - e.touches[0].clientY > 24) { y0 = null; drop(); } }, { passive: true });
  if (ms) setTimeout(drop, ms);
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
    if (!button) { toast('Скопировано.', 'ok', 2000); return; }
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
  const image = e.target.closest('.md-image');
  if (image) showProjectImage(image.dataset.full, image.dataset.name, image.dataset.file);
});

/* ───────── markdown ───────── */
const SLOT = '␟';                       // символ-разделитель, в тексте не встречается
function md(src, project) {
  const code = [];
  let s = String(src ?? '').replace(/\r\n/g, '\n');
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, b) =>
    `${SLOT}B${code.push(`<pre><button type="button" class="copy-btn copy-code" aria-label="Скопировать команду" title="Скопировать команду">${ICONS.copy}</button><code>${esc(b.replace(/\n$/, ''))}</code></pre>`) - 1}${SLOT}`);
  s = s.replace(/(!?)\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g, (match, bang, label, angled, bare) => {
    const ref = angled || bare;
    const href = projectFileUrl(project, ref);
    if (!href) return match;
    const name = ref.replace(/\\/g, '/').split('/').pop() || 'файл';
    if (bang) {
      if (!isImagePath(ref)) return match;
      const title = label || name;
      return `${SLOT}I${code.push(`<button type="button" class="md-image" data-full="${esc(href)}" data-name="${esc(title)}" data-file="${esc(name)}" aria-label="Увеличить: ${esc(title)}"><img src="${esc(href)}" alt="${esc(label)}" loading="lazy"></button>`) - 1}${SLOT}`;
    }
    return `${SLOT}I${code.push(`<a class="md-file" href="${esc(href)}" download="${esc(name)}">${ICONS.un}<span>${esc(label || name)}</span></a>`) - 1}${SLOT}`;
  });
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

/* ───────── мелочи ───────── */
const ago = ts => {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'сейчас';
  if (d < 3600) return `${Math.floor(d / 60)} мин`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч`;
  if (d < 172800) return 'вчера';
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const hhmm = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const duration = ms => {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const activeMs = run => {
  if (!run) return 0;
  const end = run.status === 'running' ? Date.now() : run.ended_at;
  return Math.max(0, end - run.started_at - (run.waiting_ms || 0) - (run.wait_started_at ? end - run.wait_started_at : 0));
};
function runQuota(run) {
  if (!run) return '';
  let changes = run.quota_delta?.changes ?? [];
  if (!run.quota_end) {
    const before = new Map((run.quota_start?.limits ?? []).map(x => [x.label, x]));
    changes = (metersOf(run.provider)?.limits ?? []).filter(x => before.has(x.label)).map(x => {
      const old = before.get(x.label), reset = old.resets !== x.resets || x.pct < old.pct;
      return { label: x.label, delta: reset ? null : x.pct - old.pct, reset };
    });
  }
  const change = changes.find(x => x.delta) ?? changes[0];
  return change ? (change.reset ? 'квота: сброс' : `квота ~${change.delta > 0 ? '+' : ''}${change.delta ?? 0} п.п.`) : '';
}
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

/* ───────── рейка проектов ───────── */
function badgeOf(p) {
  const cs = chatsOf(p.id).filter(c => !c.archived);
  if (cs.some(c => c.state === 'attention')) return 'attention';
  if (cs.some(c => isRunning(c.id))) return 'running';
  if (cs.some(c => c.unread)) return 'done';
  return '';
}
// У каждого проекта свой спокойный цвет плитки — по имени, стабильно между устройствами.
const PHUES = [32, 200, 265, 150, 340, 12, 185, 45, 230, 300, 120, 0];
function projHue(p) { let x = 0; for (const ch of String(p?.name ?? '')) x = (x * 31 + ch.codePointAt(0)) >>> 0; return PHUES[x % PHUES.length]; }
const ptile = (p, cls = 'ptile') => `<span class="${cls}" style="--h:${projHue(p)}">${esc(p?.glyph || String(p?.name ?? '?').slice(0, 2))}</span>`;
function renderRail() {
  const live = S.projects.filter(p => !p.archived);
  $('#rail').innerHTML = live.map(p => {
    const b = badgeOf(p);
    return `<button class="pbtn" data-p="${p.id}" title="${esc(p.name)} — ${esc(p.short)}" aria-current="${p.id === S.pid}">
      ${esc(p.glyph)}${b ? `<span class="d ${b}"></span>` : ''}</button>`;
  }).join('');
}

/* ───────── список чатов ───────── */
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
// Поиск по названиям чатов всех проектов, с группировкой по проекту; закреплённые — первыми.
function searchHTML(q) {
  const needle = q.toLowerCase();
  const groups = S.projects.filter(p => !p.archived).map(p => [p, chatsOf(p.id)
    .filter(c => c.title.toLowerCase().includes(needle))
    .sort((a, b) => a.archived - b.archived || b.pinned - a.pinned || b.updated_at - a.updated_at).slice(0, 30)])
    .filter(([, list]) => list.length)
    .sort(([a], [b]) => (b.id === S.pid) - (a.id === S.pid));
  if (!groups.length) return `<div class="empty">Чатов с «${esc(q)}» не нашлось.</div>`;
  return groups.map(([p, list]) => `<div class="gh"><b>${esc(p.name)}</b><span class="n">${list.length}</span></div>` + list.map(chatRow).join('')).join('');
}
function renderSide() {
  const p = curProject();
  $('#pname').textContent = p ? p.name : '—';
  $('#ppath').textContent = p ? p.short : '';
  const q = S.chatQuery?.trim();
  $('#clist').innerHTML = q ? searchHTML(q) : p ? chatListHTML(p.id, true) : '<div class="empty">Создай проект — это папка на сервере.</div>';
  $('#btn-newchat').hidden = !p;
  mrefresh();
  $('#btn-pmenu').hidden = !p;
  $('#uname').textContent = S.user?.login ?? '—';
  $('#uav').textContent = (S.user?.login ?? '?')[0];
  $('#umeta').textContent = S.host?.name ?? '';
}

/* ───────── лента ───────── */
// Агенты-исполнители: имя и цвет официальной марки (значки — в /icons/providers).
const AG = { claude: ['Claude', '#d97757'], codex: ['Codex', '#f2f2f3'], kimi: ['Kimi', '#b7b1ff'], gemini: ['Gemini', '#8e75b2'] };
// Собеседник — это роль, а не агент: кем он работает, видно по значку выбранного провайдера.
const compWho = () => S.models?.companion?.who ?? 'codex';
const agName = p => p === 'companion' ? `Собеседник · ${(AG[compWho()] ?? AG.codex)[0]}` : (AG[p] ?? AG.claude)[0];
const agIcon = p => {
  const id = p === 'companion' ? compWho() : p;
  return `<i class="pico" style="--src:url(/icons/providers/${AG[id] ? id : 'claude'}.svg);color:${(AG[id] ?? AG.claude)[1]}"></i>`;
};
// Команды и инструменты в ленте: по умолчанию спрятаны, видно только мой запрос и ответ агента.
// Неудачные команды (.ok.bad) остаются на виду всегда — чтобы ошибка не потерялась.
const showTools = () => (S.prefs?.tools ?? '0') === '1';
const applyFeedPrefs = () => document.body.classList.toggle('notools', !showTools());
// Статус уточнения, переданного на ходу. «Принято» — только по эху самого CLI, не по факту записи в stdin.
const STEER = {
  sent: ['sending', 'передаётся агенту…'],
  accepted: ['ok', '✓ принято агентом'],
  requeued: ['queued', 'не успело — уйдёт следующим ходом'],
};
const steerBadge = st => STEER[st] ? `<span class="steer ${STEER[st][0]}">${STEER[st][1]}</span>` : '';
function patchMessage(d) {
  // команда закончила — одно уведомление на всю задачу (шаги не спамят)
  if (d.json?.task_id && ['done', 'error'].includes(d.json.status)) {
    const c = chatOf(d.chat_id), msg = d.json.status === 'done' ? 'команда закончила задачу' : 'команда остановилась — нужен твой взгляд';
    sysNotify('Depo · ' + msg, c?.title ?? '', d.chat_id);
    const t = toast(`«${c?.title ?? 'чат'}» — ${msg}`, d.json.status === 'done' ? 'ok' : 'warn', 8000);
    t.querySelector('.tx').style.cursor = 'pointer'; t.querySelector('.tx').onclick = () => { t.remove(); selectChat(d.chat_id); };
  }
  for (const list of [S.messages, S.history.get(d.chat_id)]) {
    const m = list?.find(x => x.id === d.id); if (m) m.json = d.json;
  }
  if (d.chat_id !== S.cid) return;
  const atBottom = nearBottom();
  const node = document.querySelector(`#fw [data-mid="${d.id}"]`); if (!node) return;
  if (node.classList.contains('tcard')) { const m = S.messages.find(x => x.id === d.id); if (m) node.replaceWith(teamCard(m)); followFeed(atBottom); return; }
  node.querySelector('.steer')?.remove();
  node.insertAdjacentHTML('beforeend', steerBadge(d.json?.steer));
  followFeed(atBottom);
}
/* ───────── команда агентов: карточка плана в ленте ───────── */
const TEAM_ST = { planning: 'ведущий составляет план…', await: 'план готов — запустить?', running: 'команда работает', done: 'готово', stopped: 'остановлено', error: 'остановилось' };
const teamRole = id => (S.team?.roles ?? []).find(r => r.id === id);
// Кто выполнит роль с учётом выключенных участников — тот же порядок, что team.assignee на сервере
function teamAssignee(cfg, r) {
  const off = cfg?.off ?? [];
  if (!r || !off.includes(r.provider)) return r?.provider ?? 'claude';
  return [...cfg.roles.filter(x => x !== r && x.id !== 'lead'), cfg.roles.find(x => x.id === 'lead'), ...['claude', 'codex', 'kimi'].map(provider => ({ provider }))]
    .find(x => x && !off.includes(x.provider))?.provider ?? r.provider;
}
function teamCard(m) {
  const j = m.json ?? {};
  const dur = s => s.started_at ? duration((s.ended_at || Date.now()) - s.started_at) : '';
  const icon = s => s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'run' ? '' : '';
  const n = el('div', `tcard st-${j.status}`, `
    <div class="th"><span class="tdots"><i class="d1"></i><i class="d2"></i><i class="d3"></i></span><b>Команда агентов</b><span class="ts">${esc(TEAM_ST[j.status] ?? j.status)}</span></div>
    <div class="tsteps">${(j.steps ?? []).map((s, i) => `<div class="tstep ${s.status}${s.fix ? ' fix' : ''}">
      <span class="ti">${icon(s)}</span>
      <span class="tt">${esc(s.title)}<small>${agIcon(s.provider || teamAssignee(S.team, teamRole(s.role)))} ${esc(agName(s.provider || teamAssignee(S.team, teamRole(s.role))))} · ${esc(teamRole(s.role)?.name ?? s.role)}${s.fallback ? ` · вместо ${esc(agName(s.fallback))} (${({ off: 'выключен', ready: 'нет входа' })[s.why] ?? 'лимит'})` : ''}${s.verdict === false ? ' · проверка не прошла' : ''}</small></span>
      <span class="tm">${s.status === 'run' || s.status === 'done' || s.status === 'failed' ? dur(s) : ''}</span></div>`).join('')}</div>
    ${j.error ? `<p class="terr">${esc(j.error)}</p>` : ''}
    <div class="tacts">${j.status === 'await' ? `<button class="btn primary" data-tgo="${j.task_id}">Запустить</button><button class="btn" data-tno="${j.task_id}">Отменить</button><span class="thint">хочешь иначе — просто напиши задачу по-другому</span>`
      : ['planning', 'running'].includes(j.status) ? `<button class="btn" data-tno="${j.task_id}">Остановить команду</button>` : ''}</div>`);
  n.dataset.mid = m.id;
  n.querySelector('[data-tgo]')?.addEventListener('click', e => { e.currentTarget.disabled = true; api(`/api/team/${j.task_id}/start`, { method: 'POST' }).catch(err => toast(err.message)); });
  n.querySelector('[data-tno]')?.addEventListener('click', () => api(`/api/team/${j.task_id}/cancel`, { method: 'POST' }).catch(err => toast(err.message)));
  return n;
}
function msgNode(m, chat, scope) {
  if (m.kind === 'team_plan') return teamCard(m);
  if (m.role === 'user') {
    const atts = m.json?.attachments ?? [];
    const att = atts.length ? `<div class="att">${atts.map(a => a.image && a.url
      ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name)}"></a>`
      : `<span class="f">📎 ${esc(a.name)}</span>`).join('')}</div>` : '';
    const n = el('div', 'turn u', `<div class="who"><span class="av">${esc((S.user?.login ?? 'H')[0].toUpperCase())}</span><b>${esc(S.user?.login ?? 'ты')}</b><span class="t">${hhmm(m.ts)}</span></div><div class="md">${esc(m.text)}${att}</div>${steerBadge(m.json?.steer)}`);
    n.dataset.mid = m.id;
    return n;
  }
  if (m.role === 'assistant' && m.kind === 'text') {
    const c = chat ?? curChat();
    const prov = m.provider ?? c?.provider ?? 'claude';
    const j = m.json ?? {};
    const extra = (j.sources?.length ? `<div class="srcs">основано на: ${esc(j.sources.join(', '))}</div>` : '')
      + (j.draft ? `<div class="draft-act"><button type="button" class="btn" data-use>Вставить в поле ввода</button></div>` : '');
    // план команды уже показан карточкой — сырой JSON шагов в ответе ведущего не дублируем
    const shown = String(m.text || '').replace(/```json\s*\{\s*"steps"[\s\S]*?```/g, '').trim() || 'План составлен — он в карточке команды выше.';
    const n = el('div', `turn a ${prov}`, `<div class="who"><span class="av">${agIcon(prov)}</span><b>${agName(prov)}</b><span class="t">${hhmm(m.ts)}</span><button type="button" class="copy-btn copy-answer" aria-label="Скопировать ответ" title="Скопировать ответ">${ICONS.copy}</button></div><div class="md">${md(shown, projectOf(c?.project_id))}</div>${extra}`);
    n.querySelector('.copy-answer').onclick = e => copyText(m.text, e.currentTarget);
    n.querySelector('[data-use]')?.addEventListener('click', () => {
      const inp = $('#inp'); inp.value = m.text.trim(); autosize(); inp.focus();
      toast('Уточнение в поле ввода — проверь и отправь сам.', 'ok', 3000);
    });
    n.dataset.mid = m.id;
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

// Командный чат: в одном ходе (шаге) агент пишет много коротких реплик — видна только последняя,
// предыдущие сворачиваются в строку «ход шага · N сообщений» прямо над ней. Обычные чаты не трогаем.
function placeMsg(fw, n, m, chat) {
  fw.append(n);
  if (!teamChat(chat) || !m.run_id || m.role !== 'assistant' || m.kind !== 'text' || !n.classList.contains('turn')) return;
  n.dataset.run = m.run_id;
  const prev = [...fw.querySelectorAll(`:scope > .turn.a[data-run="${m.run_id}"]`)].filter(x => x !== n);
  if (!prev.length) return;
  let g = fw.querySelector(`:scope > .tgroup[data-run="${m.run_id}"]`);
  if (!g) {
    g = el('div', 'tgroup', `<button type="button" class="tgroup-sum" aria-expanded="false">${ICONS.tw}<span></span></button><div class="tgroup-body" hidden></div>`);
    g.dataset.run = m.run_id;
    g.querySelector('.tgroup-sum').onclick = e => {
      const atBottom = nearBottom();
      const b = g.querySelector('.tgroup-body'), open = b.hidden;
      clearTimeout(g.closeTimer);
      e.currentTarget.setAttribute('aria-expanded', String(open));
      if (open) { b.hidden = false; requestAnimationFrame(() => { g.classList.add('open'); if (atBottom) scrollFeed(); else updateToBottom(); }); }
      else { g.classList.remove('open'); g.closeTimer = setTimeout(() => { if (!g.classList.contains('open')) b.hidden = true; }, 200); }
    };
  }
  const body = g.querySelector('.tgroup-body');
  for (const x of prev) body.append(x);
  const k = body.children.length;
  g.querySelector('.tgroup-sum span').textContent = `${agName(m.provider ?? chat.provider)} · ход шага · ${plural(k, ['сообщение', 'сообщения', 'сообщений'])}`;
  fw.insertBefore(g, n);
}

const FEED_CHUNK = 200;                    // длинные чаты рисуем окном: сначала только хвост
function renderFeed() {
  const fw = $('#fw');
  fw.innerHTML = '';
  const c = curChat();
  const from = Math.min(S.feedFrom ?? 0, S.messages.length);
  if (from > 0) {
    const b = el('button', 'older', `Раньше: показать ещё ${Math.min(FEED_CHUNK, from)} из ${from}`);
    b.onclick = () => {
      const f = $('#feed');
      S.scrollKeep = { h: f.scrollHeight, t: f.scrollTop };   // подгружаем сверху — позицию держим
      S.feedFrom = Math.max(0, from - FEED_CHUNK);
      renderFeed();
    };
    fw.append(b);
  }
  for (let i = from; i < S.messages.length; i++) { const n = msgNode(S.messages[i], c, fw); if (n) placeMsg(fw, n, S.messages[i], c); }
  S.live = null;
  if (isRunning(S.cid)) ensureLive();
  for (const a of S.approvals) if (a.chat_id === S.cid) showApproval(a);
  S.newBelow = 0; updateToBottom();
  restoreFeed();
}
function appendMessage(m) {
  S.messages.push(m);
  if (S.cid) { S.history.delete(S.cid); S.history.set(S.cid, S.messages.slice()); }
  const atBottom = nearBottom();
  if (m.role === 'assistant' && m.kind === 'text' && S.live) { S.live.remove(); S.live = null; }
  const n = msgNode(m, curChat(), $('#fw'));
  if (n) placeMsg($('#fw'), n, m, curChat());
  if (isRunning(S.cid) && !S.live) ensureLive();
  else if (S.live) $('#fw').append(S.live);
  followFeed(atBottom);
}
function ensureLive() {
  if (S.live) return S.live;
  const prov = stepProvider(curChat());
  S.live = el('div', 'turn a', `<div class="who"><span class="av">${agIcon(prov)}</span><b>${agName(prov)}</b></div><div class="md live-md"><span class="typing"><i></i><i></i><i></i></span></div>`);
  S.live.dataset.buf = '';
  $('#fw').append(S.live);
  return S.live;
}
function onDelta(d) {
  if (d.chat_id !== S.cid) return;
  const atBottom = nearBottom();
  const node = ensureLive();
  if (d.text) {
    node.dataset.buf += d.text;
    node.querySelector('.live-md').innerHTML = md(node.dataset.buf, curProject()) + '<span class="typing"><i></i><i></i><i></i></span>';
    followFeed(atBottom);
  }
}
const nearBottom = () => { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 140; };
const scrollFeed = instant => { const f = $('#feed'); f.scrollTo({ top: f.scrollHeight, behavior: instant ? 'auto' : 'smooth' }); };
const followFeed = atBottom => {
  if (atBottom) scrollFeed();
  else { S.newBelow = (S.newBelow ?? 0) + 1; updateToBottom(); }
};
function updateToBottom() {
  const b = $('#to-bottom'), f = $('#feed');
  if (!b || !f) return;
  const far = f.scrollHeight - f.scrollTop - f.clientHeight > 500;
  b.hidden = !far || f.hidden;
  b.textContent = S.newBelow ? `↓ ${S.newBelow}` : '↓';
}
const rememberChat = id => {
  if (!id) return;
  const f = $('#feed'), inp = $('#inp');
  // запоминаем отступ от низа: он не ломается, когда старые сообщения подгружены окном
  S.chatState.set(id, { fromBottom: f.scrollHeight - f.scrollTop, draft: inp.value });
  persistDrafts();
  const messages = S.messages.slice();
  S.history.delete(id); S.history.set(id, messages);
  while (S.history.size > 8) S.history.delete(S.history.keys().next().value);
};
const restoreFeed = () => {
  const saved = S.chatState.get(S.cid), f = $('#feed');
  requestAnimationFrame(() => {
    if (S.scrollKeep) { f.scrollTop = f.scrollHeight - S.scrollKeep.h + S.scrollKeep.t; S.scrollKeep = null; return; }
    f.scrollTop = f.scrollHeight - Math.min(saved?.fromBottom ?? 0, f.scrollHeight);
  });
};

/* ───────── запросы разрешений ───────── */
function showApproval(a) {
  if (document.querySelector(`.appr[data-id="${CSS.escape(a.id)}"]`)) return;
  const atBottom = nearBottom();
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
  $('#fw').append(n); followFeed(atBottom);
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

/* ───────── шапка и композер ───────── */
// Пока чат не создан, кнопки композера правят черновик — с ним чат и родится
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
// подпись «сколько занято и сколько осталось» — одинаково для обоих агентов
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
// Режим команды: агент текущего (или последнего) шага и его контекст — из хода, а не из чата
const teamChat = c => !!c?.team && !!S.team?.roles?.length;
const stepProvider = c => (teamChat(c) && S.runs?.[c.id]?.provider) || c?.provider || 'claude';
function ctxView(c) {
  const r = teamChat(c) ? S.runs?.[c.id] : null;
  if (!r?.ctx_used) return c;
  return { ...c, ctx_used: r.ctx_used, ctx_window: r.ctx_window || 0, ctx_over: false, ctx_exact: true,
    ctx_pct: r.ctx_window ? Math.min(100, Math.round(r.ctx_used / r.ctx_window * 100)) : null };
}
// Участники команды с входом — по одному разу, в порядке ролей
const teamProviders = () => [...new Set((S.team?.roles ?? []).map(r => r.provider))].filter(p => !S.team?.off?.includes(p) && agents().includes(p));
// Самый занятый из лимитов «5 ч» и «неделя» — его и показываем в компактном чипе
function worstLimit(p) {
  const lim = metersOf(p)?.limits ?? [];
  const pick = [lim.find(l => /5 ч|Сесси/.test(l.label)), lim.find(l => /все модели/.test(l.label)) ?? lim.find(l => /Недел/.test(l.label)), lim.find(l => /Месяц/.test(l.label))].filter(Boolean);
  return pick.sort((a, b) => b.pct - a.pct)[0] ?? null;
}
function renderTeamLimits(chip, c) {
  const step = stepProvider(c), running = isRunning(c.id);
  const one = p => {
    const w = worstLimit(p), all = metersOf(p)?.limits ?? [];
    const tip = `${agName(p)}: ` + (all.length ? all.map(l => `${l.label} — ${l.pct}%, сброс ${l.resets}`).join('; ') : 'нет данных о лимитах');
    return `<span class="g tm${running && p === step ? ' on' : ''}" data-p="${p}" title="${esc(tip)}">${agIcon(p)}`
      + (w ? `<span class="lb"><i class="${lvl(w.pct)}" style="--p:${Math.min(w.pct, 100)}%"></i></span><b>${w.pct}%</b>` : '<b>—</b>') + '</span>';
  };
  const ctx = ctxBar(ctxView(c));
  chip.innerHTML = teamProviders().map(one).join('') + (ctx ? ctx.replace('<span class="k">ctx</span>', `<span class="k">${agIcon(step)}ctx</span>`) : '');
  chip.hidden = !chip.innerHTML;
  chip.title = `Команда: лимиты участников · контекст — ${agName(step)}`;
}
function renderLimits() {
  const chip = $('#chip-gauge'), c = curChat();
  if (teamChat(c)) return renderTeamLimits(chip, c);
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
  chip.hidden = !chip.innerHTML;   // у агента без лимитов и без контекста пустой чип не показываем
  chip.title = `Показатели ${agName(curProvider())} · ${modelName(curProvider(), settingsOf().model)}`;
}
// Для новой работы доступны только агенты с действующим входом.
// Старые чаты отключённого агента остаются в истории, но запустить его нельзя.
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
function teamOnHere() { const c = curChat(); return c ? !!c.team : (S.teamNext ?? !!S.team?.default_on); }
function renderTeamBtn() {
  const b = $('#btn-team'); if (!b) return;
  const on = teamOnHere();
  b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on);
  ['claude', 'codex', 'kimi'].forEach((p, i) => b.querySelector(`.d${i + 1}`)?.classList.toggle('off', !!S.team?.off?.includes(p)));
  b.title = on ? 'Команда включена: ведущий составит план, шаги пойдут по ролям. Нажми — выключить для этого чата' : 'Команда агентов выключена — работает один агент. Нажми — включить для этого чата';
}
function composerBar() {
  renderTeamBtn();
  document.querySelector('.cbar')?.classList.toggle('team', teamOnHere());
  const s2 = settingsOf();
  renderAgentRail();
  const cbtn = $('#btn-gemini');
  cbtn.hidden = false;   // кнопка ассистента нейтральная: кто отвечает — в настройках
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
// Кольцо рядом с моделью: сразу видно, насколько чат забит
function ctxDot() {
  const dot = $('#btn-ctxdot'), c = ctxView(curChat());
  const used = c?.ctx_used ?? 0, win = c?.ctx_window ?? 0;
  // Сумма входных токенов всего хода может быть больше окна: это не заполнение контекста.
  if (!c || !used || c.ctx_over) { dot.hidden = true; return; }
  dot.hidden = false;
  const pct = win ? Math.min(100, c.ctx_pct ?? Math.round(used / win * 100)) : 0;
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
function renderQueue() {
  const box = $('#queue'), items = S.queues?.[S.cid] ?? [];
  box.hidden = !items.length;
  box.innerHTML = items.map(item => `<div class="qitem" data-id="${item.id}"><span class="qst">${item.status === 'sending' ? 'передаётся' : 'в очереди'}</span><span class="qtext">${esc(item.text || '(вложения)')}</span>${item.error ? `<span class="qerr">${esc(item.error)}</span>` : ''}<button class="sbtn" data-edit aria-label="Изменить ожидающее сообщение">✎</button><button class="sbtn" data-delete aria-label="Удалить ожидающее сообщение">×</button></div>`).join('');
  box.querySelectorAll('.qitem').forEach(row => {
    const id = +row.dataset.id, item = items.find(x => x.id === id);
    row.querySelector('[data-edit]').onclick = () => promptBox('Изменить сообщение', 'Оно будет отправлено после текущей задачи.', item.text, 'Сохранить', async value => {
      await api(`/api/queue/${id}`, { method: 'PATCH', body: { text: value } });
    });
    row.querySelector('[data-delete]').onclick = () => api(`/api/queue/${id}`, { method: 'DELETE' }).catch(e => toast(e.message));
  });
}
async function runSummaryDialog() {
  const c = curChat(), current = c && S.runs[c.id];
  if (!current) return toast('Сведений о ходе пока нет.');
  let data;
  try { data = await api(`/api/runs/${current.id}`); } catch (e) { return toast(e.message); }
  const run = data.run, facts = data.facts;
  const quota = run.quota_delta?.changes ?? [];
  modal(`<h3>${esc(run.phase || 'Итог хода')}</h3><p class="sub">${esc(agName(run.provider))} · ${esc(modelName(run.provider, run.model))}</p>
    <div class="runsummary"><div><span>Активная работа</span><b>${duration(run.active_ms)}</b></div><div><span>Общая длительность</span><b>${duration(run.duration_ms)}</b></div>
    <div><span>Токены</span><b>${run.input_t || run.output_t ? `${kt(run.input_t)} вход · ${kt(run.output_t)} выход` : 'провайдер не сообщил'}</b></div></div>
    <div class="gl2">Квота аккаунта · приблизительно</div>${quota.length ? quota.map(x => `<p class="sub">${esc(x.label)}: ${x.reset ? 'был сброс' : `${x.from}% → ${x.to}% (${x.delta > 0 ? '+' : ''}${x.delta} п.п.)`}</p>`).join('') : '<p class="sub">Достоверного изменения нет. Параллельные задачи влияют на общую квоту.</p>'}
    <div class="gl2">Файлы и проверки</div><p class="sub">${facts.files.length ? esc(facts.files.join(', ')) : 'Изменённые файлы в событиях не зафиксированы.'}</p>
    ${facts.tests.length ? facts.tests.map(x => `<p class="sub">${esc(x.command)} — ${esc(x.result || 'результат не подтверждён')}</p>`).join('') : '<p class="sub">Тесты в событиях хода не наблюдались.</p>'}
    ${data.deploy ? `<div class="gl2">Публикация</div><p class="sub">${data.deploy.ok ? 'Успешно' : 'Остановлена'}${data.deploy.rolledBack ? ' · выполнен откат' : ''}</p>` : ''}
    ${run.error ? `<p class="err">${esc(run.error)}</p>` : ''}
    <div class="row"><button class="btn" data-no>Закрыть</button><button class="btn primary" data-diff>Git diff</button></div>`, {
    onOpen(m, close) {
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-diff]').onclick = () => { close(); filesDialog('diff'); };
    },
  });
}
function renderRunState(c = curChat()) {
  if (!c) return;
  const running = isRunning(c.id), run = S.runs[c.id], st = $('#chip-state');
  const quota = runQuota(run);
  // в шапке — только огонёк и время; что именно делает агент — строкой над полем ввода
  $('#state-text').textContent = running ? (run ? duration(activeMs(run)) : 'работает') : STATE_RU[c.state] || c.state;
  const rl = $('#runline');
  rl.hidden = !running;
  if (running) {
    // команда: кто из агентов и какой шаг сейчас
    const tj = S.messages.filter(x => x.kind === 'team_plan').at(-1)?.json;
    const ts = tj && tj.status === 'running' ? tj.steps?.[tj.step] : tj?.status === 'planning' ? { provider: tj.steps?.[0]?.provider, title: 'составляет план' } : null;
    $('#rl-phase').textContent = (ts ? `${agName(ts.provider)} · ${ts.title}` : (run?.phase || 'Работает')) + '…';
    const sec = Math.floor(activeMs(run) / 1000);
    $('#rl-time').textContent = !run ? '' : sec < 60 ? `${sec} с` : sec < 3600 ? `${Math.floor(sec / 60)} мин ${sec % 60} с` : duration(activeMs(run));
  }
  st.title = `${agName(c.provider)} · ${modelName(c.provider, c.model)}${running && run ? ` · ${run.phase || 'работает'} · активное время ${duration(activeMs(run))}` : ''}. Подробности хода`;
  st.setAttribute('aria-label', st.title);
}
function renderHead() {
  $('#runline').hidden = !(S.view !== 'dash' && S.cid && isRunning(S.cid));   // строка хода — только у работающего чата
  renderLimits();
  composerBar();
  renderQueue();
  const c = curChat(), p = curProject();
  const has = !!c;
  const dash = S.view === 'dash';
  document.body.dataset.view = S.view;
  document.body.dataset.chat = !dash && has ? '1' : '0';   // на телефоне с открытым чатом нижняя навигация прячется
  document.querySelectorAll('#bnav [data-nav]').forEach(b => b.setAttribute('aria-current', String(b.dataset.nav === (dash ? 'dash' : 'chat'))));
  $('#dash').hidden = !dash;
  if (dash) {
    $('#feed').hidden = true; $('#cmp').hidden = true; $('#blank').hidden = true; $('#to-bottom').hidden = true;
    $('#pane2').hidden = true;
    $('#chip-state').hidden = true; $('#chip-gauge').hidden = true; $('#chip-files').hidden = true; $('#chip-split').hidden = true;
    $('#ctitle').textContent = 'Главная';
    $('#csub').textContent = [S.host?.name, new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })].filter(Boolean).join(' · ');
    renderRunPill();
    return;
  }
  $('#pane2').hidden = !P2.on;
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
  if (!run) S.sendMode = 'now';
  else if (!S.steering[c.provider]) S.sendMode = 'after';
  const modeBtn = $('#btn-sendmode');
  modeBtn.hidden = !run;
  const team = teamOnHere();
  modeBtn.innerHTML = team
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h11M11 7l5 5-5 5"/></svg>'
    : (S.sendMode === 'after' ? 'После задачи' : 'Передать сейчас');
  const modeName = S.sendMode === 'after' ? 'После задачи' : 'Передать сейчас';
  modeBtn.title = (team ? modeName + ' · ' : '') + (S.steering[c.provider] ? 'Как передать уточнение' : `${agName(c.provider)}: только после текущего хода`);   // в команде кнопка — значок, режим видно в подсказке
  modeBtn.setAttribute('aria-label', team ? 'Режим передачи уточнения' : modeBtn.textContent);
  $('#ctitle').textContent = c.title;
  $('#csub').textContent = `${p.short} · ${plural(c.turns, ['ход', 'хода', 'ходов'])}${c.cost_usd ? ' · $' + c.cost_usd.toFixed(3) : ''}`;
  const st = $('#chip-state');
  st.className = 'chip' + (run ? ' live' : c.state === 'attention' ? ' warn' : '');
  renderRunState(c);
  $('#cb').classList.toggle('run', run);
  $('#csub').textContent += c.origin === 'claude' ? ' · из Claude Code' : '';
  const snd = $('#btn-send');
  snd.classList.toggle('stop', run);
  snd.setAttribute('aria-label', run ? 'Остановить' : 'Отправить');
  snd.innerHTML = run
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $('#inp').placeholder = run ? 'Дополнить запрос на ходу…' : 'Что сделать в этом проекте?';
  renderRunPill();
}
function renderAll() { renderRail(); renderSide(); renderHead(); }

/* ───────── выбор ───────── */
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
  rememberChat(S.cid);
  S.view = 'chat';
  if (id) mmark('chat');
  S.cid = id; S.live = null;
  const cached = S.history.get(id);
  S.messages = cached ? cached.slice() : [];
  S.feedFrom = Math.max(0, S.messages.length - FEED_CHUNK);
  const input = $('#inp');
  input.value = S.chatState.get(id)?.draft ?? '';
  autosize();
  renderAll(); if (cached) renderFeed();
  if (!id) return;
  try {
    // Один запрос на чат; кэш рисуется синхронно, сеть лишь сверяет актуальность.
    const pending = S.loadingChats.get(id) ?? api(`/api/chats/${id}/messages`).finally(() => S.loadingChats.delete(id));
    S.loadingChats.set(id, pending);
    const d = await pending;
    if (S.cid !== id) return;
    const sameFeed = S.messages.length === d.messages.length && (S.messages.at(-1)?.id ?? 0) === (d.messages.at(-1)?.id ?? 0);
    S.messages = d.messages;
    S.history.delete(id); S.history.set(id, d.messages.slice());
    while (S.history.size > 8) S.history.delete(S.history.keys().next().value);
    S.feedFrom = Math.min(S.feedFrom, Math.max(0, d.messages.length - FEED_CHUNK));
    upsertChat({ ...d.chat, unread: false });
    if (d.running && !S.running.includes(id)) S.running.push(id);
    S.queues[id] = d.queue ?? [];
    if (d.run) S.runs[id] = d.run;
    S.steering[d.chat.provider] = d.can_steer;
    S.pid = d.chat.project_id;
    renderAll(); if (!sameFeed) renderFeed();   // кэш совпал с сетью — не дёргаем ленту повторно
    loadChatContext(id);
    prefetchNeighbors(id);
  } catch (e) { toast(e.message); }
  save();
}
// Фоново подтягиваем соседние чаты, чтобы переключение было мгновенным.
// Непрочитанные не трогаем: открытие сбрасывает unread, а это должен делать сам владелец.
function prefetchNeighbors(id) {
  const list = chatsOf(S.pid).filter(c => !c.archived);
  const i = list.findIndex(c => c.id === id);
  const near = [list[i - 1], list[i + 1]].filter(c => c && !c.unread && !S.history.has(c.id) && !S.loadingChats.has(c.id)).slice(0, 2);
  if (!near.length) return;
  (window.requestIdleCallback || (f => setTimeout(f, 300)))(() => {
    for (const c of near) {
      const p = api(`/api/chats/${c.id}/messages`).then(d => {
        S.history.delete(c.id); S.history.set(c.id, d.messages.slice());
        while (S.history.size > 8) S.history.delete(S.history.keys().next().value);
      }).catch(() => { }).finally(() => S.loadingChats.delete(c.id));
      S.loadingChats.set(c.id, p);
    }
  }, { timeout: 2000 });
}
const save = () => { try { localStorage.setItem('depo.sel', JSON.stringify({ pid: S.pid, cid: S.cid, view: S.view })); } catch { } };

/* ───────── главная страница ───────── */
// Дашборд — точка входа. Живёт на том же SSE, что и чаты: никакого своего опроса.
async function openDash() {
  S.view = 'dash';
  mmark('dash');
  $('#pop-ctx').hidden = true;
  renderAll();
  save();
  try {
    S.dash = await api('/api/dashboard');
    if (S.view === 'dash') renderDash();
  } catch (e) { toast(e.message); }
}
// События прилетают часто — сводку перечитываем не чаще, чем раз в полсекунды, и только пока главная открыта.
let dashTimer = null;
function dashRefresh() {
  if (S.view !== 'dash') return;
  clearTimeout(dashTimer);
  dashTimer = setTimeout(async () => {
    try { S.dash = await api('/api/dashboard'); if (S.view === 'dash') renderDash(); } catch { }
  }, 400);
}
async function openDashProject(pid) {
  const p = S.dash?.projects?.find(x => x.id === pid);
  if (isPhone()) { S.pid = pid; save(); return mgo('chats'); }   // на телефоне — сначала чаты проекта
  if (p?.last_chat) await selectChat(p.last_chat.id);
  else await selectProject(pid);
}
function renderDash() {
  const d = S.dash;
  if (!d || S.view !== 'dash') return;
  renderDashActive(d);
  renderDashMeters(d);
  renderDashProjects(d);
  renderDashStats(d);
  renderDashProviders(d);
  renderDashServer(d.server);
}
const gb = n => n == null ? '—' : (n / 2 ** 30).toFixed(n >= 10 * 2 ** 30 ? 0 : 1);
const mb = n => n == null ? '—' : Math.round(n / 2 ** 20);
const upText = s => {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} дн ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
};
function renderDashServer(s = S.dash?.server) {
  const box = $('#dash-server');
  if (!box || S.view !== 'dash') return;
  if (!s) { box.innerHTML = '<div class="dempty">Нет данных о сервере.</div>'; return; }
  // одна сетка на все строки: полосы одной длины, значения по правому краю
  const row = (label, pct, val) => `<b>${label}</b><span class="g ${lvl(pct)}"><i style="width:${Math.min(pct, 100)}%"></i></span><span class="v">${esc(val)}</span>`;
  const line = (label, val) => `<b>${label}</b><span class="v wide">${esc(val)}</span>`;
  const memPct = s.mem_total ? Math.round(s.mem_used / s.mem_total * 100) : 0;
  const diskPct = s.disk_total ? Math.round((s.disk_total - s.disk_free) / s.disk_total * 100) : 0;
  box.innerHTML = `<div class="dcard"><div class="dsys">
    ${row('CPU', s.cpu_pct, `${s.cpu_pct}% · ${s.load} / ${s.cpus} ядра`)}
    ${row('RAM', memPct, `${gb(s.mem_used)} из ${gb(s.mem_total)} ГБ`)}
    ${s.disk_total != null ? row('Диск', diskPct, `свободно ${gb(s.disk_free)} из ${gb(s.disk_total)} ГБ`) : ''}
    ${line('Малина', [s.temp_c != null ? `${s.temp_c}°C` : null, `аптайм ${upText(s.uptime_s)}`].filter(Boolean).join(' · '))}
    ${line('Depo', `работает · ${mb(s.proc.rss)} МБ · ${upText(s.proc.uptime_s)}`)}
  </div></div>`;
}
// редкий опрос состояния машины — только пока открыта главная и вкладка видима
async function loadServerStats() {
  try { const s = await api('/api/server'); if (S.dash) S.dash.server = s; renderDashServer(s); } catch { }
}
function renderDashActive(d = S.dash) {
  const box = $('#dash-active');
  if (!d?.active?.length) {
    const last = d?.projects?.[0];
    box.innerHTML = `<div class="dempty">Нет активных задач — агенты свободны.${last ? `<button class="btn" data-cont="${last.id}">Продолжить: ${esc(last.name)}</button>` : ''}</div>`;
    const b = box.querySelector('[data-cont]');
    if (b) b.onclick = () => openDashProject(+b.dataset.cont);
    return;
  }
  box.innerHTML = `<div class="dgrid">` + d.active.map(a => {
    const run = a.run, waiting = !!a.approval_id || !!run?.wait_started_at;
    return `<button class="dcard${waiting ? ' att' : ''}" data-chat="${a.chat.id}">
      <span class="dh"><span class="av2">${esc(a.glyph)}</span><b>${esc(a.chat.title)}</b>${agIcon(a.chat.provider)}</span>
      <span class="ds">${esc(a.last_action || run?.phase || 'Агент работает')}</span>
      <span class="df"><span>${esc(a.project)} · ${esc(agName(a.chat.provider))}${a.chat.model ? ' · ' + esc(modelName(a.chat.provider, a.chat.model)) : ''}</span><span class="g2"></span>
        ${waiting ? '<span class="tm">нужен ответ</span>' : `<span>${esc(run?.phase ?? '')}</span>`}<span class="tm" data-tick="${a.chat.id}">${run ? duration(activeMs(run)) : ''}</span></span>
    </button>`;
  }).join('') + '</div>';
  box.querySelectorAll('[data-chat]').forEach(b => b.onclick = () => selectChat(b.dataset.chat));
}
// Таймеры активных задач тикают локально из started_at — сервер ради этого не дёргаем.
function tickDash() {
  if (S.view !== 'dash' || !S.dash) return;
  for (const a of S.dash.active ?? []) {
    const n = document.querySelector(`[data-tick="${a.chat.id}"]`);
    if (n && a.run) n.textContent = duration(activeMs(a.run));
  }
}
function renderDashMeters(d = S.dash) {
  if (!d) return;
  $('#dash-meters').innerHTML = ['claude', 'codex', 'kimi', 'gemini'].map(p => {
    const lims = d.meters?.[p]?.limits ?? [];
    const acc = d.providers?.find(x => x.id === p)?.current;
    const rows = lims.map(l => `<div class="lmr"><div class="lb">${esc(l.label)}<span class="p">${l.pct}<small>%</small></span></div>
      <div class="g ${lvl(l.pct)}"><i style="width:${Math.min(l.pct, 100)}%"></i></div>
      <div class="rst" title="использовано ${l.pct}% · свободно ${Math.max(0, 100 - l.pct)}% · сброс ${esc(l.resets)}"><span>осталось ${Math.max(0, 100 - l.pct)}%</span><span class="r">сброс ${esc(String(l.resets).replace(/(\d+ дн\.? \d+ ч) \d+ мин/, '$1'))}</span></div></div>`).join('');
    return `<div class="dcard"><span class="dh">${agIcon(p)}<b>${esc(agName(p))}</b>${acc?.ok ? '' : '<span class="dtag">нужен вход</span>'}</span>
      ${rows ? `<span class="dlm">${rows}</span>` : `<span class="ds">${!acc?.ok ? 'Войди в настройках, чтобы видеть лимиты.' : p === 'gemini' ? 'Подключён. Gemini CLI не сообщает лимиты — их видно только в аккаунте Google.' : 'Данных о лимитах пока нет — появятся после первого хода этого агента.'}</span>`}</div>`;
  }).join('');
}
function renderDashProjects(d = S.dash) {
  if (!d) return;
  $('#dash-projects').innerHTML = (d.projects ?? []).slice(0, 8).map(p => `<button class="dcard" data-proj="${p.id}">
      <span class="dh">${ptile(p, 'av2')}<b>${esc(p.name)}</b>${p.working ? `<span class="dtag on">в работе</span>` : ''}</span>
      <span class="df"><span>${esc(p.last_chat?.provider ? agName(p.last_chat.provider) : '—')}</span><span class="g2"></span><span>${ago(p.activity)}</span></span>
    </button>`).join('');
  const box = $('#dash-projects');
  box.querySelectorAll('[data-proj]').forEach(b => b.onclick = () => openDashProject(+b.dataset.proj));
  $('#dash-allproj').onclick = () => (isPhone() ? mgo('projects') : setSide(true));
}
function renderDashStats(d = S.dash) {
  if (!d) return;
  const s = d.stats ?? {};
  $('#dash-stats').innerHTML = `<div class="dst4">
    <div class="dstat"><b>${s.done_today ?? 0}</b><span>задач завершено сегодня</span></div>
    <div class="dstat"><b>${s.done_week ?? 0}</b><span>задач завершено за 7 дней</span></div>
    <div class="dstat"><b>${duration(s.active_ms_week ?? 0)}</b><span>активная работа агентов за 7 дней</span></div>
    <div class="dstat"><b>${s.projects_week ?? 0}</b><span>${plural(s.projects_week ?? 0, ['проект', 'проекта', 'проектов'])} в работе за 7 дней</span></div></div>
    ${S.connected ? '' : '<div class="dstale" style="margin-top:10px">связь потеряна — данные на момент обрыва</div>'}`;
}
function renderDashProviders(d = S.dash) {
  if (!d) return;
  $('#dash-providers').innerHTML = '<div class="dcard dlist">' + (d.providers ?? []).map(p => {
    const lims = d.meters?.[p.id]?.limits ?? [];
    const worst = Math.max(0, ...lims.map(l => l.pct));
    const st = !p.current?.ok ? ['err', 'Требуется вход']
      : worst >= 95 ? ['warn', 'Лимит почти исчерпан']
        : ['ok', 'Подключён'];   // подробности (почта, тариф) — в настройках
    return `<div class="dprov"><b>${agIcon(p.id)}${esc(agName(p.id))}</b><span>${esc(st[1])}</span><span class="led ${st[0]}"></span></div>`;
  }).join('') + '</div>';
}
// Мини-панель: агент работает, пока ты в другом чате или разделе. На главной не нужна — там и так список.
function renderRunPill() {
  const pill = $('#runpill');
  const others = S.view === 'dash' ? [] : S.running.filter(id => id !== S.cid && isRunning(id));
  if (!others.length) { pill.hidden = true; return; }
  pill.hidden = false;
  if (others.length === 1) {
    const c = chatOf(others[0]), p = c && projectOf(c.project_id), run = S.runs[others[0]];
    const label = c ? `${agName(c.provider)} · ${p?.name ?? ''} — ${c.title}` : 'Задача работает';
    pill.title = `Работает: ${label}. Нажми — открыть`;
    pill.innerHTML = `<span class="led"></span><span class="n">${esc(label)}</span><span class="tm">${run ? duration(activeMs(run)) : ''}</span>`;
  } else {
    pill.title = 'Работают другие задачи — выбрать';
    pill.innerHTML = `<span class="led"></span><span class="n">Работают ещё ${plural(others.length, ['задача', 'задачи', 'задач'])}</span><span class="tm">${others.length}</span>`;
  }
}

/* ───────── отправка ───────── */
async function send(forced, { force = false } = {}) {
  const inp = $('#inp');
  const text = (forced ?? inp.value).trim();
  const p = curProject();
  if (!p) return;
  if (!agents().includes(curProvider())) return toast(`${agName(curProvider())} не подключён. Войди в настройках или выбери другого агента.`, 'err', 7000);
  if (!text && !S.atts.length) { inp.focus(); return; }

  let cid = S.cid;
  if (!cid) {
    try {
      const d = await api('/api/chats', { method: 'POST', body: { project_id: p.id, ...draft(), team: teamOnHere() } });
      upsertChat(d.chat); cid = d.chat.id; S.cid = cid; S.messages = []; resetDraft();
      renderAll(); renderFeed();
    } catch (e) { return toast(e.message); }
  }
  if (S.atts.some(a => !a.done)) return toast('Подожди, вложения ещё грузятся.');
  const oldAtts = S.atts;
  const ready = oldAtts.filter(a => a.done).map(a => a.meta);
  if (!forced) inp.value = '', autosize();
  // отправленное — уже не черновик: иначе при возврате во вкладку старый текст всплывает снова
  const setDraft = t => { S.chatState.set(cid, { ...(S.chatState.get(cid) ?? {}), draft: t }); persistDrafts(); };
  if (!forced) setDraft('');
  S.atts = []; renderAtts();
  try {
    const d = await api(`/api/chats/${cid}/send`, { method: 'POST', body: { text, attachments: ready, mode: S.sendMode, force } });
    if (d.run_id && !S.running.includes(cid)) S.running.push(cid);
    if (d.run) S.runs[cid] = d.run;
    if (d.queued) toast(d.reason || 'Сохранено: отправится после текущей задачи.', 'ok', d.reason ? 6000 : 3500);
    renderHead(); renderSide();
  } catch (e) {
    if (!forced && !inp.value) { inp.value = text; autosize(); setDraft(text); }
    S.atts = [...oldAtts, ...S.atts]; renderAtts();
    const busy = e.data?.busy;
    if (busy) return confirmBox('В проекте уже работает агент', `${e.message} Запустить всё равно или дождаться?`, 'Запустить параллельно',
      () => send(forced, { force: true }), false);
    toast(e.message);
  }
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
function resizeCompose(t) {
  if (t.id === 'inp') return autosize();
  t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px';
}

/* ───────── поток событий ───────── */
function connect() {
  const es = new EventSource('/api/stream');
  // После обрыва сверяемся с сервером: пока связи не было, ходы могли закончиться или начаться,
  // а очередь — уйти. Без этого «Передать сейчас» уходило в чат, который на деле уже стоял.
  let lost = false;
  const onOpen = () => { setOffline(false); if (lost) { lost = false; resync(); } };
  es.addEventListener('open', onOpen);
  es.addEventListener('error', () => { lost = true; setOffline(true); });

  es.addEventListener('message', e => {
    const d = JSON.parse(e.data);
    if (d.chat_id === S.cid) appendMessage(d.message);
    if (P2.on && d.chat_id === P2.cid) { P2.messages.push(d.message); P2.live = ''; renderSecond(); }
    touchChat(d.chat_id);
  });
  es.addEventListener('delta', e => { const d = JSON.parse(e.data); onDelta(d); if (P2.on && d.chat_id === P2.cid && d.text) { P2.live += d.text; renderSecond(); } });
  es.addEventListener('message-patch', e => { const d = JSON.parse(e.data); patchMessage(d); if (P2.on && d.chat_id === P2.cid) renderSecond(); });
  es.addEventListener('voice-text', e => V.onText?.(JSON.parse(e.data)));
  es.addEventListener('assistant-text', e => asstOnText(JSON.parse(e.data)));
  es.addEventListener('team-config', e => { S.team = JSON.parse(e.data).config; renderTeamBtn(); renderLimits(); });
  es.addEventListener('cliupd', () => { if (CU.box?.isConnected) loadCliUpd(); });
  es.addEventListener('models', () => { refreshModels().catch(() => { }); });
  es.addEventListener('run', e => {
    const d = JSON.parse(e.data);
    if (d.run) S.runs[d.chat_id] = d.run;
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
      const teamLive = d.chat_id === S.cid && ['planning', 'await', 'running'].includes(S.messages.filter(x => x.kind === 'team_plan').at(-1)?.json?.status);
      if (d.chat_id !== S.cid && d.status === 'done' && !chatOf(d.chat_id)?.team) notifyDone(d.chat_id);
      if (d.chat_id === S.cid && d.status === 'done' && !teamLive) {
        const t = toast(`Завершено · активная работа ${duration(d.run?.active_ms ?? d.active_ms)}. Подробности`, 'ok', 7000);
        t.querySelector('.tx').onclick = () => { t.remove(); runSummaryDialog(); };
        t.querySelector('.tx').style.cursor = 'pointer';
      }
    }
    if (P2.on && d.chat_id === P2.cid) renderSecond();
    renderAll();
    dashRefresh();
  });
  es.addEventListener('run-progress', e => {
    const d = JSON.parse(e.data); S.runs[d.chat_id] = d.run;
    if (d.chat_id === S.cid) { renderRunState(); if (teamChat(curChat())) { renderLimits(); ctxDot(); } }
    if (P2.on && d.chat_id === P2.cid) renderSecond();
    if (S.view === 'dash' && S.dash) {
      const a = (S.dash.active ?? []).find(x => x.chat.id === d.chat_id);
      if (a) { a.run = d.run; renderDashActive(); }
    }
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
    dashRefresh();
  });
  es.addEventListener('project-removed', e => {
    const { id } = JSON.parse(e.data);
    S.projects = S.projects.filter(p => p.id !== id);
    S.chats = S.chats.filter(c => c.project_id !== id);
    if (S.pid === id) selectProject(S.projects.filter(p => !p.archived)[0]?.id ?? null);
    else renderAll();
    dashRefresh();
  });
  es.addEventListener('meters', e => {
    const d = JSON.parse(e.data);
    S.meters = { ...S.meters, ...d };
    if (S.dash) { S.dash.meters = { ...S.dash.meters, ...d }; renderDashMeters(); renderDashProviders(); }
    renderLimits(); renderRunState(); if (!$('#pop-ctx').hidden) renderCtxPop();
  });
  es.addEventListener('queue', e => { const d = JSON.parse(e.data); S.queues[d.chat_id] = d.items; if (d.chat_id === S.cid) renderQueue(); });
  es.addEventListener('approval', e => { const a = JSON.parse(e.data); S.approvals.push(a); if (a.chat_id === S.cid) showApproval(a); renderAll();
    sysNotify('Depo · нужен ответ', `${chatOf(a.chat_id)?.title ?? ''}: разрешить ${a.tool_name}?`, a.chat_id); });
  es.addEventListener('approval-decided', e => { const d = JSON.parse(e.data); S.approvals = S.approvals.filter(a => a.id !== d.id); document.querySelector(`.appr[data-id="${CSS.escape(d.id)}"]`)?.remove(); });
  es.addEventListener('reload', () => api('/api/state').then(d => { S.chats = d.chats; S.projects = d.projects; renderAll(); dashRefresh(); }).catch(() => { }));
  es.addEventListener('prefs', e => { S.prefs = JSON.parse(e.data).prefs; applyFeedPrefs(); });
  es.addEventListener('models', e => applyModels(JSON.parse(e.data)));
  es.addEventListener('link', e => linkPaint(JSON.parse(e.data)));
  es.addEventListener('chat-appended', e => { const d = JSON.parse(e.data); if (d.chat_id === S.cid) refetchTail(); if (P2.on && d.chat_id === P2.cid) loadSecond(P2.cid); });
  return es;
}
async function resync() {
  try {
    const d = await api('/api/state');
    Object.assign(S, { chats: d.chats, running: d.running, queues: d.queues ?? {}, runs: d.runs ?? {}, steering: d.steering ?? S.steering, approvals: d.approvals ?? [] });
    if (S.cid && S.view !== 'dash') {
      const keep = $('#inp').value;
      await selectChat(S.cid);
      if (keep && !$('#inp').value) { $('#inp').value = keep; autosize(); }
    }
    renderAll();
  } catch { }
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

/* ───────── контекст и лимиты ───────── */
// Окно лимитов командного чата: контекст работающего агента и полные лимиты каждого участника
const limRows = lim => lim.map(l =>
  `<div class="lmr"><div class="lb">${esc(l.label)}<span class="p">${l.pct}<small>%</small></span></div>
    <div class="g ${lvl(l.pct)}"><i style="width:${Math.min(l.pct, 100)}%"></i></div>
    <div class="rs">сброс ${esc(l.resets)}</div></div>`).join('');
function renderTeamPop(pop, c) {
  const step = stepProvider(c), v = ctxView(c), run = isRunning(c.id);
  const used = v?.ctx_used ?? 0, win = v?.ctx_window ?? 0, pct = win ? Math.min(100, Math.round(used / win * 100)) : 0;
  let h = `<div class="ph"><b>Команда · ${plural(teamProviders().length, ['участник', 'участника', 'участников'])}</b><span class="v">${run ? 'работает ' + esc(agName(step)) : 'последним работал ' + esc(agName(step))}</span></div>`;
  h += `<div class="gl2">${agIcon(step)} Контекст · ${esc(agName(step))}</div>`;
  h += !used || v.ctx_over ? `<div class="hint">появится после хода агента</div>`
    : win ? `<div class="lmr"><div class="lb">занято ${kt(used)} из ${kt(win)}<span class="p">${pct}<small>%</small></span></div><div class="g ${lvl(pct)}"><i style="width:${pct}%"></i></div><div class="rs">свободно ${kt(win - used)}</div></div>`
      : `<div class="lmr"><div class="lb">занято ${kt(used)}<span class="p">—</span></div></div>`;
  for (const p of teamProviders()) {
    const m = metersOf(p), lim = m?.limits ?? [];
    const roles = (S.team?.roles ?? []).filter(r => r.provider === p);
    const model = modelName(p, roles[0]?.model || '');
    h += `<div class="gl2 tpop${run && p === step ? ' on' : ''}">${agIcon(p)} ${esc(agName(p))} · ${esc(model)}<span class="v">${esc(roles.map(r => r.name.split(' · ')[0]).join(', '))}${m?.at ? ' · ' + hhmm(m.at) : ''}</span></div>`;
    h += lim.length ? limRows(lim) : `<div class="hint">${p === 'codex' ? 'Codex ещё не отчитывался — появятся после первого хода.' : 'Снимаю данные…'}</div>`;
  }
  h += `<div class="hint">у каждого агента свои лимиты подписки · контекст — у агента текущего шага</div>`;
  pop.innerHTML = h;
}
function renderCtxPop() {
  const pop = $('#pop-ctx'), c = curChat(), prov = curProvider();
  if (teamChat(c)) return renderTeamPop(pop, c);
  const m = metersOf(prov), lim = m?.limits ?? [];
  const name = agName(prov), model = modelName(prov, settingsOf().model);
  const det = c ? S.ctx?.[c.id] : null;                  // точная разбивка этого чата
  const used = det?.used ?? c?.ctx_used ?? 0;
  const win = det?.window ?? c?.ctx_window ?? 0;
  const invalid = !!(det?.over || c?.ctx_over);
  const pct = invalid || !win ? 0 : Math.min(100, Math.round(used / win * 100));
  let h = `<div class="ph"><b>${esc(name)} · ${esc(model)}</b><span class="v">${m?.at ? 'обновлено ' + hhmm(m.at) : '—'}</span></div>`;

  if (invalid) {
    h += `<div class="gl2">Контекст этого чата</div><div class="hint">Старое суммарное значение хода не является заполнением контекстного окна, поэтому оно скрыто.</div>`;
  } else if (used) {
    h += `<div class="gl2">Контекст этого чата</div>`;
    if (win) {
      h += `<div class="lmr"><div class="lb">занято ${kt(used)} из ${kt(win)}<span class="p">${pct}<small>%</small></span></div>
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
    h += `<div class="gl2">Лимиты подписки ${esc(name)} · ${esc(model)}</div>` + limRows(lim);
  } else h += `<div class="gl2">Лимиты</div><div class="hint">${prov === 'codex' ? 'Codex ещё не отчитывался — появятся после первого хода.' : 'Снимаю данные…'}</div>`;

  h += `<div class="hint">${prov === 'codex' ? 'общие лимиты аккаунта · файлы сессий Codex' : prov === 'kimi' ? '/usage Kimi Code · общая квота аккаунта; Highspeed расходует её быстрее' : '/usage и /context стоят ноль токенов'}</div>`;
  pop.innerHTML = h;
}

// Точный контекст запрашиваем только для открытого чата; Codex читает его из своей сессии.
async function loadChatContext(id, { force = false } = {}) {
  const c = chatOf(id);
  if (!c) return;
  if (!force && S.ctx?.[id]) return;
  try {
    const d = await api(`/api/chats/${id}/context`);
    (S.ctx ??= {})[id] = d;
    const i = S.chats.findIndex(x => x.id === id);
    if (i >= 0) Object.assign(S.chats[i], { ctx_used: d.used, ctx_window: d.window, ctx_pct: d.pct, ctx_exact: !!d.exact, ctx_over: !!d.over });
    if (id === S.cid) { renderLimits(); if (!$('#pop-ctx').hidden) renderCtxPop(); }
  } catch { }
}

/* ───────── меню и окна ───────── */
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
  // на телефоне окно — тоже шаг истории: «назад» закрывает его, а не уходит с экрана
  const pushed = isPhone();
  if (pushed) history.pushState({ ...mst(), modal: 1 }, '');
  let closed = false;
  const close = (fromPop = false) => {
    if (closed) return; closed = true;
    scrim.remove(); document.removeEventListener('keydown', onKey);
    if (pushed && fromPop !== true && history.state?.modal) { scrim._skip = true; MS.skipNext = true; history.back(); }
  };
  scrim._close = close;
  const onKey = e => { if (e.key === 'Escape') close(); };
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  onOpen?.(scrim.querySelector('.modal'), close);
  return close;
}
function showProjectImage(src, title, file) {
  if (!src) return;
  modal(`<div class="pview"><div class="phead"><h3>${esc(title || file || 'Изображение')}</h3><button type="button" class="bb" data-no aria-label="Закрыть">✕</button></div>
    <div class="pbody"><img src="${esc(src)}" alt="${esc(title || '')}"></div>
    <div class="row"><a class="btn" href="${esc(src)}" download="${esc(file || '')}">Скачать</a><button type="button" class="btn primary" data-no>Закрыть</button></div></div>`, {
    wide: true,
    onOpen(m, close) {
      m.querySelectorAll('[data-no]').forEach(b => b.onclick = close);
      m.querySelector('[data-no]').focus();
    },
  });
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

// Новый проект: название + где. Где — либо существующая папка («Выбрать»), либо новая папка
// внутри той, что открыта в проводнике. Проводник ходит только по домашнему каталогу.
async function newProjectDialog() {
  const slug = v => v.toLowerCase().trim()
    .replace(/[а-яё]/g, c => ({ а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' }[c] ?? c))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ICON_DIR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7a2 2 0 012-2h3l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/></svg>';
  modal(`<div class="npmodal"><h3>Новый проект</h3><p class="sub">Проект — это папка на сервере. Назови его и выбери, где он будет лежать.</p>
    <label>Название<input type="text" id="np-name" placeholder="Мой проект" autocomplete="off"></label>
    <label class="check"><input type="checkbox" id="np-create" checked> <span id="np-create-t">создать новую папку в открытой ниже</span></label>
    <div class="nppath"><span class="lb">Папка проекта</span><code id="np-path">—</code></div>
    <div class="npbrowse">
      <div class="nphead"><button class="bb" id="np-up" aria-label="Наверх">‹</button><code id="np-cur">~</code></div>
      <div class="nplist" id="np-list"><p class="sub">Загружаю…</p></div>
    </div>
    <p class="err" id="np-err"></p>
    <div class="row"><button class="btn" data-no>Отмена</button><button class="btn primary" data-yes>Создать проект</button></div></div>`, {
    onOpen(m, close) {
      const name = m.querySelector('#np-name'), err = m.querySelector('#np-err'), create = m.querySelector('#np-create');
      const out = m.querySelector('#np-path'), list = m.querySelector('#np-list'), cur = m.querySelector('#np-cur'), up = m.querySelector('#np-up');
      let here = null, picked = null;          // here — открытая папка; picked — выбранная существующая
      const target = () => picked ?? (here && create.checked && slug(name.value) ? here.path.replace(/\/$/, '') + '/' + slug(name.value) : null);
      // показываем коротко, от домашнего каталога — как его отдаёт сервер
      const short = p => !p ? '—' : here && p.startsWith(here.path) ? (here.short.replace(/\/$/, '') + p.slice(here.path.length)) : p;
      const paint = () => {
        const t = target();
        out.textContent = t ? short(t) : create.checked ? 'впиши название' : 'выбери папку в списке';
        m.querySelector('#np-create-t').textContent = here ? `создать новую папку в ${here.short}` : 'создать новую папку';
        m.querySelectorAll('.npdir').forEach(r => r.classList.toggle('on', r.dataset.p === picked));
      };
      const open = async p => {
        try {
          const d = await api('/api/browse?path=' + encodeURIComponent(p));
          here = d; cur.textContent = d.short; up.disabled = !d.parent;
          list.innerHTML = d.dirs.length ? d.dirs.map(x => `<div class="npdir${x.connected ? ' used' : ''}" data-p="${esc(x.path)}">
              <button class="go" data-go="${esc(x.path)}">${ICON_DIR}<span class="nm">${esc(x.name)}</span>${x.marks.length ? `<span class="mk">${esc(x.marks.join(' · '))}</span>` : ''}${x.connected ? '<span class="mk">уже проект</span>' : ''}</button>
              ${x.connected ? '' : `<button class="btn pick" data-pick="${esc(x.path)}" data-n="${esc(x.name)}">Выбрать</button>`}</div>`).join('')
            : '<p class="sub" style="padding:10px">Подпапок нет — можно создать новую здесь.</p>';
          paint();
        } catch (e) { list.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
      };
      list.addEventListener('click', e => {
        const pick = e.target.closest('[data-pick]');
        if (pick) {
          picked = picked === pick.dataset.pick ? null : pick.dataset.pick;
          create.checked = !picked;
          if (picked && !name.value.trim()) name.value = pick.dataset.n;
          return paint();
        }
        const go = e.target.closest('[data-go]');
        if (go) { picked = null; create.checked = true; open(go.dataset.go); }
      });
      up.onclick = () => { if (here?.parent) { picked = null; open(here.parent); } };
      name.oninput = paint;
      create.onchange = () => { if (create.checked) picked = null; paint(); };
      const go = async () => {
        err.textContent = '';
        const t = target();
        if (!name.value.trim()) return void (err.textContent = 'Нужно название проекта.');
        if (!t) return void (err.textContent = 'Выбери папку или поставь галочку «создать новую».');
        try {
          const d = await api('/api/projects', { method: 'POST', body: { name: name.value.trim(), path: t, create: !picked } });
          close();
          await selectProject(d.project.id);
          if (isPhone()) mgo('chats', 'push');
          toast(`Проект «${d.project.name}» подключён${d.created ? ', папка создана' : ''}`, 'ok', 4000);
        } catch (e) { err.textContent = e.message; }
      };
      m.querySelector('[data-no]').onclick = close;
      m.querySelector('[data-yes]').onclick = go;
      name.onkeydown = e => { if (e.key === 'Enter') go(); };
      if (!touchOnly()) name.focus();   // на телефоне клавиатура не выскакивает сама — сначала можно выбрать папку
      open('~');
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

// Разговор, начатый в Claude Code на другой машине, поднимается сюда по кнопке.
// Так постоянное зеркало можно держать выключенным: список чатов не засоряется,
// а нужный разговор продолжается ровно с того места, где его оставили.
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

async function safetyDialog() {
  const p = curProject(); if (!p) return;
  let data;
  try { data = await api(`/api/projects/${p.id}/safety`); } catch (e) { return toast(e.message); }
  const paint = result => {
    const box = document.querySelector('#safety-result'); if (!box) return;
    const rows = [...(result?.checks?.results ?? []), ...(result?.results ?? []), ...(result?.verify ?? [])];
    box.textContent = result ? `${result.ok ? 'Успешно' : 'Остановлено'}${result.stage ? ' · ' + result.stage : ''}${result.rolledBack ? ' · откат выполнен' : ''}\n` + rows.map(x => `${x.ok ? '✓' : '✗'} ${x.name}\n${x.output || x.error || ''}`).join('\n') : '';
  };
  modal(`<h3>Проверки и публикация</h3><p class="sub">Команды выполняются в папке проекта. Публикация всегда заново запускает checks и проверяет артефакты; verify — после релиза. Для release нужны source, releases и current.</p>
    <label>Конфигурация .depo/checks.json<textarea id="safety-config" rows="13" spellcheck="false">${esc(JSON.stringify(data.config, null, 2))}</textarea></label>
    <pre class="safety-result" id="safety-result"></pre><p class="err" id="safety-error"></p>
    <div class="row"><button class="btn" data-no>Закрыть</button><button class="btn" data-save>Сохранить</button><button class="btn" data-check>Проверить</button><button class="btn primary" data-deploy>Опубликовать</button></div>`, {
    wide: true,
    onOpen(m, close) {
      m.querySelector('[data-no]').onclick = close;
      const save = () => api(`/api/projects/${p.id}/safety`, { method: 'PUT', body: { config: JSON.parse(m.querySelector('#safety-config').value) } });
      m.querySelector('[data-save]').onclick = async () => {
        m.querySelector('#safety-error').textContent = '';
        try { await save(); toast('Проверки сохранены', 'ok'); } catch (e) { m.querySelector('#safety-error').textContent = e.message; }
      };
      m.querySelector('[data-check]').onclick = async () => {
        const b = m.querySelector('[data-check]'); b.disabled = true; m.querySelector('#safety-error').textContent = '';
        try { await save(); paint(await api(`/api/projects/${p.id}/checks`, { method: 'POST' })); }
        catch (e) { m.querySelector('#safety-error').textContent = e.message; }
        finally { b.disabled = false; }
      };
      m.querySelector('[data-deploy]').onclick = () => confirmBox('Опубликовать проект?', 'Сначала заново выполняются все проверки. При ошибке verify будет запущен настроенный откат.', 'Опубликовать', async () => {
        try { await save(); const result = await api(`/api/projects/${p.id}/deploy`, { method: 'POST' }); paint(result); toast(result.ok ? 'Публикация завершена' : 'Публикация остановлена', result.ok ? 'ok' : 'err'); }
        catch (e) { toast(e.message, 'err'); }
      }, false);
    },
  });
}

function projectMenu(anchor) {
  const p = curProject(); if (!p) return;
  menu(anchor, [
    { label: p.short },
    { text: 'Переименовать', run: () => promptBox('Переименовать проект', '', p.name, 'Сохранить', v => v && api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: v } })) },
    { text: 'Сменить значок', run: () => promptBox('Значок проекта', 'Одна-две буквы или эмодзи — например 🚀 или SP. Цвет плитки подбирается по названию.', p.glyph, 'Сохранить', v => v && api(`/api/projects/${p.id}`, { method: 'PATCH', body: { glyph: v } })) },
    { text: 'Поднять разговор из Claude Code', hint: 'сессии из терминала и с ноутбука', run: sessionsDialog },
    { text: 'Сохранить копию чатов в папку проекта', hint: 'папка .depo рядом с кодом', run: () => api(`/api/projects/${p.id}/snapshot`, { method: 'POST' }).then(d => toast(d.error ? d.error : `Копия обновлена: файлов ${d.written ?? 0}`, d.error ? 'err' : 'ok', 4000)).catch(e => toast(e.message)) },
    { text: 'Проверки и публикация', hint: 'тесты, целостность сборки, откат', run: safetyDialog },
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
    { text: 'Обновить лимиты', hint: 'перечитать лимиты агентов сейчас', run: refreshMeters },
    '-',
    { text: 'Выйти', run: () => api('/api/logout', { method: 'POST' }).then(() => location.href = '/') },
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
          location.href = '/';
        } catch (e) { m.querySelector('#pe').textContent = e.message; }
      };
    }
  });
}

/* ───────── второй чат рядом ───────── */
const P2 = { cid: null, messages: [], atts: [], live: '', on: false, tab: '1' };
function splitOn(on) {
  if (on && innerWidth <= 760) return;
  P2.on = on;
  $('#pane2').hidden = !on;
  $('#split-tabs').hidden = !on;
  document.querySelector('.main').classList.toggle('split', on);
  document.querySelector('.main').dataset.p2Tab = P2.tab;
  document.querySelectorAll('#split-tabs [data-p2-tab]').forEach(b => b.setAttribute('aria-current', String(b.dataset.p2Tab === P2.tab)));
  $('#chip-split').setAttribute('aria-pressed', on);
  if (on) { renderSecond(); P2.cid ? loadSecond(P2.cid) : pickSecond(); }
}
function pickSecond() {
  const items = S.chats.filter(c => !c.archived && c.id !== S.cid)
    .sort((a, b) => b.updated_at - a.updated_at).slice(0, 14)
    .map(c => ({ text: `${projectOf(c.project_id)?.glyph ?? ''}  ${c.title.slice(0, 40)}`, run: () => loadSecond(c.id) }));
  menu($('#p2-pick'), [{ label: 'Показать рядом' }, { text: 'Новый чат в этом проекте', run: createSecond }, ...items]);
}
async function createSecond() {
  const p = curProject(); if (!p) return;
  try { const d = await api('/api/chats', { method: 'POST', body: { project_id: p.id, ...draft(), team: teamOnHere() } }); upsertChat(d.chat); await loadSecond(d.chat.id); }
  catch (e) { toast(e.message); }
}
async function loadSecond(id) {
  P2.cid = id;
  if (!id) return;
  try {
    const d = await api(`/api/chats/${id}/messages`);
    P2.messages = d.messages; P2.live = ''; upsertChat(d.chat);
    renderSecond();
  } catch (e) { toast(e.message); }
}
const p2Chat = () => chatOf(P2.cid);
const p2Patch = async patch => {
  const c = p2Chat(); if (!c) return;
  try { const d = await api(`/api/chats/${c.id}`, { method: 'PATCH', body: patch }); upsertChat(d.chat); renderSecond(); }
  catch (e) { toast(e.message); }
};
const p2NearBottom = () => { const b = $('#p2-feed'); return b.scrollHeight - b.scrollTop - b.clientHeight < 100; };
function renderSecond() {
  const c = p2Chat();
  $('#p2-pick').textContent = c ? c.title : 'выбрать чат';
  const run = c && isRunning(c.id);
  $('#p2-state').className = 'p2state' + (run ? ' run' : '');
  $('#p2-state').textContent = c ? (run ? 'работает' : STATE_RU[c.state] || '') : '';
  const send = $('#p2-send'); send.classList.toggle('stop', !!run); send.setAttribute('aria-label', run ? 'Остановить' : 'Отправить');
  send.innerHTML = run ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  $('#p2-agent').textContent = c ? agName(c.provider) : 'агент';
  $('#p2-model').textContent = c ? modelName(c.provider, c.model) : 'модель';
  const efforts = c ? effortsFor(c.provider, c.model) : [];
  $('#p2-effort').textContent = c?.effort ? (efforts.find(x => x.id === c.effort)?.name ?? c.effort) : 'скорость';
  renderP2Atts();
  const box = $('#p2-feed');
  const stick = p2NearBottom(), top = box.scrollTop;
  box.innerHTML = '';
  if (!c) { box.append(el('div', 'empty', 'Выбери чат сверху — будешь видеть его, пока работаешь в основном.')); return; }
  for (const m of P2.messages.slice(-80)) { const n = msgNode(m, c, box); if (n) placeMsg(box, n, m, c); }
  if (P2.live || run) box.append(el('div', 'turn a', `<div class="md">${P2.live ? md(P2.live, projectOf(c.project_id)) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>`));
  box.scrollTop = stick ? box.scrollHeight : top;
}
function renderP2Atts() {
  const box = $('#p2-atts'); box.hidden = !P2.atts.length;
  box.innerHTML = P2.atts.map((a, i) => `<span class="a ${a.done ? '' : 'up'}">${a.preview ? `<img src="${a.preview}" alt="">` : '📎'}<span class="n">${esc(a.file.name)}</span><button class="x" data-i="${i}" aria-label="Убрать">${ICONS.x}</button></span>`).join('');
  box.querySelectorAll('.x').forEach(b => b.onclick = () => { P2.atts.splice(+b.dataset.i, 1); renderP2Atts(); });
}
async function addP2Files(list) {
  const c = p2Chat(); if (!c) return toast('Сначала выбери чат справа.');
  await uploadInto(c.id, [...list].filter(f => f?.size), P2.atts, renderP2Atts);
}
$('#chip-split').onclick = () => splitOn(!P2.on);
$('#p2-close').onclick = () => splitOn(false);
$('#p2-pick').onclick = e => { e.stopPropagation(); pickSecond(); };
$('#p2-send').onclick = async () => {
  const t = $('#p2-inp'), text = t.value.trim(), c = p2Chat();
  if (isRunning(P2.cid)) { try { await api(`/api/chats/${P2.cid}/cancel`, { method: 'POST' }); } catch (e) { toast(e.message); } return; }
  if ((!text && !P2.atts.length) || !c) return;
  if (P2.atts.some(a => !a.done)) return toast('Подожди, вложения ещё грузятся.');
  t.value = '';
  const attachments = P2.atts.map(a => a.meta); P2.atts = []; renderP2Atts();
  try { await api(`/api/chats/${P2.cid}/send`, { method: 'POST', body: { text, attachments } }); }
  catch (e) { toast(e.message); }
};
$('#p2-inp').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#p2-send').click(); } };
$('#p2-inp').oninput = e => resizeCompose(e.currentTarget);
$('#p2-attach').onclick = () => $('#p2-file').click();
$('#p2-file').onchange = e => { addP2Files(e.target.files); e.target.value = ''; };
$('#p2-agent').onclick = e => menu(e.currentTarget, [{ label: 'Агент' }, ...agents().map(p => ({ text: agName(p), active: p === p2Chat()?.provider, run: () => p2Patch({ provider: p, model: null, effort: '' }) }))]);
$('#p2-model').onclick = e => { const c = p2Chat(), items = S.models?.[c?.provider]?.items ?? []; menu(e.currentTarget, [{ label: 'Модель' }, ...items.map(m => ({ text: m.name, active: m.id === (c?.model || ''), run: () => p2Patch({ model: m.id || null, effort: '' }) }))]); };
$('#p2-effort').onclick = e => { const c = p2Chat(), list = effortsFor(c?.provider, c?.model); if (!c || !list.length) return; menu(e.currentTarget, [{ label: 'Сколько думать' }, { text: 'По умолчанию', active: !c.effort, run: () => p2Patch({ effort: '' }) }, ...list.map(x => ({ text: x.name, active: c.effort === x.id, run: () => p2Patch({ effort: x.id }) }))]); };
$('#p2-mic').onclick = () => (V.rec ? V.rec.finish() : micToggle($('#p2-inp'), $('#p2-mic')));
$('#split-tabs').onclick = e => { const b = e.target.closest('[data-p2-tab]'); if (!b) return; P2.tab = b.dataset.p2Tab; document.querySelector('.main').dataset.p2Tab = P2.tab; document.querySelectorAll('#split-tabs button').forEach(x => x.setAttribute('aria-current', String(x === b))); };
$('#p2-resize').onpointerdown = e => {
  if (innerWidth < 1024) return;
  const main = document.querySelector('.main'); e.currentTarget.setPointerCapture(e.pointerId);
  const move = x => main.style.setProperty('--p2w', `${Math.max(320, Math.min(innerWidth - x, innerWidth * .65))}px`);
  move(e.clientX); const up = () => { removeEventListener('pointermove', drag); removeEventListener('pointerup', up); };
  const drag = ev => move(ev.clientX); addEventListener('pointermove', drag); addEventListener('pointerup', up, { once: true });
};

/* ───────── вложения ───────── */
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
  if (!cid) {                                   // вложение до первого сообщения — заводим чат
    const p = curProject(); if (!p) return;
    try { const d = await api('/api/chats', { method: 'POST', body: { project_id: p.id, ...draft(), team: teamOnHere() } }); upsertChat(d.chat); S.cid = cid = d.chat.id; S.messages = []; resetDraft(); renderAll(); renderFeed(); }
    catch (e) { return toast(e.message); }
  }
  await uploadInto(cid, files, S.atts, renderAtts);
  $('#inp').focus();
}
// Загрузка вложений в чат — общая для основного поля ввода и второй колонки «Рядом»
async function uploadInto(cid, files, list, redraw) {
  for (const file of files) {
    if (file.size > 32 * 1048576) { toast(`${file.name}: больше 32 МБ, не возьму.`); continue; }
    const a = { file, done: false, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    list.push(a); redraw();
    try {
      const r = await fetch(`/api/chats/${cid}/attach`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name) }, body: file });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Не загрузилось.');
      a.meta = d; a.done = true;
    } catch (e) { toast(`${file.name}: ${e.message}`, 'err'); const i = list.indexOf(a); if (i >= 0) list.splice(i, 1); }
    redraw();
  }
}
$('#btn-attach').onclick = () => $('#file-inp').click();
$('#file-inp').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

const PASTE_LIMIT = 6000;      // длиннее — кладём файлом, иначе съедает всё окно композера
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

/* ───────── перетаскивание проектов на рейке ───────── */
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

/* ───────── файлы проекта ───────── */
const colorDiff = patch => esc(patch).split('\n').map(l =>
  l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? `<span class="hd2">${l}</span>`
    : l.startsWith('@@') ? `<span class="hunk">${l}</span>`
      : l.startsWith('+') ? `<span class="add">${l}</span>`
        : l.startsWith('-') ? `<span class="del">${l}</span>` : l).join('\n');

async function filesDialog(initialTab = 'tree') {
  const p = curProject(); if (!p) return;
  let tab = initialTab === 'diff' ? 'diff' : 'tree', cwd = '.';
  modal(`<div class="fmodal"><h3>Файлы · ${esc(p.name)}</h3><p class="sub">${esc(p.short)}</p>
    <div class="ftabs" role="tablist">
      <button role="tab" data-t="tree" aria-selected="${tab === 'tree'}">Дерево</button>
      <button role="tab" data-t="diff" aria-selected="${tab === 'diff'}">Изменения (git)</button></div>
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

/* ───────── голос: черновик Vosk на лету, чистовик Whisper в конце ───────── */
const V = { available: false, secure: false, rec: null };
const httpsUrl = () => S.https ? `https://${location.hostname}:${S.https}/` : null;
const MIC_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>';

// Движки диктовки. Выбор — на устройство (телефону и ПК удобно разное), в localStorage.
//  local   — Vosk-черновик + Whisper-чистовик на малине; звук никуда не уходит;
//  browser — Web Speech API самого браузера. Ключ не нужен, но в Chrome звук уходит на серверы Google —
//            об этом честно сказано в настройках. Наличие API ещё не значит, что он работает: ошибки
//            (network, not-allowed, language-not-supported) показываются как есть.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceEngine = () => {
  let v = 'local'; try { v = localStorage.getItem('depo.voice') || 'local'; } catch { }
  if (v === 'browser' && SR) return 'browser';
  if (v === 'chatgpt' && window.RTCPeerConnection) return 'chatgpt';
  return 'local';
};
function voiceLatency(ms) {
  V.lastMs = ms;
  try { localStorage.setItem('depo.voice.last', JSON.stringify({ ms, engine: voiceEngine(), at: Date.now() })); } catch { }
}
function voiceNote() {
  let last = null; try { last = JSON.parse(localStorage.getItem('depo.voice.last') || 'null'); } catch { }
  const lat = last ? ` · последняя: текст через ${(last.ms / 1000).toFixed(1)} с после «Готово»` : '';
  const e = voiceEngine();
  return (e === 'browser' ? 'звук распознаёт сервис браузера (в Chrome — Google), на сервер не попадает'
    : e === 'chatgpt' ? 'звук распознаёт голосовой режим ChatGPT под входом Codex, без ключей; если ChatGPT недоступен — сама переключится на сервер'
      : 'звук распознаётся на сервере Depo и никуда не уходит') + lat;
}
async function voiceInit() {
  const b = $('#btn-mic');
  V.secure = !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  try { Object.assign(V, await api('/api/voice/status')); } catch { }
  const eng = voiceEngine(), browser = eng !== 'local';
  b.style.opacity = V.secure && (browser || V.available) ? '' : '.5';
  b.title = !V.secure ? 'Микрофон работает только по HTTPS'
    : eng === 'chatgpt' ? 'Диктовка · голос ChatGPT через Codex'
    : browser ? 'Диктовка · распознавание браузера'
      : !V.available ? 'Движок распознавания не запущен'
        : V.whisper ? `Диктовка · ${V.vosk} + whisper ${V.whisper}` : 'Диктовка · только черновик';
}

// Диктовка голосом ChatGPT через Codex: микрофон уходит по WebRTC прямо в ChatGPT (сессию заводит
// codex app-server на сервере под входом Codex), текст речи приходит событиями. Ответный голос
// модели не воспроизводим — дорожку не подключаем никуда. Отправляет текст владелец сам.
async function gptDictate(inp = $('#inp'), btn = $('#btn-mic')) {
  const box = $('#dictate'), dtext = $('#dtext'), dtime = $('#dtime');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true } }); }
  catch { return void toast('Браузер не дал доступ к микрофону.'); }
  const base = inp.value.trim() ? inp.value.trimEnd() + ' ' : '';
  const pc = new RTCPeerConnection();
  const AC = window.AudioContext || window.webkitAudioContext, ac = new AC();
  const analyser = ac.createAnalyser(); analyser.fftSize = 256; ac.createMediaStreamSource(stream).connect(analyser);
  let sid = null, dead = false, stopAt = 0, text = '';
  const started = Date.now();
  box.hidden = false; btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true');
  dtext.textContent = 'соединяюсь с ChatGPT…'; dtext.classList.add('empty');
  const stopWave = drawWave(analyser, $('#wave'));
  const timer = setInterval(() => {
    const s2 = Math.floor((Date.now() - started) / 1000);
    dtime.textContent = `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`;
  }, 500);
  V.onText = d => { if (d.id !== sid) return; text = d.partial; dtext.textContent = text || 'слушаю…'; dtext.classList.toggle('empty', !text); };
  const teardown = () => {
    if (dead) return; dead = true;
    clearInterval(timer); stopWave(); V.onText = null;
    try { pc.close(); } catch { }
    stream.getTracks().forEach(t => t.stop()); ac.close().catch(() => { });
    box.hidden = true; btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false'); btn.innerHTML = MIC_SVG;
    $('#d-done').disabled = false; $('#d-done').textContent = 'Готово';
    V.rec = null;
  };
  const finish = async () => {
    if (!sid) { teardown(); return; }
    stopAt = Date.now();
    $('#d-done').disabled = true; $('#d-done').textContent = 'Секунду…';
    stream.getTracks().forEach(t => t.stop());
    try { const d = await api('/api/voice/chatgpt/stop', { method: 'POST', body: { id: sid } }); text = d.text || text; voiceLatency(Date.now() - stopAt); }
    catch (e) { toast(e.message, 'err'); }
    teardown();
    if (text) { inp.value = base + text; resizeCompose(inp); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    else toast('Ничего не разобрал — попробуй ещё раз.', 'warn', 4000);
  };
  V.rec = { finish, cancel: () => { if (sid) api('/api/voice/chatgpt/cancel', { method: 'POST', body: { id: sid } }).catch(() => { }); teardown(); } };
  $('#d-done').onclick = finish;
  $('#d-cancel').onclick = V.rec.cancel;
  try {
    stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = e => { e.track.enabled = false; };      // голос ответа модели не нужен
    pc.createDataChannel('oai-events');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2000); });
    const d = await api('/api/voice/chatgpt/start', { method: 'POST', body: { sdp: pc.localDescription.sdp } });
    if (dead) { api('/api/voice/chatgpt/cancel', { method: 'POST', body: { id: d.id } }).catch(() => { }); return; }
    sid = d.id;
    await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    dtext.textContent = 'слушаю…';
  } catch (e) {
    teardown();
    // не оставляем владельца без диктовки: сразу продолжаем на движке сервера
    if (V.available && V.secure) {
      toast('ChatGPT-голос сейчас недоступен (' + e.message + ') — диктую через сервер.', 'warn', 7000);
      V.forceLocal = true;
      try { await micToggle(inp, btn); } finally { V.forceLocal = false; }
    } else toast('Диктовка через ChatGPT не запустилась: ' + e.message, 'err', 9000);
  }
}

// Диктовка средствами браузера: текст попадает в поле ввода, отправляет владелец сам.
function browserDictate(inp = $('#inp'), btn = $('#btn-mic')) {
  const rec = new SR();
  rec.lang = 'ru-RU'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  const box = $('#dictate'), dtext = $('#dtext'), dtime = $('#dtime');
  const base = inp.value.trim() ? inp.value.trimEnd() + ' ' : '';
  let final = '', interim = '', stopAt = 0, cancelled = false, failed = null;
  const show = () => {
    const t = (final + interim).trim();
    dtext.textContent = t || 'слушаю…'; dtext.classList.toggle('empty', !t);
  };
  box.hidden = false; btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true'); show();
  $('#wave').style.visibility = 'hidden';
  const started = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    dtime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  rec.onresult = e => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript.trim() + ' ';
      else interim += r[0].transcript;
    }
    show();
  };
  const ERR = {
    'not-allowed': 'Браузер не дал доступ к микрофону (или распознавание запрещено настройками).',
    'service-not-allowed': 'Браузер запретил распознавание речи на этой странице.',
    network: 'Распознавание браузера не достучалось до своего сервиса — нужна сеть. Можно переключиться на локальный движок в настройках.',
    'language-not-supported': 'Браузер не умеет распознавать русский. Переключись на локальный движок в настройках.',
    'audio-capture': 'Микрофон не найден или занят другим приложением.',
  };
  rec.onerror = e => { if (e.error !== 'no-speech' && e.error !== 'aborted') failed = ERR[e.error] || `Распознавание браузера: ${e.error}`; };
  rec.onend = () => {
    clearInterval(timer);
    box.hidden = true; btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false'); btn.innerHTML = MIC_SVG;
    $('#wave').style.visibility = ''; $('#d-done').disabled = false; $('#d-done').textContent = 'Готово';
    V.rec = null;
    if (cancelled) return;
    const text = (final + interim).trim();
    if (stopAt) voiceLatency(Date.now() - stopAt);
    if (text) { inp.value = base + text; resizeCompose(inp); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    if (failed) toast(failed, 'err', 9000);
    else if (!text) toast('Ничего не разобрал — попробуй ещё раз.', 'warn', 4000);
  };
  V.rec = {
    finish: () => { stopAt = Date.now(); $('#d-done').disabled = true; $('#d-done').textContent = 'Секунду…'; try { rec.stop(); } catch { rec.onend(); } },
    cancel: () => { cancelled = true; try { rec.abort(); } catch { rec.onend(); } },
  };
  $('#d-done').onclick = V.rec.finish;
  $('#d-cancel').onclick = V.rec.cancel;
  try { rec.start(); } catch (e) { failed = 'Распознавание браузера не запустилось: ' + e.message; rec.onend(); }
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

// Float32 любой частоты → Int16 16 кГц
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

async function micToggle(inp = $('#inp'), btn = $('#btn-mic')) {
  if (V.rec) return;
  if (!V.secure) {
    const u = httpsUrl();
    const t = toast(u ? `Браузер даёт микрофон только по HTTPS. Открой ${u} — сертификат для телефона есть на экране входа.` : 'Браузер даёт микрофон только по HTTPS.', 'warn', 12000);
    if (u) { t.querySelector('.tx').style.cursor = 'pointer'; t.querySelector('.tx').onclick = () => location.href = u; }
    return;
  }
  if (voiceEngine() === 'browser') return browserDictate(inp, btn);
  if (voiceEngine() === 'chatgpt' && !V.forceLocal) return gptDictate(inp, btn);
  if (!V.available) return void toast((V.hint || 'Движок распознавания не запущен.') + (SR ? ' Или выбери в настройках распознавание браузера.' : ''), 'warn', 9000);

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

  const box = $('#dictate'), dtext = $('#dtext'), dtime = $('#dtime');
  box.hidden = false; btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true');
  dtext.textContent = 'слушаю…'; dtext.classList.add('empty');
  const put = t => { if (!t) return; inp.value = (inp.value.trim() ? inp.value.trimEnd() + ' ' : '') + t; resizeCompose(inp); inp.scrollTop = inp.scrollHeight; };
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
    const stopAt = Date.now();
    try { const d = await flush(true); if (d?.text) text = d.text; voiceLatency(Date.now() - stopAt); }
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

/* ───────── настройки ───────── */
const qm = t => `<span class="qm" tabindex="0" role="note" aria-label="${esc(t)}">
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.9 5.9a2.1 2.1 0 1 1 2.9 2q-.8.5-.8 1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".95" fill="currentColor"/></svg>
  <span class="tip">${esc(t)}</span></span>`;
/* ───────── разговор с Gemini голосом ───────── */
// Всё без единого ключа API: слушает малина (Vosk + Whisper, как в диктовке), думает Gemini CLI
// под аккаунтом Google, а говорит сам браузер (встроенный синтез речи телефона или Mac).
// Поэтому разговор работает и на телефоне, и с ноутбука, а наружу уходит только текст.
const LV = { on: false, stop: null, busy: false, speaking: null };

const lvSay = (kind, text) => {
  const cap = $('#live-cap');
  if (kind === 'user') cap.innerHTML = `<b>ты:</b> ${esc(text)}`;
  else if (kind === 'gemini') cap.innerHTML = `<b>${esc((AG[compWho()] ?? AG.codex)[0])}:</b> ${esc(text)}`;
  else cap.textContent = text;
};
const lvStatus = t => { $('#live-st').textContent = t; };

// Голос устройства: на телефоне и Mac он уже есть и звучит прилично — ставить синтез на малину незачем.
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

// Одна реплика владельца: пишем, пока он говорит, и останавливаемся на паузе.
// Распознаёт та же связка, что и в диктовке, — ничего нового на малину не ставим.
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

  const level = () => {                       // громкость сейчас — по ней и понимаем, говорит ли он
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
    if (!busy && Date.now() - t0 > 900) {     // черновик по ходу — чтобы было видно, что слышит
      busy = true;
      send(false).then(d => { if (d?.draft) { draft = d.draft; lvSay('user', draft); } }).catch(() => { }).finally(() => { busy = false; });
    }
    if (spoke && quiet >= 1100) break;        // пауза больше секунды — реплика закончилась
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

/* ───────── вход в аккаунт агента (без терминала) ───────── */
// Depo показывает экран CLI как есть и отправляет туда то, что владелец напечатал:
// подсказки у claude/codex меняются от версии к версии, угадывать их — ломаться на каждом обновлении.
const LINKS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi' };
// у кого куда вводится код: у Codex — на странице OpenAI, у Claude и Gemini — обратно сюда
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
      <li id="lk-returnstep"><div class="lkn">3</div><div class="lkc"><b>Если браузер открыл localhost и страница не загрузилась</b><span>скопируй из адресной строки весь адрес и передай его серверу — это завершает OAuth на нём.</span>
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
  // Codex: код вводится НА странице OpenAI. Claude/Gemini: код показывает страница, вставляем обратно.
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
// у Codex код вводится на странице (polling), у Claude и Gemini — возвращается в Depo
const prov_needs_paste = p => p === 'claude' || p === 'gemini';   // codex и kimi вводят код на странице

// ───────── Обновления AI CLI ─────────
// Один раздел на четырёх агентов: версия, что доступно, кнопки и авто. Живёт на событиях cliupd.
const CU = { box: null, st: null };
const CU_ST = {
  updating: ['acc', 'Обновляется…'], pending: ['warn', 'Ждёт'], available: ['acc', 'Есть обновление'], current: ['ok', 'Актуальная'],
  updated: ['ok', 'Обновлено'], failed: ['err', 'Ошибка'], unsupported: ['warn', 'Только вручную'], 'check-failed': ['err', 'Не проверить'],
};
async function loadCliUpd() {
  if (!CU.box?.isConnected) return;
  try { CU.st = await api('/api/cli-updates'); renderCliUpd(); }
  catch (e) { CU.box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderCliUpd() {
  const box = CU.box, st = CU.st;
  if (!box?.isConnected || !st) return;
  const when = ts => ts ? `${new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${hhmm(ts)}` : 'не проверялось';
  const short = p => String(p || '').replace(/^\/home\/[^/]+/, '~');
  const row = a => {
    const [cls, label] = a.updating ? CU_ST.updating : CU_ST[a.status] ?? ['', 'Не проверялось'];
    const where = [a.kind_name !== '—' ? a.kind_name : '', a.wrapper ? `обёртка ${short(a.wrapper)}` : short(a.path)].filter(Boolean).join(' · ');
    const soak = a.newest && a.ready_at ? `свежая ${a.newest} — поставлю после проверки временем, ${when(a.ready_at)}` : '';
    const msg = a.updating ? '' : a.status === 'pending' && a.deferred ? `Ждёт, пока агент освободится: ${a.deferred}.`
      : a.auto_rolled && a.status !== 'updated' ? `Автооткат: новая версия ломала ходы — вернул ${a.current}.`
      : a.error ? a.error + (a.action ? ` Что сделать: ${a.action}` : '') : soak || a.note || '';
    return `<div class="cu-row" data-id="${a.id}">
      <div class="cu-a">${agIcon(a.id)}<span class="c"><b>${esc(a.name)}</b><span title="${esc(where)}">${esc(a.current ?? 'не найден')}${a.available ? ` → ${esc(a.latest)}` : ''}</span></span></div>
      <div class="cu-s"><span class="cu-st ${cls}">${a.updating ? '<i class="spin"></i>' : ''}${esc(a.status === 'updated' && a.current ? `Обновлено до ${a.current}` : label)}</span></div>
      <div class="cu-b">
        ${a.available || a.status === 'pending' ? `<button class="btn primary" data-cu-up="${a.id}" ${st.busy ? 'disabled' : ''}>Обновить сейчас</button>` : ''}
        ${a.prev && a.status === 'updated' ? `<button class="btn" data-cu-back="${a.id}" ${st.busy ? 'disabled' : ''} title="Вернуть ${esc(a.prev)}">Откатить</button>` : ''}
      </div>
      ${msg ? `<p class="cu-msg ${a.status === 'failed' || a.status === 'check-failed' ? 'err' : ''}">${esc(msg)}</p>` : ''}
    </div>`;
  };
  const allAuto = st.agents.every(a => a.auto !== false);
  box.innerHTML = `<div class="gl2">Обновления AI${qm('Depo раз в сутки сам проверяет Claude Code, Codex, Kimi Code и Gemini CLI и ставит только проверенные версии: Claude — из стабильного канала, npm-пакеты — не раньше чем через двое суток после выхода (сырые релизы за это время обычно отзывают). Пока агент работает — ждёт. После установки проверяет, что новая версия запускается и вход на месте, иначе сразу откатывает. А если в первые двое суток новая версия начнёт ронять ходы — откатит сама и пришлёт уведомление.')}</div>
    <div class="srow"><div class="c"><b>Обновлять автоматически</b><span>${st.scheduler ? `проверка раз в сутки · последняя ${esc(when(st.last_auto))}` : 'в этом экземпляре Depo расписание выключено'}</span></div>
      <div class="ctl"><button class="btn" id="cu-all" ${st.busy ? 'disabled' : ''}>Проверить всё</button><button class="sw2" role="switch" id="cu-auto-all" aria-checked="${allAuto}" aria-label="Обновлять автоматически"></button></div></div>
    <div class="cu-list">${st.agents.map(row).join('')}</div>
    <details class="cu-log"><summary>Журнал обновлений</summary>
    <div class="logbox">${st.log?.length ? st.log.map(l => `<div class="l ${esc(l.level)}"><span class="t">${esc(when(l.ts))}</span><span>${esc(l.text)}</span></div>`).join('') : '<div class="l">пока пусто</div>'}</div></details>`;
  const act = async (btn, fn) => {
    btn.disabled = true; const t = btn.textContent; btn.textContent = '…';
    try { await fn(); } catch (e) { toast(e.message, 'err', 7000); } finally { btn.textContent = t; await loadCliUpd(); }
  };
  box.querySelector('#cu-all').onclick = e => act(e.currentTarget, () => api('/api/cli-updates/check', { method: 'POST', body: {} }));
  box.querySelector('#cu-auto-all').onclick = async e => {
    const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    e.currentTarget.setAttribute('aria-checked', on);
    try { for (const a of st.agents) await api(`/api/cli-updates/${a.id}/auto`, { method: 'POST', body: { on } }); } catch (e2) { toast(e2.message); }
    loadCliUpd();
  };
  box.querySelectorAll('[data-cu-up]').forEach(b => b.onclick = () => act(b, async () => {
    const r = await api(`/api/cli-updates/${b.dataset.cuUp}/update`, { method: 'POST', body: {} });
    const x = r.result ?? {};
    if (x.status === 'pending') toast(`Отложено: ${x.message}`, 'warn', 6000);
    else if (x.status === 'failed') toast(x.message, 'err', 9000);
    else if (x.status === 'queued') toast(x.message, 'warn', 5000);
  }));
  box.querySelectorAll('[data-cu-back]').forEach(b => b.onclick = () => {
    const a = st.agents.find(x => x.id === b.dataset.cuBack);
    confirmBox(`Откатить ${a.name} на ${a.prev}?`, `Сейчас стоит ${a.current}. Версию ${a.current} Depo сам больше ставить не будет — только вручную.`, 'Откатить',
      () => act(b, () => api(`/api/cli-updates/${a.id}/rollback`, { method: 'POST', body: {} })));
  });
}

/* ───────── аккаунты агентов: почта, лимиты, несколько аккаунтов ───────── */
const ACC_TITLES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi' };
// Лимиты в настройках — как везде в Depo: сколько ИЗРАСХОДОВАНО; полоска растёт и краснеет у края.
const limName = l => l.label.replace(/^Сессия · /, '').replace('Неделя · все модели', 'неделя').replace(/^Неделя/, 'неделя').replace(/^Месяц/, 'месяц');
const limBars = (limits, { resets = true } = {}) => (limits ?? []).map(l => {
  const used = Math.max(0, Math.min(100, Math.round(l.pct)));
  return `<span class="alim${used >= 90 ? ' low' : used >= 70 ? ' mid' : ''}" title="${esc(l.label)}: израсходовано ${used}%${l.resets ? ', сброс ' + esc(l.resets) : ''}">
    <span class="lb">${esc(limName(l))}</span><i style="--w:${used}%"></i><b>${used}%</b>${resets && l.resets ? `<em>сброс ${esc(l.resets)}</em>` : ''}</span>`;
}).join('');
function accCard(prov, title, hint, a) {
  const cur = a.current ?? {}, on = !!cur.ok;
  const who = cur.email || cur.name || (typeof cur.ok === 'string' ? cur.ok : '');
  const plan = cur.plan && cur.plan !== 'подписка' ? cur.plan : '';
  const others = (a.profiles ?? []).filter(p => !p.active);
  const lim = on && a.meters?.limits?.length ? `<div class="alims"><span class="alh">израсходовано</span>${limBars(a.meters.limits)}</div>` : '';
  return `<div class="c"><b>${agIcon(prov)}${title}${qm(hint)}</b>
      <span class="aw">${on ? `<span class="led on"></span>${esc(who || 'подключён')}${plan ? ` · <span class="apl">${esc(plan)}</span>` : ''}` : '<span class="led"></span>не подключён'}</span>
      ${lim}
      ${others.length ? `<div class="aprofs">${others.map(p => `<div class="aprof">
        <span class="ae">${esc(p.email || p.label || p.name)}${p.plan ? ` · ${esc(p.plan)}` : ''}</span>
        ${p.meters?.limits?.length ? `<span class="alims sm" title="израсходовано — последние известные цифры">${limBars(p.meters.limits, { resets: false })}</span>` : ''}
        <button class="btn" data-acc-use="${prov}" data-name="${esc(p.id)}">Переключиться</button>
        <button class="bb" data-acc-forget="${prov}" data-name="${esc(p.id)}" aria-label="Забыть аккаунт ${esc(p.email || p.id)}" title="Забыть">✕</button></div>`).join('')}</div>` : ''}
    </div>
    <div class="ctl">${on
      ? `<button class="btn" data-acc-add="${prov}">Добавить аккаунт</button><button class="btn danger" data-acc-logout="${prov}">Выйти</button>`
      : `<button class="btn primary" data-acc-link="${prov}">Подключить</button>`}</div>`;
}
function accRedraw(m, acc) {
  m.querySelectorAll('[data-acc]').forEach(card => {
    const prov = card.dataset.acc;
    const hint = card.querySelector('.qm')?.getAttribute('aria-label') ?? '';
    card.innerHTML = accCard(prov, ACC_TITLES[prov], hint, acc[prov] ?? {});
  });
}
async function accClick(e, m, close) {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.accLink) { close(); return linkDialog(d.accLink); }
  if (d.accUse) {
    const prov = d.accUse, card = b.closest('[data-acc]');
    card.classList.add('busy'); b.disabled = true; b.textContent = 'Переключаю…';
    try {
      const r = await api(`/api/accounts/${prov}/use`, { method: 'POST', body: { name: d.name } });
      if (r.meters) S.meters = { ...S.meters, [prov]: r.meters };
      accRedraw(m, r.accounts); await refreshModels(); renderLimits();
      toast(`${agName(prov)}: теперь ${r.email || r.name}`, 'ok', 4000);
    } catch (e2) { toast(e2.message, 'err', 7000); b.disabled = false; b.textContent = 'Переключиться'; }
    finally { card.classList.remove('busy'); }
    return;
  }
  if (d.accForget) return confirmBox('Забыть аккаунт?', `Сохранённый вход ${d.name} удалится из Depo. Сам аккаунт не трогаем.`, 'Забыть', async () => {
    try { await api(`/api/accounts/${d.accForget}/forget`, { method: 'POST', body: { name: d.name } }); accRedraw(m, await api('/api/accounts')); }
    catch (e2) { toast(e2.message, 'err'); }
  });
  if (d.accAdd) {
    const prov = d.accAdd;
    return confirmBox(`Ещё один аккаунт ${agName(prov)}`, 'Текущий вход сохранится в списке — вернуться к нему можно одной кнопкой. Дальше обычный вход через браузер.', 'Продолжить', async () => {
      try { await api(`/api/accounts/${prov}/add`, { method: 'POST' }); await refreshModels(); close(); linkDialog(prov); }
      catch (e2) { toast(e2.message, 'err', 7000); }
    }, false);
  }
  if (d.accLogout) {
    const prov = d.accLogout;
    return confirmBox(`Выйти из ${agName(prov)}?`,
      'Агент отзовёт вход этого аккаунта, и он пропадёт из списка. Другие сохранённые аккаунты и чаты останутся.',
      'Выйти', async () => {
        try {
          await api(`/api/accounts/${prov}/logout`, { method: 'POST' });
          await refreshModels(); accRedraw(m, await api('/api/accounts'));
          toast(`${agName(prov)}: выход выполнен`, 'ok', 4000);
        } catch (e2) { toast(e2.message, 'err', 7000); }
      });
  }
}

/* ───────── настройки команды агентов ───────── */
function teamSettings(box) {
  if (!box) return;
  let cfg = JSON.parse(JSON.stringify(S.team ?? { roles: [] }));
  const provs = ['claude', 'codex', 'kimi'];
  cfg.off ??= [];
  const assignee = r => teamAssignee(cfg, r);
  const memberRows = () => provs.map(p => {
    const on = !cfg.off.includes(p), connected = agents().includes(p), last = on && provs.filter(x => !cfg.off.includes(x)).length === 1;
    return `<div class="tmember${on ? '' : ' off'}${connected ? '' : ' unavailable'}"><span class="tmwho">${agIcon(p)}<span><b>${esc(agName(p))}</b><small>${connected ? (on ? 'участвует' : 'не участвует') : 'не подключён'}</small></span></span><button class="sw2" data-member="${p}" role="switch" aria-checked="${on}" ${last ? 'disabled title="Нужен хотя бы один участник"' : ''}></button></div>`;
  }).join('');
  const handoff = () => cfg.roles.filter(r => cfg.off.includes(r.provider)).map(r => `${esc(r.name)} → ${esc(agName(assignee(r)))}`).join(' · ');
  const modelOpts = r => `<option value="">По умолчанию</option>` + (S.models?.[r.provider]?.items ?? []).filter(x => x.id).map(x => `<option value="${esc(x.id)}" ${x.id === r.model ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const effortOpts = r => { const list = effortsFor(r.provider, r.model); return list.length ? `<option value="">Раздумья: по умолчанию</option>` + list.map(x => `<option value="${esc(x.id)}" ${x.id === r.effort ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : ''; };
  const kimiCatalogMissing = r => r.provider === 'kimi' && S.models?.kimi?.source === 'fallback';
  const modelFields = r => kimiCatalogMissing(r)
    ? `<div class="tcatalog" role="status">Каталог Kimi не загружен — проверь вход.<button class="btn" type="button" data-refresh-kimi>Обновить</button></div>`
    : `<label>Модель<select data-f="model">${modelOpts(r)}</select></label>${effortOpts(r) ? `<label>Раздумья<select data-f="effort">${effortOpts(r)}</select></label>` : ''}`;
  const sw = (id, on) => `<button class="sw2" data-tsw="${id}" role="switch" aria-checked="${!!on}"></button>`;
  const draw = () => {
    box.innerHTML = `
      <div class="gl2">Команда агентов${qm('Одна задача — несколько агентов по ролям. Ведущий сначала составляет план (только читает), потом шаги выполняют агенты своих ролей ПО ОЧЕРЕДИ в папке проекта, передавая друг другу контекст. Включается в любом чате кнопкой «Команда» у поля ввода — и в новом, и в уже идущем.')}</div>
      <div class="srow"><div class="c"><b>Включать в новых чатах</b><span>в любом чате переключается кнопкой «Команда» у поля ввода</span></div><div class="ctl">${sw('default_on', cfg.default_on)}</div></div>
      <div class="gl2">Участники</div><div class="tmembers">${memberRows()}</div>
      <p class="thint tmemberhint">${handoff() || 'Все роли выполняют назначенные им агенты.'}</p>
      <div class="gl2">Роли</div>
      <div class="troles">${cfg.roles.map((r, i) => `<div class="trole" data-i="${i}">
        <div class="trh"><input class="tname" value="${esc(r.name)}" placeholder="Название роли" ${r.id === 'lead' ? 'title="Ведущий: составляет план и делает ревью"' : ''}>
          <div class="trb">${i > 0 ? `<button class="bb" data-up="${i}" title="Выше">↑</button>` : ''}${i < cfg.roles.length - 1 ? `<button class="bb" data-down="${i}" title="Ниже">↓</button>` : ''}${r.id !== 'lead' ? `<button class="bb" data-del="${i}" title="Удалить роль">✕</button>` : '<span class="tlead">ведущий</span>'}</div></div>
        <input class="tdesc" value="${esc(r.desc)}" placeholder="За что отвечает">
        <div class="trsel"><label>Агент<select data-f="provider">${provs.map(p2 => `<option value="${p2}" ${p2 === r.provider ? 'selected' : ''} ${agents().includes(p2) ? '' : 'disabled'}>${esc(agName(p2))}${agents().includes(p2) ? '' : ' — не подключён'}</option>`).join('')}</select></label>
          ${modelFields(r)}</div>
        ${cfg.off.includes(r.provider) ? `<p class="tassign">Сейчас выполняет ${esc(agName(assignee(r)))}</p>` : ''}
        <label class="tins">Указания для роли<textarea maxlength="2000" placeholder="Особые правила, стиль работы, ограничения…">${esc(r.instructions ?? '')}</textarea></label>
        <input class="tkw" value="${esc(r.keywords.join(', '))}" placeholder="ключевые слова через запятую — для подсказки">
      </div>`).join('')}
      ${cfg.roles.length < 8 ? '<button class="btn" id="t-add">＋ Добавить роль</button>' : ''}</div>
      <p class="sub" style="margin:8px 0 0">Порядок ролей — это порядок работы, если ведущий не решит иначе. Ведущий всегда планирует и в конце делает ревью.</p>
      <div class="gl2">Страховка</div>
      <div class="srow"><div class="c"><b>Показывать план до запуска</b><span>ты утверждаешь шаги — потом агенты работают сами</span></div><div class="ctl">${sw('approve', cfg.approve)}</div></div>
      <div class="srow"><div class="c"><b>Подмена при лимите</b><span>лимит агента больше 90% — его шаг берёт другой агент команды</span></div><div class="ctl">${sw('fallback', cfg.fallback)}</div></div>
      <div class="srow"><div class="c"><b>Упала проверка — вернуть исполнителю</b><span>сколько кругов исправлений, потом вопрос тебе</span></div>
        <div class="ctl"><select id="t-retries">${[0, 1, 2, 3].map(n => `<option value="${n}" ${n === cfg.retries ? 'selected' : ''}>${n === 0 ? 'не возвращать' : n + ' раз(а)'}</option>`).join('')}</select></div></div>
      <div class="srow"><div class="c"><b>Шагов в плане не больше</b><span>бюджет задачи</span></div>
        <div class="ctl"><select id="t-max">${[3, 5, 8, 12].map(n => `<option value="${n}" ${n === cfg.max_steps ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="t-save">Сохранить команду</button></div>`;
  };
  const read = () => {
    box.querySelectorAll('.trole').forEach(n => {
      const r = cfg.roles[+n.dataset.i];
      r.name = n.querySelector('.tname').value; r.desc = n.querySelector('.tdesc').value;
      r.instructions = n.querySelector('.tins textarea').value;
      r.keywords = n.querySelector('.tkw').value.split(',').map(x => x.trim()).filter(Boolean);
      n.querySelectorAll('select[data-f]').forEach(sel => { r[sel.dataset.f] = sel.value; });
    });
    cfg.retries = +box.querySelector('#t-retries').value; cfg.max_steps = +box.querySelector('#t-max').value;
  };
  draw();
  box.addEventListener('change', e => {
    const sel = e.target.closest('select[data-f]');
    if (sel && sel.dataset.f !== 'effort') { read(); const r = cfg.roles[+sel.closest('.trole').dataset.i]; if (sel.dataset.f === 'provider') { r.model = ''; r.effort = ''; } else r.effort = ''; draw(); }
  });
  box.addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.member) {
      read(); const p = t.dataset.member, on = !cfg.off.includes(p);
      if (on && provs.filter(x => !cfg.off.includes(x)).length === 1) return toast('Нужен хотя бы один участник команды.');
      cfg.off = on ? [...cfg.off, p] : cfg.off.filter(x => x !== p); return draw();
    }
    if (t.dataset.tsw) { read(); cfg[t.dataset.tsw] = t.getAttribute('aria-checked') !== 'true'; return draw(); }
    if (t.dataset.up || t.dataset.down) { read(); const i = +(t.dataset.up ?? t.dataset.down), j = t.dataset.up ? i - 1 : i + 1; [cfg.roles[i], cfg.roles[j]] = [cfg.roles[j], cfg.roles[i]]; return draw(); }
    if (t.dataset.del) { read(); cfg.roles.splice(+t.dataset.del, 1); return draw(); }
    if (t.dataset.refreshKimi !== undefined) {
      read(); t.disabled = true;
      try { applyModels(await api('/api/models?refresh=1')); draw(); }
      catch (err) { toast(err.message, 'err'); t.disabled = false; }
      return;
    }
    if (t.id === 't-add') { read(); cfg.roles.push({ id: 'role-' + Date.now().toString(36), name: 'Новая роль', desc: '', keywords: [], provider: agents()[0] ?? 'claude', model: '', effort: '', instructions: '' }); return draw(); }
    if (t.id === 't-save') {
      read();
      try { const d = await api('/api/team/config', { method: 'POST', body: cfg }); S.team = cfg = d.config; draw(); renderTeamBtn(); toast('Команда сохранена', 'ok', 2500); }
      catch (err) { toast(err.message, 'err'); }
    }
  });
}

/* ───────── доступ через проводник ───────── */
async function loadRemote(box) {
  if (!box) return;
  let d; try { d = await api('/api/remote'); } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  box.innerHTML = `
    <div class="srow"><div class="c"><b>Удалённый доступ</b><span>${d.enabled ? 'включён' : 'выключен — извне Depo не пускает, только через NetBird'}${d.via ? ' · ты сейчас зашёл через проводник' : ''}</span></div>
      <div class="ctl"><button class="sw2" id="rm-on" role="switch" aria-checked="${d.enabled}" aria-label="Удалённый доступ"></button></div></div>
    ${d.locked_at && !d.enabled ? `<p class="err" style="margin:6px 0">🛡 Выключен автоматически ${esc(new Date(d.locked_at).toLocaleString('ru-RU'))}: снаружи трижды ввели неверный пароль. Включишь снова — счётчик начнётся с нуля.</p>` : ''}
    <div class="rm-state">
      <div class="rm-ck ${d.relay?.status === 'Connected' ? 'ok' : d.relay ? '' : 'bad'}">${d.relay ? `${d.relay.status === 'Connected' ? '✓' : '•'} проводник ${esc(d.relay.fqdn)} (${esc(d.relay.ip)}) — ${d.relay.status === 'Connected' ? 'на связи' : 'не на связи'}` : '✕ проводник в NetBird не найден (узел depo-relay)'}</div>
      ${d.relay_ip ? `<div class="rm-ck">• по IP: <code>https://${esc(d.relay_ip)}:${d.https_port}</code></div>` : ''}
      ${d.domain ? `<div class="rm-ck">• по домену: <code>https://${esc(d.domain)}</code></div>` : ''}
    </div>
    <div class="srow"><div class="c"><b>Домен</b><span>необязательно; A-запись домена — на IP проводника</span></div>
      <div class="ctl"><input type="text" id="rm-domain" value="${esc(d.domain)}" placeholder="depo.example.ru" autocomplete="off" spellcheck="false"></div></div>
    <div class="srow"><div class="c"><b>IP проводника</b><span>публичный адрес арендованного сервера; поменял сервер — поменяй здесь</span></div>
      <div class="ctl"><input type="text" id="rm-ip" value="${esc(d.relay_ip)}" placeholder="203.0.113.10" inputmode="decimal" autocomplete="off"></div></div>
    <div class="srow"><div class="c"><b>Секретный адрес входа${qm('Снаружи по домену открывается обычный сайт про вагонное депо — без намёка на Depo. Вход — только по этому адресу. Никому его не показывай. Внутри (NetBird, дом) вход как обычно.')}</b><span>${d.domain ? `https://${esc(d.domain)}` : 'https://домен'}<b style="color:var(--accent)">${esc(d.login_path)}</b></span></div>
      <div class="ctl"><input type="text" id="rm-lp" value="${esc(d.login_path)}" autocomplete="off" spellcheck="false"></div></div>
    <div class="srow"><div class="c"><b>Неверных паролей до отключения</b><span>столько ошибок снаружи — и доступ выключается сам, остаётся NetBird</span></div>
      <div class="ctl"><select id="rm-mf">${[1, 2, 3].map(n => `<option value="${n}" ${n === d.max_fails ? 'selected' : ''}>${n === 1 ? 'сразу после первой' : n}</option>`).join('')}</select></div></div>
    <div class="row rm-acts"><button class="btn" id="rm-save">Сохранить</button><button class="btn" id="rm-check" ${d.domain || d.relay_ip ? '' : 'disabled'}>Проверить снаружи</button></div>
    <div id="rm-res"></div>
    <details class="rm-howto"><summary>Как поднять проводник</summary>
      <ol class="rm-steps">
        <li>В NetBird (app.netbird.io → Setup Keys) создай ключ для сервера-проводника.</li>
        <li>На сервере: папка <code>/opt/depo-relay</code>, в ней <code>docker-compose.yml</code> ниже и <code>.env</code> со строкой <code>NB_SETUP_KEY=…</code>, затем <code>docker compose up -d</code>. Адрес этой машины в NetBird подставлен: <code>${esc(d.netbird_ip || 'не найден — NetBird не запущен?')}</code>. После перезагрузки сервера всё поднимается само.</li>
        <li>Уже работает вход по IP: <code>https://IP:${d.https_port}</code> — тем же сертификатом, что и дома.</li>
        <li>Для домена: A-запись на IP сервера; в Nginx Proxy Manager — Add Proxy Host → домен, Forward <code>http://172.18.0.1:14620</code> (шлюз docker-сети прокси), Websockets Support, SSL — Let's Encrypt и Force SSL, в Advanced <code>proxy_buffering off; proxy_read_timeout 1h;</code>.</li>
        <li>Здесь: впиши IP (и домен), «Проверить снаружи», включи доступ.</li>
      </ol>
      <pre class="rm-compose"><button class="copy-btn" id="rm-copy" type="button" aria-label="Скопировать">${ICONS.copy}</button>${esc(d.compose)}</pre>
      <p class="sub">Безопасность: наружу торчит только https на 443 с твоим паролем Depo и ограничением попыток входа. Пароль держи длинным, а пин-код на телефоне закроет приложение, если телефон окажется в чужих руках.</p>
    </details>`;
  const res = box.querySelector('#rm-res');
  const save = async patch => {
    try { await api('/api/remote', { method: 'POST', body: patch }); await loadRemote(box); toast('Сохранено', 'ok', 2000); }
    catch (e) { toast(e.message, 'err', 6000); await loadRemote(box); }
  };
  box.querySelector('#rm-save').onclick = () => save({ domain: box.querySelector('#rm-domain').value, relay_ip: box.querySelector('#rm-ip').value,
    login_path: box.querySelector('#rm-lp').value, max_fails: +box.querySelector('#rm-mf').value });
  box.querySelector('#rm-on').onclick = e => {
    const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    if (!on && d.via) return confirmBox('Выключить доступ, через который ты сейчас зашёл?', 'Страница сразу перестанет отвечать. Включить обратно можно будет только из локальной сети или через NetBird.', 'Выключить', () => save({ enabled: false }));
    save({ enabled: on, domain: box.querySelector('#rm-domain').value, relay_ip: box.querySelector('#rm-ip').value });
  };
  box.querySelector('#rm-copy').onclick = e => copyText(d.compose, e.currentTarget);
  box.querySelector('#rm-check').onclick = async e => {
    const b = e.currentTarget; b.disabled = true; res.innerHTML = '<p class="sub">Проверяю…</p>';
    try {
      const c = await api('/api/remote/check', { method: 'POST' });
      const line = (ok, t) => `<div class="rm-ck ${ok === true ? 'ok' : ok === false ? 'bad' : ''}">${ok === true ? '✓' : ok === false ? '✕' : '•'} ${esc(t)}</div>`;
      const ipPart = c.ip ? line(c.ip.same ? true : false, c.ip.same ? `По IP ${c.ip.url}: отвечает этот Depo за ${c.ip.ms} мс` : `По IP ${c.ip.url}: ${c.ip.error || 'ответ ' + c.ip.status}`) : '';
      const domPart = c.domain ? line(c.dns ? (c.dns_ok ?? true) : false, c.dns ? `DNS: ${c.dns}${c.dns_ok === false ? ' — не совпадает с IP проводника' : ''}` : 'DNS: домен не найден')
        + line(c.https ? c.https < 400 : false, c.https ? `HTTPS ${c.domain}: ответ ${c.https}${c.ms ? ` за ${c.ms} мс` : ''}` : `HTTPS ${c.domain}: не достучался`)
        + line(c.same_depo, c.same_depo ? 'Через домен отвечает именно этот Depo' : 'Через домен — не этот Depo (или он не ответил)')
        + (c.error ? `<p class="err">${esc(c.error)}</p>` : '') : '';
      res.innerHTML = ipPart + domPart;
    } catch (e2) { res.innerHTML = `<p class="err">${esc(e2.message)}</p>`; }
    finally { b.disabled = false; }
  };
}
async function refreshMeters() {
  try {
    const d = await api('/api/meters?force=1');
    S.meters = { ...S.meters, [d.provider]: d }; renderLimits(); renderCtxPop();
    toast('Лимиты обновлены', 'ok', 2500);
  } catch (e) { toast(e.message); }
}
// Данные настроек держим наготове: подтягиваем в фоне после запуска, окно открывается мгновенно,
// а свежие цифры (аккаунты, лимиты) подменяются на лету.
const settingsData = () => Promise.all([
  api('/api/telegram'),
  api('/api/log').then(d => d.items),
  api('/api/backup').then(d => d.last).catch(() => null),
  api('/api/accounts').catch(() => null),
]).then(r => (S.setCache = r));
async function settingsDialog(opts = {}) {
  let cfg = { enabled: false, events: [] }, logs = [], last = null, acc = null;
  const fresh = settingsData();
  try { [cfg, logs, last, acc] = S.setCache ?? await fresh; } catch (e) { toast(e.message); }
  fresh.then(r => { const mm = document.querySelector('.smodal'); if (mm && r[3]) accRedraw(mm, r[3]); }).catch(() => { });

  const EV = [
    ['error', 'Ход упал', 'Агент запустился, но не довёл дело до конца: оборвалась связь, кончился лимит, провайдер вернул ошибку. В сообщении будет проект, чат и сама ошибка.'],
    ['done_long', 'Долгий ход закончен', 'Агент доработал задачу, которая заняла больше двух минут. Короткие ходы не беспокоят — ты и так на них смотришь.'],
    ['limit', 'Лимит перевалил за 80%', 'Израсходовано больше 80% пятичасового или недельного лимита подписки. Присылается один раз на каждый порог: 80% и 95%.'],
    ['attention', 'Нужен ответ', 'Агент остановился и ждёт тебя: просит разрешение на команду или правку. Пока не ответишь — ход стоит.'],
    ['service', 'Перезапуск Depo', 'Сама панель перезапустилась — после перезагрузки сервера, обновления или сбоя. Если в этот момент шли ходы, в сообщении будет, сколько их прервалось.'],
    ['deploy_blocked', 'Публикация остановлена', 'Обязательная проверка не прошла, поэтому небезопасный релиз не публикуется.'],
    ['rollback', 'Выполнен откат', 'Проверка после публикации не прошла, предыдущий релиз восстановлен.'],
  ];
  // Агенты-исполнители: вход прямо отсюда, терминал не нужен.
  const accRow = (prov, title, hint) => `<div class="srow acard" data-acc="${prov}">${accCard(prov, title, hint, acc?.[prov] ?? {})}</div>`;
  // Агент без своего входа (ещё не поставлен его CLI) — карточка с объяснением, без полей для ключей.
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
      <button data-st="team" aria-selected="false">Команда</button>
      <button data-st="tg" aria-selected="false">Телеграм</button>
      <button data-st="dev" aria-selected="false">Устройство</button>
      <button data-st="upd" aria-selected="false">Обновления AI</button>
      <button data-st="net" aria-selected="false">Доступ</button>
      <button data-st="data" aria-selected="false">Данные</button>
      <button data-st="me" aria-selected="false">Профиль</button>
    </nav>
    <div class="spanes">
    <section data-st="acc">
<div class="gl2">Аккаунты агентов</div>
    <p class="sub" style="margin:-4px 0 10px">Вход везде одинаковый и только через браузер: Depo открывает окно агента,
      ты жмёшь ссылку, входишь в свой аккаунт — и всё. Ключей API Depo не спрашивает и не хранит.
      Аккаунтов у агента может быть несколько: «Добавить аккаунт» запоминает текущий, а переключение сразу показывает лимиты.</p>
    ${accRow('claude', 'Claude Code', 'Depo запустит claude auth login и покажет его экран: ссылку откроешь в браузере, код вставишь обратно. Учётные данные лягут на эту машину — туда же, куда их кладёт вход в терминале.')}
    ${accRow('codex', 'Codex', 'То же самое: вход через аккаунт ChatGPT. Если браузер перекинет на адрес вида localhost:1455 и страница не откроется — скопируй этот адрес в поле «вернулся из браузера», Depo доведёт вход до конца сам.')}
    ${accRow('gemini', 'Gemini', 'Собеседник в чате, а не исполнитель: читает разговор и отвечает словами, файлы не трогает. Вход — обычный аккаунт Google: Depo покажет ссылку, на странице Google ты получишь код и вставишь его обратно.')}
    ${accRow('kimi', 'Kimi', 'Исполнитель, как Claude и Codex. Вход по подписке Kimi: Depo откроет ссылку, введёшь код на странице kimi.ai — и готово. Работает через Kimi Code CLI. Почту и тариф Depo берёт из профиля Kimi — так же, как сам CLI.')}

    </section>
    <section data-st="chat" hidden>
<div class="gl2">Новый чат по умолчанию</div>
    <div class="srow"><div class="c"><b>Агент</b><span>кем открывается свежий чат; показаны только подключённые аккаунты</span></div><div class="ctl"><select id="pf-provider">${agents().map(p => `<option value="${p}">${esc(agName(p))}</option>`).join('')}</select></div></div>
    <div class="srow"><div class="c"><b>Модель</b><span>«По умолчанию» = та же, что в Claude Code</span></div><div class="ctl"><select id="pf-model"></select></div></div>
    <div class="srow"><div class="c"><b>Сколько думать${qm('Уровень раздумий модели. Быстрее — дешевле и шустрее, глубже — лучше на сложных задачах. «По умолчанию» берёт настройку самого агента.')}</b><span>Claude: --effort · Codex: reasoning effort</span></div><div class="ctl"><select id="pf-effort"></select></div></div>
    <div class="srow"><div class="c"><b>Разрешения${qm('Что агенту можно без вопросов. «По умолчанию» — спрашивает перед командами и правками, как Claude Code в терминале.')}</b><span>можно поменять в любом чате внизу</span></div><div class="ctl"><select id="pf-perm">${(S.models?.permissions ?? []).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div></div>

    <div class="gl2">Ассистент</div>
    <div class="srow"><div class="c"><b>Голос ассистента${qm('Ассистент — золотая кнопка-«волна»: поговорить о проектах, что сделано и что осталось. Живой голос ChatGPT работает под входом Codex, без ключей: он слушает и говорит, а за фактами ходит к агенту Codex — только на чтение. «Голос устройства» — ответ текстом от собеседника ниже, озвучивает телефон или компьютер.')}</b><span>кто слушает и говорит</span></div>
      <div class="ctl"><select id="pf-asvoice"><option value="chatgpt" ${(S.prefs?.assistant_voice ?? 'chatgpt') === 'chatgpt' ? 'selected' : ''} ${V.chatgpt ? '' : 'disabled'}>Живой голос ChatGPT${V.chatgpt ? '' : ' — войди в Codex'}</option><option value="device" ${S.prefs?.assistant_voice === 'device' ? 'selected' : ''}>Собеседник + голос устройства</option></select></div></div>
    <div class="srow"><div class="c"><b>Вид на телефоне</b><span>на этом устройстве · на компьютере — панель справа (Ctrl+J)</span></div>
      <div class="ctl"><select id="pf-asview"><option value="screen">Экран на всё</option><option value="sheet" ${localStorage.getItem('depo.asst.view') === 'sheet' ? 'selected' : ''}>Шторка снизу</option></select></div></div>
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
    <div class="srow"><div class="c"><b>Пин-код при открытии${qm('Четыре цифры при запуске приложения и при возврате к нему через минуту и больше. Это замок экрана на этом телефоне — пароль Depo он не заменяет. Пин хранится здесь же, в виде хэша. Забыл — «Войти паролем» на экране пин-кода.')}</b><span id="pin-note">${PIN.get() ? 'включён' : 'выключен'}</span></div>
      <div class="ctl"><button class="sw2" id="pf-pin" role="switch" aria-checked="${!!PIN.get()}"></button></div></div>
    <div class="srow" id="bio-row" ${PIN.get() ? '' : 'hidden'}><div class="c"><b>Отпечаток или Face ID${qm('Вместо цифр — сканер телефона (через WebAuthn). Браузеры дают его только при входе в Depo по доменному имени и по HTTPS, не по IP-адресу.')}</b><span id="bio-note">${esc(PIN.bioNote())}</span></div>
      <div class="ctl"><button class="sw2" id="pf-bio" role="switch" aria-checked="${!!PIN.get()?.bio}" ${PIN.bioPossible() ? '' : 'disabled'}></button></div></div>
    <div class="srow"><div class="c"><b>Уведомления в браузере${qm('Всплывают, когда ход закончился или агент ждёт ответа, а вкладка Depo не на виду. Нужен HTTPS и разрешение браузера.')}</b><span>работают и когда панель свёрнута</span></div>
      <div class="ctl"><button class="sw2" id="pf-notif" role="switch" aria-checked="${localStorage.getItem('depo.notif') === '1'}"></button></div></div>
    <div class="srow"><div class="c"><b>Push на это устройство${qm('Приходят, даже когда Depo закрыт: ход закончен, агент ждёт ответа, ошибка, лимит, публикация остановлена. Сервер шлёт их напрямую через Web Push — без сторонних сервисов. В сообщении только факт события, без текста переписки.')}</b><span>только по HTTPS · разрешение браузер спросит один раз</span></div>
      <div class="ctl"><button class="sw2" id="pf-push" role="switch" aria-checked="false"></button></div></div>
    <div class="srow"><div class="c"><b>HTTPS${qm('Микрофон и уведомления браузер отдаёт только защищённому соединению. Сертификат свой, его нужно один раз поставить на телефон.')}</b><span>${S.https ? `<a style="color:var(--accent)" href="https://${esc(location.hostname)}:${S.https}/">открыть по https</a> · <a style="color:var(--accent)" href="/ca.crt">сертификат для телефона</a>` : 'сертификата нет — запусти scripts/make-cert.sh'}</span></div>
      <div class="ctl"><span class="v">${location.protocol === 'https:' ? 'включён' : 'выключен'}</span></div></div>

    <div class="gl2">Голосовой ввод</div>
    <div class="srow"><div class="c"><b>Диктовка на этом устройстве${qm('Микрофон → текст в поле ввода → правишь и отправляешь сам. Ничего не уходит агенту автоматически и не тратит лимиты. Аудио не сохраняется.')}</b><span id="vc-note">${voiceNote()}</span></div>
      <div class="ctl"><select id="pf-voice">
        <option value="local">На сервере (Vosk + Whisper)${V.available ? '' : ' — не запущен'}</option>
        <option value="chatgpt" ${V.chatgpt && window.RTCPeerConnection ? '' : 'disabled'}>ChatGPT (вход Codex)${V.chatgpt ? '' : ' — войди в Codex'}</option>
        <option value="browser" ${SR ? '' : 'disabled'}>Браузер${SR ? ' (облако)' : ' — не поддерживается'}</option>
      </select></div></div>
    <div class="srow"><div class="c"><b>Клавиатура телефона${qm('На Android можно просто нажать микрофон на клавиатуре (Gboard и др.) в поле ввода — Depo в этом не участвует, работает и без HTTPS.')}</b><span>микрофон на клавиатуре Android работает всегда, без настроек</span></div></div>
    <div class="srow"><div class="c"><b>Движок на сервере${qm('Пока говоришь — черновик даёт быстрый Vosk. Когда отпускаешь — текст переписывает Whisper: он ставит знаки препинания и оставляет английские слова латиницей. Всё считается на сервере Depo, звук наружу не уходит.')}</b><span>${esc(V.vosk || 'vosk')}${V.whisper ? ' + whisper ' + esc(V.whisper) : V.whisper_loading ? ' · whisper загружается' : ' · без чистовика'}</span></div>
      <div class="ctl"><span class="v">${v}</span></div></div>
    ${V.available ? '' : '<p class="sub" style="margin:0 0 6px">Запусти один раз: <code style="font:11.5px var(--mono);color:var(--accent)">bash ~/depo/scripts/voice-install.sh</code></p>'}

    </section>
    <section data-st="team" hidden><div id="team-box"></div></section>
    <section data-st="net" hidden>
<div class="gl2">Доступ из интернета через проводник${qm('Чтобы открывать Depo с телефона без NetBird: арендованный сервер с NetBird принимает https на твоём домене и по зашифрованному туннелю передаёт запросы сюда. Выключатель ниже работает на самом Depo — запросы через домен получат отказ, даже если проводник ещё запущен.')}</div>
    <div id="net-box"><p class="sub">Загружаю…</p></div>
    </section>
    <section data-st="me" hidden>
<div class="gl2">Профиль</div>
    <div class="mehead"><span class="ownav"><span>${esc((S.user?.login ?? '?')[0].toUpperCase())}</span></span>
      <div><b class="ownname">${esc(S.user?.login ?? '')}</b><span>владелец Depo · ${esc(S.host?.name ?? '')}</span></div></div>
    <div class="srow"><div class="c"><b>Код из Телеграма на новом устройстве${qm('После верного пароля с нового телефона или компьютера бот присылает 6 цифр — без них не войти. Под кодом кнопка «Это не я»: она отменяет вход и выключает удалённый доступ. Устройство, где код подтверждён, запоминается.')}</b><span id="tf-note">загружаю…</span></div>
      <div class="ctl"><button class="sw2" id="tf-on" role="switch" aria-checked="false"></button></div></div>
    <div id="tf-dev"></div>
    <div class="srow"><div class="c"><b>Пароль входа в Depo</b><span>после смены придётся войти заново на всех устройствах · сессия заканчивается после 14 дней без захода</span></div>
      <div class="ctl"><button class="btn" id="me-pw">Сменить пароль</button></div></div>
    <div class="srow"><div class="c"><b>Лимиты агентов${qm('Depo сам перечитывает лимиты Claude, Codex и Kimi раз в минуту и после каждого хода. Кнопка просто делает это сразу — например, после сброса лимита или смены аккаунта.')}</b><span>перечитать прямо сейчас, не дожидаясь автообновления</span></div>
      <div class="ctl"><button class="btn" id="me-meters">Обновить лимиты</button></div></div>
    <div class="srow"><div class="c"><b>Выйти из Depo</b><span>на этом устройстве</span></div>
      <div class="ctl"><button class="btn danger" id="me-lo">Выйти</button></div></div>
    </section>
    <section data-st="upd" hidden><div id="cu-box"><p class="sub">Загружаю…</p></div></section>
    <section data-st="data" hidden>
<div class="gl2">Место на диске${qm('Depo сам следит, чтобы не забивать сервер: журнал хранится 30 дней (не больше 20 000 записей), длинные выводы команд агентов старше двух месяцев сокращаются до начала. Твои сообщения, ответы агентов, вложения и файлы проектов не удаляются никогда. Уборка — раз в сутки.')}</div>
    <div id="st-store"><p class="sub">Считаю…</p></div>
<div class="gl2">Резервные копии</div>
    <div class="srow"><div class="c"><b>Последняя копия${qm('Каждую ночь в 3:2x база и вложения Depo уезжают архивом на внешний диск Privat, хранятся 14 последних.')}</b><span>${last?.ok ? esc(new Date(last.at).toLocaleString('ru-RU')) : last ? 'не прошла: ' + esc(last.error || '') : 'ещё не делалась'}</span></div>
      <div class="ctl"><button class="btn" id="bk-now">Сделать сейчас</button></div></div>

    <div class="gl2">Журнал</div>
    <div class="logbox">${logs.length ? logs.slice(0, 80).map(l =>
      `<div class="l ${esc(l.level)}"><span class="t">${hhmm(l.ts)}</span><span class="s">${esc(l.scope || '')}</span><span>${esc(l.text)}</span></div>`).join('') : '<div class="l">пусто</div>'}</div>

    </section>
    </div></div>
    <div class="sfoot" hidden><span class="sdirty">Есть несохранённые изменения</span><button class="btn primary" id="save">Сохранить</button></div>
    <button hidden id="pw"></button><button hidden id="lo"></button></div>`, {
    onOpen(m, close) {
      const err = m.querySelector('#tg-err');
      m.querySelectorAll('[data-no]').forEach(b => b.onclick = close);
      m.querySelectorAll('#stabs button').forEach(b => b.onclick = () => {
        m.querySelectorAll('#stabs button').forEach(x => x.setAttribute('aria-selected', x === b));
        m.querySelectorAll('.spanes > section').forEach(sec => sec.hidden = sec.dataset.st !== b.dataset.st);
        m.querySelector('.spanes').scrollTop = 0;
      });
      CU.box = m.querySelector('#cu-box');
      loadCliUpd();
      m.querySelector('#pw').onclick = () => { close(); passwordDialog(); };
      m.querySelector('#me-pw').onclick = () => { close(); passwordDialog(); };
      const tfPaint = d => {
        const sw = m.querySelector('#tf-on'); if (!sw) return;
        sw.setAttribute('aria-checked', d.enabled);
        m.querySelector('#tf-note').textContent = d.enabled ? `включено · доверенных устройств: ${d.devices.length}` : d.tg === false ? 'нужен подключённый Телеграм-бот' : 'выключено';
        m.querySelector('#tf-dev').innerHTML = d.enabled && d.devices.length ? `<div class="tfdev">${d.devices.map(x => `<span>${esc((x.agent || 'устройство').replace(/\s*\([^)]*\)/g, ' ').slice(0, 60))} · ${esc(new Date(x.last || x.at).toLocaleDateString('ru-RU'))}</span>`).join('')}<button class="btn" id="tf-forget">Забыть все устройства</button></div>` : '';
        m.querySelector('#tf-forget')?.addEventListener('click', () => confirmBox('Забыть все устройства?', 'На каждом устройстве при следующем входе снова попросят код из Телеграма. Это устройство останется доверенным.', 'Забыть', async () => tfPaint(await api('/api/twofa', { method: 'POST', body: { forget: true } }))));
      };
      api('/api/twofa').then(tfPaint).catch(() => { });
      m.querySelector('#tf-on').onclick = async e => {
        const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
        try { tfPaint(await api('/api/twofa', { method: 'POST', body: { enabled: on } })); toast(on ? 'Код из Телеграма включён — это устройство уже доверенное' : 'Подтверждение входа выключено', 'ok', 3500); }
        catch (e2) { toast(e2.message, 'err', 6000); }
      };
      m.querySelector('#me-lo').onclick = () => api('/api/logout', { method: 'POST' }).then(() => location.href = '/');
      m.querySelector('#me-meters').onclick = e => { const b = e.currentTarget; b.disabled = true; refreshMeters().finally(() => { b.disabled = false; }); };
      if (opts.tab) m.querySelector(`#stabs [data-st="${opts.tab}"]`)?.click();
      m.querySelector('#lo').onclick = () => api('/api/logout', { method: 'POST' }).then(() => location.href = '/');
      m.querySelector('section[data-st="acc"]').addEventListener('click', e => accClick(e, m, close));
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
      loadRemote(m.querySelector('#net-box'));
      teamSettings(m.querySelector('#team-box'));
      api('/api/storage').then(d => {
        const mbs = n => n == null ? '—' : n >= 2 ** 30 ? (n / 2 ** 30).toFixed(1) + ' ГБ' : Math.round(n / 2 ** 20) + ' МБ';
        const box = m.querySelector('#st-store'); if (!box) return;
        box.innerHTML = `<div class="srow"><div class="c"><b>База (чаты, журнал)</b><span>журнал: ${d.log_rows} записей · хранится ${d.rules.log_days} дней</span></div><div class="ctl"><span class="v">${mbs(d.db)}</span></div></div>
          <div class="srow"><div class="c"><b>Вложения</b><span>скриншоты и файлы из чатов</span></div><div class="ctl"><span class="v">${mbs(d.uploads)}</span></div></div>
          <div class="srow"><div class="c"><b>Свободно на диске</b><span>${d.last ? `последняя уборка ${esc(new Date(d.last.at).toLocaleString('ru-RU'))}` : 'уборка запустится в течение минуты после старта'}</span></div><div class="ctl"><span class="v">${mbs(d.free)}</span></div></div>`;
      }).catch(() => { });
      const swPin = m.querySelector('#pf-pin'), swBio = m.querySelector('#pf-bio');
      const pinUi = () => {
        const p = PIN.get();
        swPin.setAttribute('aria-checked', !!p); m.querySelector('#pin-note').textContent = p ? 'включён' : 'выключен';
        m.querySelector('#bio-row').hidden = !p; swBio.setAttribute('aria-checked', !!p?.bio); m.querySelector('#bio-note').textContent = PIN.bioNote();
      };
      swPin.onclick = async () => {
        if (PIN.get()) { PIN.clear(); pinUi(); return toast('Пин-код выключен', 'ok', 2500); }
        if (!window.crypto?.subtle) return toast('Пин-коду нужен HTTPS — открой Depo по https.', 'warn', 6000);
        const pin = await pinPrompt('Придумай пин-код', 'Четыре цифры');
        if (!pin) return;
        const again = await pinPrompt('Повтори пин-код', 'Ещё раз те же цифры');
        if (again !== pin) return toast('Пин-коды не совпали — попробуй ещё раз.', 'warn', 4000);
        await PIN.set(pin); pinUi(); toast('Пин-код включён', 'ok', 2500);
      };
      swBio.onclick = async () => {
        const p = PIN.get(); if (!p) return;
        if (p.bio) { PIN.save({ ...p, bio: null }); return pinUi(); }
        try { await PIN.enrollBio(); pinUi(); toast('Отпечаток / Face ID подключён', 'ok', 3000); }
        catch (e) { toast('Сканер не подключился: ' + e.message, 'err', 7000); }
      };
      const pv = m.querySelector('#pf-voice'); pv.value = voiceEngine();
      pv.onchange = () => {
        try { localStorage.setItem('depo.voice', pv.value); } catch { }
        m.querySelector('#vc-note').textContent = voiceNote(); voiceInit();
      };
      const sw3 = m.querySelector('#pf-notif'); sw3.onclick = async () => {
        const want = sw3.getAttribute('aria-checked') !== 'true';
        if (want && !('Notification' in window)) return toast('Этот браузер не умеет уведомления (нужен https и установка на экран).');
        if (want && Notification.permission !== 'granted') { const r = await Notification.requestPermission(); if (r !== 'granted') return toast('Браузер не дал разрешение на уведомления.'); }
        sw3.setAttribute('aria-checked', want); localStorage.setItem('depo.notif', want ? '1' : '0');
      };
      // Push: состояние — живая подписка этого устройства, а не флажок в localStorage.
      const sw4 = m.querySelector('#pf-push');
      const pushSub = async () => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
        try { return await (await navigator.serviceWorker.ready).pushManager.getSubscription(); } catch { return null; }
      };
      pushSub().then(s => { if (s) sw4.setAttribute('aria-checked', 'true'); });
      sw4.onclick = async () => {
        const on = sw4.getAttribute('aria-checked') === 'true';
        if (on) {
          const s = await pushSub();
          try { if (s) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: s.endpoint } }); await s.unsubscribe(); } }
          catch (e) { return toast(e.message, 'err', 6000); }
          sw4.setAttribute('aria-checked', 'false');
          return;
        }
        if (location.protocol !== 'https:') return toast('Push работает только по HTTPS — открой Depo по защищённому адресу (Настройки → Устройство → HTTPS).');
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Этот браузер не умеет push-уведомления.');
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return toast('Браузер не дал разрешение на уведомления.');
        try {
          const { key } = await api('/api/push');
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
          });
          await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
          sw4.setAttribute('aria-checked', 'true');
          toast('Push-уведомления включены', 'ok', 3000);
        } catch (e) { toast(e.message, 'err', 6000); }
      };
      m.querySelector('#save').onclick = async () => {
        try {
          await api('/api/telegram', { method: 'POST', body: payload() });
          const d = await api('/api/settings', { method: 'POST', body: { provider: pfProv.value, model: pfModel.value, effort: pfEff.value, permission_mode: pfPerm.value, mirror: sw2.getAttribute('aria-checked') === 'true' ? '1' : '0', archive_days: m.querySelector('#pf-days').value, tools: swT.getAttribute('aria-checked') === 'true' ? '1' : '0', snapshot: swS.getAttribute('aria-checked') === 'true' ? '1' : '0',
            companion: m.querySelector('#pf-comp')?.value || '', assistant_voice: m.querySelector('#pf-asvoice')?.value || 'chatgpt' } });
          S.prefs = d.prefs; applyFeedPrefs();
          try { await refreshModels(); } catch { }   // сменился собеседник — обновим значок кнопки
          setDirty(false); toast('Настройки сохранены', 'ok', 2500);   // остаёмся там же, где были
        } catch (e) { err.textContent = e.message; toast(e.message, 'err', 5000); }
      };
      // «Сохранить» нужна только полям, которые сохраняются кнопкой (чат, Телеграм, собеседник);
      // переключатели устройства, диктовки, пин-кода и доступа применяются сразу.
      const SAVED = '#pf-provider,#pf-model,#pf-effort,#pf-perm,#pf-days,#pf-comp,#pf-asvoice,#tg-token,#tg-chat,[data-ev]';
      m.querySelector('#pf-asview').onchange = e => { try { localStorage.setItem('depo.asst.view', e.target.value); } catch { } toast('Вид ассистента на этом устройстве сохранён', 'ok', 2000); };
      const SAVED_SW = '#pf-mirror,#pf-tools,#pf-snap,#tg-on';
      const foot = m.querySelector('.sfoot');
      const setDirty = on => { foot.hidden = !on; m.classList.toggle('dirty', on); };
      m.addEventListener('input', e => { if (e.target.matches(SAVED)) setDirty(true); });
      m.addEventListener('change', e => { if (e.target.matches(SAVED)) setDirty(true); });
      m.addEventListener('click', e => { if (e.target.closest(SAVED_SW)) setDirty(true); });
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

/* ───────── панель ───────── */
const collapsed = () => $('#app').dataset.side === '0';
function isPhone() { return innerWidth <= 760; }
function setSide(open) {
  // На телефоне выезжающей панели нет: список чатов — отдельный экран со своей записью в истории.
  if (open && isPhone()) { $('#app').dataset.side = '0'; return mgo('chats'); }
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

/* ───────── события интерфейса ───────── */
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
$('#csearch').addEventListener('input', e => { S.chatQuery = e.target.value; renderSide(); });
$('#csearch').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; S.chatQuery = ''; renderSide(); }
  if (e.key === 'Enter') $('#clist [data-c]')?.click();
});
$('#fly').addEventListener('click', listClick);
$('#clist').addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-c]')) { e.preventDefault(); selectChat(e.target.dataset.c); }
});

$('#btn-side').onclick = () => setSide(collapsed());
$('#btn-exp').onclick = () => (isPhone() ? mback() : setSide(true));
$('#btn-newproject').onclick = newProjectDialog;
$('#btn-pmenu').onclick = e => { e.stopPropagation(); projectMenu(e.currentTarget); };
$('#btn-user').onclick = e => { e.stopPropagation(); userMenu(e.currentTarget); };
// Чат заводится в базе при первом сообщении, иначе копятся пустые «Новый чат»
$('#btn-newchat').onclick = () => {
  if (!curProject()) return;
  S.cid = null; S.messages = []; S.live = null; S.atts = []; resetDraft(); S.teamNext = undefined; renderAtts();
  renderAll(); renderFeed(); $('#inp').focus(); save();
  if (innerWidth <= 760) setSide(false);
};
// Gemini отвечает в том же чате, но ничего не делает руками: это разговор, а не ход агента.
// Два режима: «Объяснить» — только чтение; «Подготовить уточнение» — черновик, который владелец
// сам проверяет и вставляет в поле ввода. Агенту собеседник ничего не отправляет.
async function askCompanion(text, mode) {
  const b = $('#btn-gemini'), inp = $('#inp');
  b.disabled = true; b.classList.add('busy');
  try {
    await api(`/api/chats/${S.cid}/companion`, { method: 'POST', body: { text, mode } });
    if (text && inp.value.trim() === text) { inp.value = ''; autosize(); }
  } catch (e) { toast(e.message, 'err', 6000); }
  finally { b.disabled = false; b.classList.remove('busy'); }
}
$('#btn-gemini').onclick = () => {
  if (!S.cid) return openAssistant('all');
  openAssistant('c:' + S.cid);
};
$('#btn-board').onclick = () => boardDialog();
$('#live-stop').onclick = () => liveStop();
$('#live-ball').onclick = () => lvHush();          // перебить ответ, если заговорил «поверх»
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
$('#btn-home').onclick = () => { openDash(); if (innerWidth <= 760) setSide(false); };
$('#dscrim').onclick = () => setSide(false);
$('#runpill').onclick = e => {
  const others = S.running.filter(id => id !== S.cid && isRunning(id));
  if (others.length === 1) return selectChat(others[0]);
  menu(e.currentTarget, [{ label: 'Сейчас работают' }, ...others.map(id => {
    const c = chatOf(id), p = c && projectOf(c.project_id), run = S.runs[id];
    return { text: c ? `${p?.name ?? ''} — ${c.title}` : 'Задача', hint: `${agName(c?.provider)}${run ? ' · ' + duration(activeMs(run)) : ''}`, run: () => selectChat(id) };
  })]);
};
// нижняя навигация на телефоне
$('#bnav').addEventListener('click', e => {
  const b = e.target.closest('[data-nav]'); if (!b) return;
  const nav = b.dataset.nav;
  if (nav === 'dash') mhome();
  else if (nav === 'projects') mgo('projects');
  else if (nav === 'chat') mgo('chats');
  else if (nav === 'board') boardDialog();
  else if (nav === 'more') settingsDialog();
});

function togglePop(btn) {
  const on = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', !on);
  $('#pop-ctx').hidden = on;
  if (!on) {
    renderCtxPop();
    for (const p of teamChat(curChat()) ? teamProviders() : [curProvider()])   // в команде — свежие лимиты каждого участника
      api(`/api/meters?provider=${p}`)
        .then(d => { S.meters = { ...S.meters, [d.provider]: d }; renderCtxPop(); renderLimits(); }).catch(() => { });
    if (S.cid) loadChatContext(S.cid);
  }
}
$('#chip-gauge').onclick = e => { e.stopPropagation(); togglePop(e.currentTarget); };
$('#chip-state').onclick = runSummaryDialog;
document.addEventListener('click', e => {
  if (!e.target.closest('#pop-ctx') && !e.target.closest('#chip-gauge') && !$('#pop-ctx').hidden) {
    $('#pop-ctx').hidden = true; $('#chip-gauge').setAttribute('aria-expanded', 'false');
  }
  if (!e.target.closest('#fly') && !e.target.closest('#rail')) closeFly();
  if (innerWidth <= 760 && !collapsed() && !e.target.closest('.side') && !e.target.closest('.rail')
      && !e.target.closest('.exp') && !e.target.closest('.scrim') && !e.target.closest('.menu')
      && !e.target.closest('#bnav') && !e.target.closest('.dscrim')) setSide(false);
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
$('#btn-sendmode').onclick = e => {
  const c = curChat();
  menu(e.currentTarget, [
    { label: 'Когда отправить уточнение' },
    { text: 'Передать сейчас', hint: S.steering[c?.provider] ? 'в работающий процесс CLI' : 'этот CLI не поддерживает ввод на ходу', active: S.sendMode === 'now', run: () => {
      if (!S.steering[c?.provider]) return toast('Для этого агента доступно только «После задачи».');
      S.sendMode = 'now'; renderHead();
    } },
    { text: 'После задачи', hint: 'сохранить в постоянной очереди', active: S.sendMode === 'after', run: () => { S.sendMode = 'after'; renderHead(); } },
  ]);
};
$('#btn-send').onclick = () => (isRunning(S.cid) ? stop() : send());
$('#btn-cfg').onclick = () => $('#cb').classList.toggle('xtra');
async function toggleTeamMember(provider) {
  const cfg = JSON.parse(JSON.stringify(S.team ?? {})), off = new Set(cfg.off ?? []), on = !off.has(provider);
  if (on) off.add(provider); else off.delete(provider);
  if (off.size >= 3) return toast('Нужен хотя бы один участник команды.');
  cfg.off = [...off];
  try { const d = await api('/api/team/config', { method: 'POST', body: cfg }); S.team = d.config; renderAll(); toast(`${agName(provider)} ${on ? 'исключён из команды' : 'вернулся в команду'}`, 'ok', 2200); }
  catch (e) { toast(e.message, 'err'); }
}
function teamMemberMenu(anchor) {
  const off = new Set(S.team?.off ?? []);
  menu(anchor, [{ label: 'Участники команды' }, ...['claude', 'codex', 'kimi'].map(p => ({ text: `${agName(p)} · ${off.has(p) ? 'не участвует' : 'участвует'}`, hint: agents().includes(p) ? '' : 'не подключён', active: !off.has(p), run: () => toggleTeamMember(p) }))]);
}
$('#btn-team-menu').onclick = e => { e.stopPropagation(); teamMemberMenu(e.currentTarget); };
$('#btn-team').onclick = async () => {
  const c = curChat(), on = !teamOnHere();
  if (!c) { S.teamNext = on; renderTeamBtn(); return toast(on ? 'Новый чат начнётся командой агентов' : 'Новый чат — один агент', 'ok', 2500); }
  try {
    const d = await api(`/api/chats/${c.id}`, { method: 'PATCH', body: { team: on } });
    upsertChat(d.chat); renderAll();
    toast(on ? 'Команда включена для этого чата — следующая задача пойдёт по ролям, история чата передастся команде' : 'Команда выключена — дальше один агент', 'ok', 4000);
  } catch (e) { toast(e.message); }
};
$('#to-bottom').onclick = () => { S.newBelow = 0; scrollFeed(true); updateToBottom(); };
$('#feed').addEventListener('scroll', () => { if (nearBottom()) S.newBelow = 0; updateToBottom(); }, { passive: true });
$('#inp').addEventListener('input', autosize);
$('#inp').addEventListener('input', () => {
  if (S.cid) { S.chatState.set(S.cid, { ...(S.chatState.get(S.cid) ?? {}), draft: $('#inp').value }); persistDrafts(); }
});
// Черновики переживают закрытие вкладки: свои же недописанные сообщения, на своём устройстве.
const loadDrafts = () => { try { return JSON.parse(localStorage.getItem('depo.drafts') || '{}'); } catch { return {}; } };
let draftTimer = 0;
function persistDrafts() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      const all = loadDrafts();
      for (const [cid, st] of S.chatState) { if (st.draft) all[cid] = st.draft; else delete all[cid]; }
      const keys = Object.keys(all);
      while (keys.length > 50) delete all[keys.shift()];
      localStorage.setItem('depo.drafts', JSON.stringify(all));
    } catch { }
  }, 400);
}
// На телефоне Enter — новая строка, отправка — кнопкой (как в мессенджерах). На компьютере Enter отправляет, Shift+Enter — перенос.
const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
if (touchOnly()) $('#inp').setAttribute('enterkeyhint', 'enter');
$('#inp').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || touchOnly()) return;
  e.preventDefault(); send();
});
addEventListener('keydown', e => {
  if (e.target.matches('input,textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '[') { e.preventDefault(); setSide(collapsed()); }
  if (e.key === 'Escape') { closeFly(); closeMenus(); if (!$('#pop-ctx').hidden) { $('#pop-ctx').hidden = true; $('#chip-gauge').setAttribute('aria-expanded', 'false'); } }
  if (e.key === 'n' && curProject()) { e.preventDefault(); $('#btn-newchat').click(); }
  if (e.key === '/') { e.preventDefault(); $('#inp').focus(); }
});

/* ───────── телефон: экраны и история ─────────
   Главная → Проекты → Чаты проекта → Чат. Каждый переход — запись в history, поэтому системный жест
   «назад» Android (и кнопка) возвращает на предыдущий экран, а не закрывает приложение.
   Корень истории — Главная (d=0); «Главная» в нижней панели откатывает историю к нему. */
const MS = { restoring: false, lastPop: 0 };
const mst = () => (history.state?.m ? history.state : { m: S.view === 'dash' ? 'dash' : 'chat', d: 0 });
function mshow(screen) {
  document.body.dataset.m = screen;
  const box = $('#mscreen');
  const on = isPhone() && (screen === 'projects' || screen === 'chats');
  box.hidden = !on;
  if (on) { renderMScreen(screen); box.scrollTop = 0; }
  document.querySelectorAll('#bnav [data-nav]').forEach(b => b.setAttribute('aria-current',
    String(b.dataset.nav === (screen === 'chats' ? 'chat' : screen))));
}
// переход: push — вглубь (назад вернёт сюда), replace — соседняя вкладка
function mgo(screen, how) {
  if (!isPhone()) return;
  const cur = mst();
  if (screen === 'chats' && !S.pid) screen = 'projects';
  if (cur.m !== screen) {
    how ??= cur.m === 'dash' || (cur.m === 'projects' && screen === 'chats') ? 'push' : 'replace';
    if (how === 'push') history.pushState({ m: screen, d: cur.d + 1 }, '');
    else history.replaceState({ m: screen, d: cur.d }, '');
  }
  mshow(screen);
}
// отметить экран, на который приложение перешло само (открыли чат, главную)
function mmark(screen) {
  if (!isPhone()) return;
  if (!MS.restoring) {
    const cur = mst();
    if (screen === 'dash' && cur.m !== 'dash') history.replaceState({ m: 'dash', d: cur.d }, '');
    else if (cur.m !== screen) history.pushState({ m: screen, d: cur.d + 1 }, '');
  }
  mshow(screen);
}
function mhome() {
  if (!isPhone()) return openDash();
  const d = mst().d;
  if (d > 0) history.go(-d); else openDash();
}
function mback() {
  if (Date.now() - MS.lastPop < 450) return;          // системный жест уже сработал
  if (mst().d > 0) history.back();
  else if (mst().m === 'chat') mgo('chats', 'replace');
  else mhome();
}
addEventListener('popstate', e => {
  if (MS.skipNext) { MS.skipNext = false; return; }   // это мы сами откатили запись закрытого окна
  MS.lastPop = Date.now();
  if (!isPhone()) return;
  if (AS.open) { asstClose(true); return; }
  // открытое окно или меню закрывается первым — как в нативных приложениях
  const sc = [...document.querySelectorAll('.scrim')].pop();
  if (sc?._close) { sc._close(true); return; }
  const st = e.state?.m ? e.state : { m: 'dash', d: 0 };
  MS.restoring = true;
  try {
    if (st.m === 'dash') openDash();
    else if (st.m === 'chat') { if (S.cid && chatOf(S.cid)) selectChat(S.cid); else mshow('chats'); }
    else mshow(st.m);
  } finally { MS.restoring = false; }
});
function renderMScreen(screen) {
  const box = $('#mscreen');
  if (screen === 'projects') {
    const live = S.projects.filter(p => !p.archived);
    box.innerHTML = `<header class="mhead"><h2>Проекты</h2><button class="btn" id="m-newproject">＋ Проект</button></header>
      <div class="mlist">${live.map(p => {
        const cs = chatsOf(p.id).filter(c => !c.archived);
        const run = cs.filter(c => isRunning(c.id)).length, att = cs.filter(c => c.state === 'attention').length;
        return `<button class="mproj${p.id === S.pid ? ' cur' : ''}" data-p="${p.id}">${ptile(p, 'gl')}
          <span class="c"><b>${esc(p.name)}</b><span>${esc(p.short)}</span></span>
          <span class="n">${att ? '<span class="ask">?</span>' : ''}${run ? `<span class="run"><i></i><i></i><i></i></span>` : ''}${cs.length}</span></button>`;
      }).join('') || '<div class="empty">Проектов пока нет. Проект — это папка на сервере.</div>'}</div>`;
    box.querySelector('#m-newproject').onclick = newProjectDialog;
    box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { S.pid = +b.dataset.p || b.dataset.p; save(); mgo('chats', 'push'); });
    return;
  }
  const p = curProject();
  if (!p) return renderMScreen('projects');
  const q = S.chatQuery?.trim();
  box.innerHTML = `<header class="mhead"><button class="bb mbk" aria-label="К проектам">‹</button><div class="c"><h2>${esc(p.name)}</h2><span>${esc(p.short)}</span></div>
      <button class="sbtn" id="m-pmenu" aria-label="Действия проекта">${ICONS.more}</button></header>
    <label class="csearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg><input id="m-search" type="search" placeholder="Поиск по чатам" value="${esc(q ?? '')}" autocomplete="off" enterkeyhint="search"></label>
    <button class="add" id="m-newchat">＋ Новый чат</button>
    <div class="clist mlist" id="m-clist">${q ? searchHTML(q) : chatListHTML(p.id, true)}</div>`;
  box.querySelector('.mbk').onclick = () => mgo('projects', 'replace');
  box.querySelector('#m-pmenu').onclick = e => { e.stopPropagation(); projectMenu(e.currentTarget); };
  box.querySelector('#m-newchat').onclick = () => { $('#btn-newchat').click(); mmark('chat'); };
  const list = box.querySelector('#m-clist');
  list.addEventListener('click', listClick);
  box.querySelector('#m-search').oninput = e => { S.chatQuery = e.target.value; list.innerHTML = S.chatQuery.trim() ? searchHTML(S.chatQuery.trim()) : chatListHTML(p.id, true); };
}
// список на экране «Чаты» живой: состояния чатов меняются по SSE
const mrefresh = () => { if (isPhone() && !$('#mscreen').hidden && !document.activeElement?.matches('#m-search')) renderMScreen(document.body.dataset.m); };

/* ───────── свайпы на телефоне: от левого края — назад ───────── */
{
  // Системный жест «назад» Android срабатывает сам (у каждого экрана своя запись в истории).
  // Этот свайп — для кнопочной навигации и десктопного Chrome с тачем; от двойного срабатывания
  // защищает mback(): если popstate только что был, второй раз назад не идём.
  let sw = null;
  document.addEventListener('touchstart', e => {
    if (!isPhone() || e.touches.length !== 1 || document.body.dataset.m === 'dash') return;
    const t = e.touches[0];
    if (t.clientX > 36 || e.target.closest('pre, table, .scrim, input, textarea')) return;
    sw = { x: t.clientX, y: t.clientY, fired: false };
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!sw || sw.fired) return;
    const t = e.touches[0];
    const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }   // это прокрутка
    if (dx > 72) { sw.fired = true; mback(); }
  }, { passive: true });
  document.addEventListener('touchend', () => { sw = null; }, { passive: true });
}

/* ───────── меню сообщения: долгое нажатие на телефоне, правый клик на ПК ───────── */
// выделенный кусок текста внутри этого сообщения (если владелец что-то выделил)
const selIn = turn => {
  const sel = window.getSelection?.();
  const t = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  return t && turn.contains(sel.anchorNode) ? t : '';
};
function msgActions(turn, x, y) {
  const m = S.messages.find(v => String(v.id) === turn.dataset.mid);
  if (!m?.text) return;
  const picked = selIn(turn);
  const anchor = el('span');
  anchor.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:1px;height:1px`;
  document.body.append(anchor);
  const items = [
    ...(picked ? [{ text: 'Скопировать выделенное', hint: picked.length > 60 ? picked.slice(0, 60) + '…' : picked, run: () => copyText(picked) }] : []),
    { text: picked ? 'Скопировать всё сообщение' : 'Скопировать', run: () => copyText(m.text) },
    { text: 'Цитировать', run: () => {
      const inp = $('#inp');
      inp.value = (inp.value ? inp.value + '\n' : '') + m.text.split('\n').map(l => '> ' + l).join('\n') + '\n';
      inp.dispatchEvent(new Event('input')); inp.focus();
    } },
  ];
  if (m.role === 'user' && !isRunning(S.cid)) items.push({ text: 'Повторить запрос', run: () => send(m.text) });
  menu(anchor, items);
  anchor.remove();                      // координаты уже посчитаны синхронно
}
{
  let lp = null;
  const fw = $('#fw');
  fw.addEventListener('touchstart', e => {
    const turn = e.target.closest('.turn');
    if (!turn?.dataset.mid || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (selIn(turn)) return;              // идёт выделение текста — работает системное меню «Копировать»
    lp = { x: t.clientX, y: t.clientY, fired: false,
      timer: setTimeout(() => {
        // долгое нажатие в Android само начинает выделять слово — тогда своё меню не показываем,
        // чтобы владелец мог растянуть выделение и скопировать ровно нужный кусок
        if (selIn(turn)) { lp = null; return; }
        lp.fired = true; navigator.vibrate?.(8); msgActions(turn, t.clientX, t.clientY);
      }, 560) };
  }, { passive: true });
  fw.addEventListener('touchmove', e => {
    if (!lp || lp.fired) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > 12) { clearTimeout(lp.timer); lp = null; }   // это скролл
  }, { passive: true });
  fw.addEventListener('touchend', e => {
    if (!lp) return;
    if (lp.fired) e.preventDefault();     // иначе синтетический click тут же закроет меню
    else clearTimeout(lp.timer);
    lp = null;
  }, { passive: false });
  fw.addEventListener('contextmenu', e => {
    const turn = e.target.closest('.turn');
    if (!turn?.dataset.mid) return;
    if (selIn(turn) || e.target.closest('a')) return;   // выделение или ссылка — родное меню браузера
    e.preventDefault();
    msgActions(turn, e.clientX, e.clientY);
  });
}

/* ───────── доска ───────── */
// Доска открывается мгновенно: сразу показываем прошлый снимок (или заглушку), свежие данные — следом.
async function boardDialog() {
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
  const colsHTML = items => cols.map(([k, t, col]) => { const xs = items ? items.filter(i => i.column === k) : null;
    return `<div class="bcol"><div class="bh"><span class="d" style="background:${col}"></span>${t}<span class="n">${xs ? xs.length : '…'}</span></div>
      <div class="list">${!xs ? '<div class="bskel"></div><div class="bskel"></div>' : xs.length ? xs.map(card).join('') : '<div class="bempty">пусто</div>'}</div></div>`; }).join('');
  modal(`<div class="bmodal"><div class="bhead"><h3>Доска</h3><button class="bb shx" data-no aria-label="Закрыть">✕</button></div>
    <p class="sub">Что ждёт твоего ответа, что работает, что закончилось без тебя. Собирается само по всем проектам.</p>
    <div class="bcols" id="bcols">${colsHTML(S.boardCache ?? null)}</div></div>`, { wide: true,
    onOpen(m, close) {
      const box = m.querySelector('#bcols');
      const load = () => api('/api/board').then(d => { S.boardCache = d.items; if (box.isConnected) box.innerHTML = colsHTML(d.items); })
        .catch(e => toast(e.message));
      load();
      m.querySelector('[data-no]').onclick = close;
      box.addEventListener('click', async e => {
        const dec = e.target.closest('[data-dec]');
        if (dec) { e.stopPropagation(); dec.disabled = true;
          return api(`/api/approvals/${dec.dataset.dec}/decide`, { method: 'POST', body: { allow: dec.dataset.allow === '1' } }).then(load).catch(e2 => toast(e2.message)); }
        const open = e.target.closest('[data-open]');
        if (open) { close(); return selectChat(open.dataset.open); }
        const b = e.target.closest('[data-more]'); if (!b) return;
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
/* ───────── старт ───────── */
/* ───────── ассистент Depo: поговорить о проектах ─────────
   Живой голос — голосовой режим ChatGPT под входом Codex: браузер говорит с ним по WebRTC, а вопросы
   «что в проекте» голосовая модель передаёт агенту Codex (только чтение, сводка Depo в инструкциях).
   Запасной путь — вопрос текстом или распознаванием браузера, ответ выбранного собеседника, голос устройства. */
const AS = { open: false, scope: 'all', sid: null, pc: null, stream: null, audio: null, ac: null, raf: 0, history: [], cur: null, sr: null, muted: false, mode: null, pushed: false };
const asstMode = () => (S.prefs?.assistant_voice ?? 'chatgpt') === 'chatgpt' && V.chatgpt && window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia ? 'chatgpt' : 'device';
function asstScopesHTML() {
  const items = [['all', 'Все проекты']];
  if (S.cid && chatOf(S.cid)) items.push(['c:' + S.cid, 'Этот чат']);
  const projs = S.projects.filter(p => !p.archived)
    .map(p => [p, Math.max(0, ...chatsOf(p.id).map(c => c.updated_at || 0))]).sort((a, b) => b[1] - a[1]).slice(0, 6);
  for (const [p] of projs) items.push(['p:' + p.id, p.name]);
  return items.map(([k, t]) => `<button class="asst-chip${k === AS.scope ? ' on' : ''}" data-scope="${esc(k)}">${esc(t)}</button>`).join('');
}
function asstState(t, cls = '') { $('#asst-st').textContent = t; $('#asst').dataset.st = cls; }
function asstLine(role, text, { final = false, src = '' } = {}) {
  const box = $('#asst-caps');
  if (!AS.cur || AS.cur.role !== role || AS.cur.final) {
    const n = el('div', 'asst-l ' + (role === 'user' ? 'u' : 'a'));
    box.append(n); AS.cur = { role, node: n, text: '', final: false };
    while (box.children.length > 14) box.firstChild.remove();
  }
  AS.cur.text = text; AS.cur.node.textContent = text;
  if (src) AS.cur.node.insertAdjacentHTML('beforeend', `<span class="asst-src">${esc(src)}</span>`);
  if (final) { AS.cur.final = true; AS.history.push({ role, text }); AS.history = AS.history.slice(-12); }
  box.scrollTop = box.scrollHeight;
}
function asstOnText(d) {
  if (!AS.open || d.id !== AS.sid) return;
  if (d.role === 'agent') return d.state === 'working' ? asstState('смотрю в проект…', 'think') : asstState('говорю', 'talk');
  const role = d.role === 'user' ? 'user' : 'assistant';
  if (d.delta != null) {
    const base = AS.cur && AS.cur.role === role && !AS.cur.final ? AS.cur.text : '';
    asstLine(role, (base + d.delta).replace(/^\s+/, ''));
    asstState(role === 'user' ? 'слушаю' : 'говорю', role === 'user' ? 'listen' : 'talk');
  } else if (d.done != null) {
    asstLine(role, d.done.trim() || AS.cur?.text || '', { final: true });
    if (role === 'assistant') setTimeout(() => { if (AS.open && $('#asst').dataset.st === 'talk') asstState('слушаю', 'listen'); }, 600);
  }
}
// шар живёт голосом: громкость ответа (или микрофона) → размер и свечение
function asstOrb(stream) {
  cancelAnimationFrame(AS.raf);
  if (!stream) return;
  try {
    AS.ac ??= new (window.AudioContext || window.webkitAudioContext)();
    const an = AS.ac.createAnalyser(); an.fftSize = 256; AS.ac.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.frequencyBinCount), orb = $('#asst');   // громкость — всему окну: и шару, и ореолу
    const tick = () => { an.getByteFrequencyData(buf); let sum = 0; for (const v of buf) sum += v;
      const k = Math.min(1, sum / buf.length / 70); orb.style.setProperty('--amp', k.toFixed(3)); AS.raf = requestAnimationFrame(tick); };
    tick();
  } catch { }
}
async function asstVoiceStart() {
  asstState('соединяюсь…', 'think');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  AS.stream = stream;
  const pc = new RTCPeerConnection(); AS.pc = pc;
  stream.getAudioTracks().forEach(t => pc.addTrack(t, stream));
  pc.ontrack = e => {
    AS.audio.srcObject = e.streams[0];
    AS.audio.play().catch(() => asstSoundBlocked());
    asstOrb(e.streams[0]);
  };
  pc.createDataChannel('oai-events');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise(r => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 2000); });
  const d = await api('/api/assistant/start', { method: 'POST', body: { sdp: pc.localDescription.sdp, scope: AS.scope } });
  if (!AS.open || AS.pc !== pc) { api('/api/assistant/stop', { method: 'POST', body: { id: d.id } }).catch(() => { }); return; }
  AS.sid = d.id;
  await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
  asstState('слушаю — говори', 'listen');
}
function asstVoiceStop() {
  if (AS.sid) api('/api/assistant/stop', { method: 'POST', body: { id: AS.sid } }).catch(() => { });
  AS.sid = null;
  try { AS.pc?.close(); } catch { }
  AS.pc = null;
  AS.stream?.getTracks().forEach(t => t.stop()); AS.stream = null;
  if (AS.audio) { AS.audio.pause(); AS.audio.srcObject = null; }
  $('#asst-snd')?.remove();
  cancelAnimationFrame(AS.raf);
}
// запасной путь: распознавание браузера → ответ собеседника → голос устройства
function asstSpeak(text) {
  const ready = () => asstState(AS.mode === 'device' ? (SR ? 'нажми на микрофон и говори' : 'спроси текстом') : 'слушаю', 'listen');
  if (AS.muted || !('speechSynthesis' in window)) return ready();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, '')); u.lang = 'ru-RU';
  const ru = speechSynthesis.getVoices().filter(v => /ru/i.test(v.lang)); if (ru[0]) u.voice = ru.find(v => /Google|Milena|Yuri/i.test(v.name)) ?? ru[0];
  u.onstart = () => asstState('говорю', 'talk');
  u.onend = () => { if (AS.open) { ready(); if (AS.mode === 'device' && SR && !AS.muted) asstListen(); } };
  u.onerror = () => { if (AS.open) ready(); };
  speechSynthesis.cancel(); speechSynthesis.speak(u);
  setTimeout(() => { if (AS.open && !speechSynthesis.speaking && $('#asst').dataset.st === 'think') ready(); }, 1500);   // голоса в браузере нет — не висим на «думаю»
}
async function asstAsk(text) {
  const q = String(text || '').trim(); if (!q) return;
  asstLine('user', q, { final: true });
  asstState('думаю…', 'think');
  try {
    const d = await api('/api/assistant/ask', { method: 'POST', body: { text: q, scope: AS.scope, history: AS.history.slice(-8) } });
    if (!AS.open) return;
    asstLine('assistant', d.text, { final: true, src: `${agName('companion')} · ${d.label}` });
    if (AS.mode === 'device') asstSpeak(d.text); else asstState('слушаю', 'listen');
  } catch (e) { asstState('ошибка', ''); toast(e.message, 'err', 6000); }
}
function asstListen() {
  if (!SR || AS.sr) return;
  const r = new SR(); r.lang = 'ru-RU'; r.interimResults = true; r.continuous = false; AS.sr = r;
  let fin = '';
  r.onresult = e => { let t = ''; for (const x of e.results) { t += x[0].transcript; if (x.isFinal) fin = t; } asstLine('user', t); asstState('слушаю', 'listen'); };
  r.onend = () => { AS.sr = null; if (AS.cur && AS.cur.role === 'user' && !AS.cur.final) AS.cur.node.remove(), AS.cur = null; if (fin && AS.open) asstAsk(fin); };
  r.onerror = () => { };
  try { r.start(); asstState('слушаю — говори', 'listen'); } catch { AS.sr = null; }
}
async function asstStart() {
  asstVoiceStop(); try { AS.sr?.abort(); } catch { } AS.sr = null; try { speechSynthesis.cancel(); } catch { }
  AS.mode = asstMode();
  $('#asst-who').textContent = AS.mode === 'chatgpt' ? 'живой голос ChatGPT · вход Codex · только чтение' : `${agName('companion')} · голос устройства`;
  if (AS.mode === 'chatgpt') {
    try { await asstVoiceStart(); return; }
    catch (e) { asstVoiceStop(); AS.mode = 'device'; toast('Живой голос ChatGPT не запустился: ' + e.message + ' — отвечу текстом и голосом устройства.', 'warn', 7000); }
  }
  $('#asst-who').textContent = `${agName('companion')} · голос устройства`;
  asstState(SR ? 'нажми на микрофон и говори' : 'спроси текстом', 'listen');
}
// Браузер даёт играть звук только в ответ на нажатие, а голос ассистента приходит через секунду-две.
// Поэтому «разблокируем» динамик прямо в момент нажатия: тихий поток в тот же элемент, потом подменяем.
function asstUnlockAudio() {
  try {
    AS.ac ??= new (window.AudioContext || window.webkitAudioContext)();
    AS.ac.resume?.();
    if (!AS.audio) { AS.audio = document.createElement('audio'); AS.audio.autoplay = true; AS.audio.setAttribute('playsinline', ''); AS.audio.hidden = true; document.body.append(AS.audio); }
    const silent = AS.ac.createMediaStreamDestination();
    AS.audio.srcObject = silent.stream;
    AS.audio.play().catch(() => { });
  } catch { }
  try { if ('speechSynthesis' in window) speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(' '), { volume: 0 })); } catch { }
}
// если всё же не дали играть — кнопка «включить звук» (одно нажатие)
function asstSoundBlocked() {
  if ($('#asst-snd')) return;
  const b = el('button', 'asst-snd', '🔊 Включить звук'); b.id = 'asst-snd';
  b.onclick = () => { AS.audio.play().then(() => b.remove()).catch(() => { }); AS.ac?.resume?.(); };
  $('.asst-in').append(b);
}
function openAssistant(scope) {
  asstUnlockAudio();
  AS.scope = scope ?? (S.view === 'chat' && S.cid ? 'c:' + S.cid : 'all');
  AS.history = []; AS.cur = null; AS.muted = false;
  const box = $('#asst');
  box.classList.toggle('sheet', isPhone() && localStorage.getItem('depo.asst.view') === 'sheet');
  box.hidden = false; requestAnimationFrame(() => box.classList.add('on'));
  AS.open = true;
  $('#asst-caps').innerHTML = `<div class="asst-hint">Спроси, что сделано и что осталось — по всем проектам, по одному проекту или по этому чату. ${AS.scope.startsWith('c:') ? 'Можно попросить подготовить уточнение для агента.' : ''}</div>`;
  $('#asst-scopes').innerHTML = asstScopesHTML();
  $('#asst-mic').classList.remove('muted');
  $('#asst-chat').hidden = !AS.scope.startsWith('c:');
  if (isPhone() && !AS.pushed) { history.pushState({ ...mst(), asst: 1 }, ''); AS.pushed = true; }
  asstStart();
}
function asstClose(fromPop = false) {
  if (!AS.open) return;
  AS.open = false;
  asstVoiceStop(); try { AS.sr?.abort(); } catch { } AS.sr = null; try { speechSynthesis.cancel(); } catch { }
  const box = $('#asst'); box.classList.remove('on'); setTimeout(() => { if (!AS.open) box.hidden = true; }, 260);
  if (AS.pushed) { AS.pushed = false; if (!fromPop && history.state?.asst) { MS.skipNext = true; history.back(); } }
}
$('#asst-scopes').addEventListener('click', e => {
  const b = e.target.closest('[data-scope]'); if (!b || b.dataset.scope === AS.scope) return;
  asstUnlockAudio();
  AS.scope = b.dataset.scope; AS.history = []; $('#asst-chat').hidden = !AS.scope.startsWith('c:');
  $('#asst-scopes').innerHTML = asstScopesHTML();
  asstLine('assistant', `Переключился: ${b.textContent}.`, { final: true });
  asstStart();
});
// прежние действия собеседника для чата: ответ ложится в сам чат (у черновика — кнопка «Вставить в поле ввода»)
$('#asst-chat').addEventListener('click', async e => {
  const b = e.target.closest('[data-cm]'); if (!b || !AS.scope.startsWith('c:')) return;
  const q = $('#asst-q').value.trim();
  if (b.dataset.cm === 'draft' && !q) { $('#asst').classList.add('typing'); $('#asst-q').focus(); return toast('Напиши, что уточнить — подготовлю текст для агента.', 'warn', 4000); }
  const cid = AS.scope.slice(2); asstClose();
  if (S.cid !== cid) await selectChat(cid);
  askCompanion(q, b.dataset.cm);
});
$('#asst-x').onclick = () => asstClose();
$('#asst-end').onclick = () => asstClose();
$('#asst-kb').onclick = () => { $('#asst').classList.toggle('typing'); if ($('#asst').classList.contains('typing')) $('#asst-q').focus(); };
$('#asst-type').onsubmit = e => { e.preventDefault(); const q = $('#asst-q').value; $('#asst-q').value = ''; asstAsk(q); };
$('#asst-mic').onclick = e => {
  const b = e.currentTarget;
  if (AS.mode === 'chatgpt') {
    AS.muted = !AS.muted; AS.stream?.getAudioTracks().forEach(t => t.enabled = !AS.muted);
    b.classList.toggle('muted', AS.muted); asstState(AS.muted ? 'микрофон выключен' : 'слушаю', AS.muted ? '' : 'listen');
  } else if (AS.sr) { try { AS.sr.stop(); } catch { } }
  else { try { speechSynthesis.cancel(); } catch { } asstListen(); }
};
$('#asst-fab').onclick = () => openAssistant('all');
$('#btn-asst').onclick = () => openAssistant(S.view === 'chat' && S.cid ? 'c:' + S.cid : 'all');
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); AS.open ? asstClose() : openAssistant(); }
  else if (e.key === 'Escape' && AS.open) asstClose();
});

/* ───────── пин-код и отпечаток: замок экрана приложения на этом устройстве ───────── */
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const PIN = {
  get() { try { return JSON.parse(localStorage.getItem('depo.pin') || 'null'); } catch { return null; } },
  save(p) { localStorage.setItem('depo.pin', JSON.stringify(p)); },
  clear() { localStorage.removeItem('depo.pin'); },
  async hash(pin, salt) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64u(salt), iterations: 150000, hash: 'SHA-256' }, key, 256));
  },
  async set(pin) { const salt = b64u(crypto.getRandomValues(new Uint8Array(16))); this.save({ salt, hash: await this.hash(pin, salt), bio: null }); },
  async check(pin) { const p = this.get(); return !!p && await this.hash(pin, p.salt) === p.hash; },
  ipHost: () => /^\d+\.\d+\.\d+\.\d+$|^\[?[0-9a-f:]+\]?$/i.test(location.hostname),
  bioPossible() { return !!window.PublicKeyCredential && window.isSecureContext && !this.ipHost(); },
  bioNote() {
    if (!window.PublicKeyCredential || !window.isSecureContext) return 'нужен HTTPS';
    if (this.ipHost()) return 'недоступно при входе по IP — нужен домен';
    return this.get()?.bio ? 'подключён' : 'можно подключить';
  },
  async enrollBio() {
    if (!this.bioPossible()) throw new Error(this.bioNote());
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.())) throw new Error('на этом устройстве нет сканера, доступного браузеру');
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Depo', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: S.user?.login || 'depo', displayName: S.user?.login || 'Depo' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000 } });
    this.save({ ...this.get(), bio: b64u(cred.rawId) });
  },
  async bio() {
    const p = this.get(); if (!p?.bio || !this.bioPossible()) return false;
    try {
      await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64u(p.bio) }], userVerification: 'required', timeout: 60000 } });
      return true;
    } catch { return false; }
  },
};
// окно ввода четырёх цифр: и для замка, и для установки пин-кода
function pinPad(title, sub, { lock = false } = {}) {
  return new Promise(resolve => {
    const ov = el('div', 'pinov' + (lock ? ' lock' : ''));
    ov.innerHTML = `<div class="pinbox"><img class="pinlogo" src="/icons/icon-180.png" alt="" width="64" height="64">
      <h3>${esc(title)}</h3><p class="pinsub">${esc(sub)}</p><div class="pindots">${'<i></i>'.repeat(4)}</div>
      <div class="pinkeys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k="bio" class="pinfx" ${lock && PIN.get()?.bio ? '' : 'hidden'} aria-label="Отпечаток или Face ID"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 11v3a6 6 0 01-1.5 4M8.5 8.8A4 4 0 0116 11v2M6 13v-2a6 6 0 0110.6-3.9M18 12.5v.5a10 10 0 01-1 4.4M9 21a12 12 0 001-5v-5a2 2 0 014 0"/></svg></button>
        <button data-k="0">0</button><button data-k="del" class="pinfx" aria-label="Стереть">⌫</button></div>
      ${lock ? '<button class="pinforgot" data-k="forgot">Забыл пин-код — войти паролем</button>' : '<button class="pinforgot" data-k="cancel">Отмена</button>'}</div>`;
    document.body.append(ov);
    let val = '', fails = 0, waitUntil = 0;
    const dots = ov.querySelectorAll('.pindots i'), sub2 = ov.querySelector('.pinsub');
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < val.length));
    const done = v => { ov.classList.add('out'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', onKey); resolve(v); };
    const tryBio = async () => { if (await PIN.bio()) done(true); };
    const submit = async () => {
      if (!lock) return done(val);
      if (await PIN.check(val)) return done(true);
      fails++; val = ''; paint();
      ov.querySelector('.pinbox').classList.remove('shake'); void ov.offsetWidth; ov.querySelector('.pinbox').classList.add('shake');
      navigator.vibrate?.(60);
      if (fails >= 5) { waitUntil = Date.now() + 30000; sub2.textContent = 'Слишком много попыток — подожди 30 секунд'; }
      else sub2.textContent = 'Неверный пин-код';
    };
    const press = k => {
      if (k === 'cancel') return done(null);
      if (k === 'forgot') { PIN.clear(); return api('/api/logout', { method: 'POST' }).finally(() => location.href = '/'); }
      if (k === 'bio') return tryBio();
      if (Date.now() < waitUntil) return;
      if (k === 'del') { val = val.slice(0, -1); return paint(); }
      if (val.length >= 4) return;
      val += k; paint();
      if (val.length === 4) setTimeout(submit, 120);
    };
    ov.addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) press(b.dataset.k); });
    const onKey = e => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Escape' && !lock) press('cancel'); };
    document.addEventListener('keydown', onKey);
    if (lock && PIN.get()?.bio) setTimeout(tryBio, 350);
  });
}
const pinPrompt = (title, sub) => pinPad(title, sub);
// Замок: при запуске и при возврате в приложение после минуты в фоне.
const LOCK = { hiddenAt: 0, open: false };
async function pinLock() {
  if (!PIN.get() || LOCK.open) return;
  LOCK.open = true;
  try { await pinPad('Depo', 'Введи пин-код', { lock: true }); } finally { LOCK.open = false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') LOCK.hiddenAt = Date.now();
  else if (LOCK.hiddenAt && Date.now() - LOCK.hiddenAt > 60000) pinLock();
});
if (PIN.get()) pinLock();   // сразу при запуске — до того, как покажется переписка

// Вышла новая версия интерфейса (service worker уже положил её в кэш). Если владелец ничего не печатает
// и окна не открыты — тихо перезагружаемся сразу; иначе предлагаем кнопкой.
function shellUpdated() {
  const busy = $('#inp')?.value.trim() || document.querySelector('.scrim, .pinov') || V.rec;
  if (!busy) return location.reload();
  const t = toast('Вышла новая версия Depo — нажми, чтобы обновить', 'ok', 0);
  t.querySelector('.tx').style.cursor = 'pointer';
  t.querySelector('.tx').onclick = () => location.reload();
}
function hideSplash() {
  const sp = $('#splash'); if (!sp || sp.hidden) return;
  const wait = Math.max(0, 1300 - (Date.now() - (window.__splashAt || 0)));   // анимация видна, но приложение не держим
  setTimeout(() => { sp.classList.add('out'); setTimeout(() => sp.remove(), 520); }, wait);
}
(async function boot() {
  const narrow = () => innerWidth <= 760;
  try {
    const pref = localStorage.getItem('depo.side');
    if (pref === '0' || (pref === null && narrow())) setSide(false);
  } catch { if (narrow()) setSide(false); }
  try {
    const d = await api('/api/state');
    Object.assign(S, { user: d.user, projects: d.projects, chats: d.chats, meters: d.meters, running: d.running, host: d.host, version: d.version, models: d.models, approvals: d.approvals ?? [], prefs: d.prefs ?? {}, https: d.https ?? null, queues: d.queues ?? {}, steering: d.steering ?? {}, runs: d.runs ?? {}, team: d.team ?? null });
    for (const [cid, text] of Object.entries(loadDrafts())) S.chatState.set(cid, { draft: text });
    applyFeedPrefs();
  } catch (e) { hideSplash(); return void toast('Не удалось загрузить состояние: ' + e.message, 'err', 0); }

  if (isPhone()) history.replaceState({ m: 'dash', d: 0 }, '');   // корень истории на телефоне — Главная
  let sel = {};
  let selRaw = null;
  try { selRaw = localStorage.getItem('depo.sel'); sel = JSON.parse(selRaw || '{}'); } catch { }
  const live = S.projects.filter(p => !p.archived);
  S.pid = live.some(p => p.id === sel.pid) ? sel.pid : live[0]?.id ?? null;
  const want = chatOf(sel.cid);
  renderAll();
  // Главная — точка входа: открываем её, если владелец был там или выбора ещё нет вовсе.
  if (sel.view === 'dash' || (!selRaw && live.length)) {
    if (want && want.project_id === S.pid) S.cid = want.id;
    else if (S.pid) S.cid = chatsOf(S.pid).filter(c => !c.archived)[0]?.id ?? null;
    void openDash();
  }
  else if (want && want.project_id === S.pid) await selectChat(want.id);
  else if (S.pid) await selectProject(S.pid);
  connect();
  hideSplash();
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => settingsData().catch(() => { }), { timeout: 4000 });
  setInterval(() => {
    if (S.cid && isRunning(S.cid) && S.view !== 'dash') renderRunState();
    tickDash();
    renderRunPill();
  }, 1000);
  setInterval(() => { if (S.view === 'dash' && document.visibilityState === 'visible') loadServerStats(); }, 20000);
  autosize();
  voiceInit();
  // PWA: регистрируем service worker (нужен для установки и уведомлений на телефоне)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  navigator.serviceWorker?.addEventListener?.('message', e => {
    if (e.data?.open) selectChat(e.data.open);
    if (e.data?.updated) shellUpdated();
  });
  // Мобильная клавиатура меняет visual viewport, но не всегда 100vh.
  const viewport = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport?.height ?? innerHeight}px`);
  viewport();
  window.visualViewport?.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('scroll', viewport);
  // открытие конкретного чата по ссылке из уведомления
  const wantChat = new URLSearchParams(location.search).get('chat');
  if (wantChat && chatOf(wantChat)) { history.replaceState(null, '', '/'); selectChat(wantChat); }
})();
