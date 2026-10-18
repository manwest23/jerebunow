/* JerebuNow service worker: network first, so readings are always fresh when
   online; the last copy is shown when offline. Map tiles are left to the
   browser cache. */
const CACHE = "jerebunow-v17";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "i18n.js", "iqair.js", "fx.js", "map.js", "manifest.webmanifest",
  "icons/apple-touch-icon-v2.png", "icons/icon-192-v2.png", "data/api.json", "data/world.json", "data/history.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = url.pathname.endsWith("/data/api.json") ? new Request(url.origin + url.pathname) : e.request;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }))
  );
});

/* Haze alerts */
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || "JerebuNow", {
    body: m.body || "", tag: m.tag || "jerebunow", renotify: true,
    icon: "icons/icon-192-v2.png", badge: "icons/icon-192-v2.png",
    data: { url: m.url || "./" }
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(new URL("./", self.location.href).href) && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
