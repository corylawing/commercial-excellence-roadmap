/*
 * Keeps Chat to Salesforce opening fast and offline-ready, and receives chats shared from WhatsApp
 * on Android (the manifest's share_target posts them here). Shared files wait in a cache only
 * until the page opens them, then they are deleted. Salesforce calls never go through this cache.
 */
const VERSION = 'c2s-shell-v3';
const SHARE = 'c2s-share-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'parser.js', 'zip.js', 'match.js', 'sf.js', 'conversations.js', 'autofill.js',
    'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key !== VERSION && key !== SHARE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

async function receiveShare(request) {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
    const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter(Boolean).join('\n');
    await caches.delete(SHARE);
    const cache = await caches.open(SHARE);
    let i = 0;
    for (const f of files) {
        await cache.put(`share/${i++}`, new Response(f, {
            headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `file-${i}`) }
        }));
    }
    await cache.put('share/meta', new Response(JSON.stringify({ count: i, text }), { headers: { 'content-type': 'application/json' } }));
    return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
        event.respondWith(receiveShare(req));
        return;
    }
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    // the app's own files: newest from the network, the saved copy when offline
    event.respondWith((async () => {
        try {
            const fresh = await fetch(req, { cache: 'no-cache' });
            if (fresh.ok && !url.search) {
                const copy = fresh.clone();
                caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
            }
            return fresh;
        } catch {
            const cached = await caches.match(req, { ignoreSearch: true });
            return cached || caches.match('index.html');
        }
    })());
});
