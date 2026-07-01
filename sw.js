/* 2026 世界盃推估器 — Service Worker
   策略：同源 App 殼層用 stale-while-revalidate（離線可用、回連時自動更新）；
   跨源請求（ESPN 比分／新聞、openfootball、Open-Meteo、翻譯、Google 字型）一律放行給瀏覽器，
   不攔截、不快取，確保即時資料永遠是最新。 */
const CACHE = 'wc2026-v4.5.2';
const SHELL = [
  './',
  './index.html',
  './世界盃資料.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u)))) // 個別加入：單檔失敗不拖垮整體
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨源放行（即時資料／字型）

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(cached => {
        const network = fetch(req).then(res => {
          if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});

// 允許頁面要求立即套用新版 SW
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });
