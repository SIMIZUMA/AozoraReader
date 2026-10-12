// アプリ本体をオフラインでも開けるようにするService Worker。
// 作品の本文は、アプリ側(index.html)が Cache Storage に保存する。
const V = 'aozora-shell-v4';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('aozora-shell-') && k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  const save = (r) => { if (r.ok) caches.open(V).then((c) => c.put(e.request, r.clone())); return r; };
  if (u.pathname.endsWith('/data/catalog.json')) {
    // 作品一覧は毎日更新されるので、通信できるときは最新を優先する
    e.respondWith(fetch(e.request).then(save).catch(() => caches.match(e.request)));
    return;
  }
  // それ以外は、保存済みをすぐ返しつつ、裏で最新に更新する
  e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then(save)).then((r) => { fetch(e.request).then(save).catch(() => {}); return r; }));
});
