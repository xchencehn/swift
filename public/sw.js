// ⚠️ 删掉预缓存里的文件时版本号必须一起加：旧缓存里引用它的那份页面还会被拿出来用。
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const CACHE_PREFIX = `agent-studio:${SCOPE_PATH}:`;
const CACHE = `${CACHE_PREFIX}v9`;
// ⚠️ 删掉 vendor 里的 xterm 资源时 CACHE 的版本号必须一起加:旧 Service Worker
// 还缓存着引用它们的那份 index.html,不换名就会继续拿旧的,页面加载一个已经 404
// 的 vendor/xterm.js。
// Loaded resources are cached by fetch below. Do not download a second, unversioned
// copy of every startup script while the first page is still loading.
const ASSETS = ['/', '/favicon.svg'].map((path) => `${SCOPE_PATH}${path}` || '/');
self.addEventListener('install', (event) =>
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(async () => {
        // Swift no longer shows notifications. Retire subscriptions left by earlier
        // versions and close only notifications owned by this registration.
        try {
          await (await self.registration.pushManager?.getSubscription())?.unsubscribe();
        } catch {}
        try {
          for (const notification of await self.registration.getNotifications())
            notification.close();
        } catch {}
        return self.clients.claim();
      }),
  ),
);
self.addEventListener('fetch', (event) => {
  const pathname = new URL(event.request.url).pathname;
  if (
    event.request.method !== 'GET' ||
    pathname.startsWith(`${SCOPE_PATH}/api/`) ||
    pathname === `${SCOPE_PATH}/frontend-version.json` ||
    /\/machines\/[a-f0-9-]{36}\/(?:api\/|frontend-version\.json$)/.test(pathname)
  )
    return;
  // 带版本号的资源（?v=）地址一换内容才换，缓存里有就直接用，不再逐个回源确认：
  // 手机经中继一个来回几百毫秒，三十多个文件逐个确认就是好几秒（2026-09-24 实测）。
  // 页面本身与不带版本号的仍然先走网络，这样才发现得了新版本；离线时退回缓存。
  if (new URL(event.request.url).searchParams.has('v')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(event.request).then(
          (hit) =>
            hit ||
            fetch(event.request).then((response) => {
              if (response.ok) {
                // Clone before returning: the browser may consume the body while cache cleanup awaits.
                const copy = response.clone();
                event.waitUntil(
                  forgetOtherVersions(cache, event.request).then(() =>
                    cache.put(event.request, copy),
                  ),
                );
              }
              return response;
            }),
        ),
      ),
    );
    return;
  }
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) return response;
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
        return response;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(event.request))),
  );
});

// 同一个文件只留最新的一版，旧版本的地址不会再有页面来要。
function forgetOtherVersions(cache, request) {
  const pathname = new URL(request.url).pathname;
  return cache.keys().then((keys) =>
    Promise.all(
      keys
        .filter((key) => {
          const url = new URL(key.url);
          return url.pathname === pathname && url.searchParams.has('v') && key.url !== request.url;
        })
        .map((key) => cache.delete(key)),
    ),
  );
}
