// sw.js: retires the service worker that Icon Recomposer 1.x installed.
//
// 1.x served its app shell cache-first, so a returning visitor would keep
// getting the old app. Browsers re-fetch this file on navigation, install this
// version, and it deletes the old caches, unregisters itself and reloads open
// pages so they load the current app from the network.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
