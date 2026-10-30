const V = 'depo-v1';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/favicon.svg', '/icons/icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.pathname.startsWith('/api/') || u.pathname === '/app.js' && u.search) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && SHELL.includes(u.pathname)) caches.open(V).then(c => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chat = e.notification.data?.chat;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    for (const c of cl) { c.focus(); if (chat) c.postMessage({ open: chat }); return; }
    return self.clients.openWindow(chat ? `/?chat=${chat}` : '/');
  }));
});
