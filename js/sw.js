const CACHE_NAME = "nase-20260530";
const STATIC_ASSETS = ["/", "/index.html", "/common.css", "/js/common.js"];
const PREFETCH_DATA = [
  "/data/news/meta.json",
  "/data/news/latest.json",
  "/data/news/analysis/index.json",
];
const MAX_CACHE_ENTRIES = 50; // Limit cached JSON responses

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_ASSETS);
      // 预缓存关键数据（不阻塞安装）
      for (const url of PREFETCH_DATA) {
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        } catch {}
      }
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

// Evict oldest entries when cache exceeds limit
async function evictOldEntries(cache) {
  const keys = await cache.keys();
  const jsonKeys = keys.filter((req) => req.url.includes("/data/"));
  if (jsonKeys.length <= MAX_CACHE_ENTRIES) return;
  const toDelete = jsonKeys.slice(0, jsonKeys.length - MAX_CACHE_ENTRIES);
  await Promise.all(toDelete.map((req) => cache.delete(req)));
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // All JSON data (analysis + news + meta): stale-while-revalidate with size limit
  if (url.pathname.endsWith(".json") && url.pathname.includes("/data/")) {
    e.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(e.request).then((cached) => {
          const fetchPromise = fetch(e.request)
            .then((res) => {
              if (res.ok) {
                cache.put(e.request, res.clone());
                evictOldEntries(cache); // Enforce limit after each write
              }
              return res;
            })
            .catch(() => cached);
          return cached || fetchPromise;
        }),
      ),
    );
    return;
  }

  // Static assets: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request)),
  );
});
