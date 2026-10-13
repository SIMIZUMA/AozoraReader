// アプリ本体をオフラインでも開けるようにするService Worker。
// 作品の本文は、アプリ側(index.html)が Cache Storage に保存する。
const V = 'aozora-shell-v7';
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
  const url = e.request.url;
  const save = (r) => { if (r.ok) caches.open(V).then((c) => c.put(url, r.clone())); return r; };
  const fresh = e.request.mode === 'navigate' || u.pathname.endsWith('/') || u.pathname.endsWith('/index.html') || u.pathname.endsWith('/data/catalog.json');
  if (fresh) {
    // ページ本体と作品一覧は、通信できるときは常に最新を取りに行く(古い版が残らないように)。通信できないときだけ保存分を使う。
    e.respondWith(
      fetch(url, { cache: 'no-cache' }).then(save).catch(() => caches.match(url).then((m) => m || caches.match('index.html'))),
    );
    return;
  }
  e.respondWith(caches.match(url).then((m) => m || fetch(e.request).then(save)));
});
