const V = 'depo-v29';
const SHELL = ['/', '/app.css', '/app.js', '/file-links.js', '/manifest.webmanifest', '/icons/favicon.svg', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png'];

async function refreshShell() {
  const fresh = [];
  for (const u of SHELL) {
    const r = await fetch(u, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok || r.redirected || r.headers.get('x-depo-page') === 'login') return false;
    fresh.push([u, r]);
  }
  const c = await caches.open(V);
  let changed = false;
  for (const [u, r] of fresh) {
    if (u !== '/app.js' && u !== '/app.css') continue;
    const old = await caches.match(u);
    if (old && (await old.text()) !== (await r.clone().text())) changed = true;
  }
  await Promise.all(fresh.map(([u, r]) => c.put(u, r)));
  if (changed) for (const cl of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) cl.postMessage({ updated: true });
  return true;
}
let refreshing = null;
const refreshSoon = () => { refreshing ??= refreshShell().catch(() => false).finally(() => { refreshing = null; }); return refreshing; };

self.addEventListener('install', e => {
  e.waitUntil(refreshShell().catch(() => { }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.search) return;
  const key = e.request.mode === 'navigate' && u.pathname === '/' ? '/' : u.pathname;
  if (!SHELL.includes(key)) return;
  e.respondWith(caches.match(key).then(hit => {
    const net = refreshSoon();
    if (hit) { e.waitUntil(net); return hit; }
    return fetch(e.request).catch(() => caches.match('/'));
  }));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { }
  e.waitUntil(self.registration.showNotification(d.title || 'Depo', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: d.chat || d.kind || 'depo', data: { chat: d.chat },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chat = e.notification.data?.chat;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) { c.focus(); if (chat) c.postMessage({ open: chat }); return; }
    return self.clients.openWindow(chat ? `/?chat=${chat}` : '/');
  }));
});
