/* Momiji service worker. Bump VERSION on deploy to drop the app-shell caches. */
const VERSION = 'v1';
const STATIC = `momiji-static-${VERSION}`;
const PAGES = `momiji-pages-${VERSION}`;
// TTS clips are content-addressed (text/voice/rate/pitch in the URL), so they survive version bumps.
const AUDIO = 'momiji-audio';
const AUDIO_MAX = 3000;
const NAV_TIMEOUT = 4000;
const CACHE_FIRST = /^\/(assets|content|icons|kanjivg)\//;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = [STATIC, PAGES, AUDIO];
      for (const name of await caches.keys()) {
        if (name.startsWith('momiji-') && !keep.includes(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api/tts') {
    event.respondWith(ttsClip(event, url));
  } else if (url.pathname.startsWith('/api/')) {
    // /api/ai*, /api/progress, /api/nlp*, /api/health …: always live, never cached
  } else if (req.mode === 'navigate') {
    event.respondWith(navigate(event));
  } else if (CACHE_FIRST.test(url.pathname)) {
    // /content/*.json is not content-hashed: serve from cache, refresh in the background
    event.respondWith(cacheFirst(event, url.pathname.startsWith('/content/')));
  }
});

async function precache() {
  try {
    const res = await fetch(new Request('/', { cache: 'reload' }));
    if (res.ok && !res.redirected) await (await caches.open(PAGES)).put('/', res);
  } catch {
    /* offline during install: the shell is cached on the next navigation */
  }
  await (await caches.open(STATIC)).add('/icons/icon.svg').catch(() => undefined);
}

const cacheable = (res) => res.ok && res.status === 200 && res.type === 'basic' && !res.redirected;

async function cacheFirst(event, revalidate) {
  const req = event.request;
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) {
    if (revalidate) {
      event.waitUntil(
        fetch(req)
          .then((res) => (cacheable(res) ? cache.put(req, res) : undefined))
          .catch(() => undefined),
      );
    }
    return hit;
  }
  const res = await fetch(req);
  if (cacheable(res)) event.waitUntil(cache.put(req, res.clone()).catch(() => undefined));
  return res;
}

/** Network-first for page loads; falls back to the cached app shell when offline or slow. */
function navigate(event) {
  const network = fetch(event.request);
  event.waitUntil(
    network
      .then((res) => {
        if (!cacheable(res) || !(res.headers.get('content-type') || '').includes('text/html')) return;
        const copy = res.clone();
        return caches.open(PAGES).then((cache) => cache.put('/', copy));
      })
      .catch(() => undefined),
  );
  return (async () => {
    try {
      const res = await Promise.race([network, new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT, null))]);
      if (res) return res;
    } catch {
      /* offline */
    }
    const cached = await caches.match('/', { cacheName: PAGES });
    if (cached) return cached;
    return network.catch(offlinePage);
  })();
}

function offlinePage() {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Momiji — offline</title><body style="margin:0;padding:64px 20px;font-family:system-ui,sans-serif;text-align:center;color:#3c3c3c">
<div style="font-size:64px">🍁</div><h1 style="font-size:1.4rem">Momiji can't reach its server</h1>
<p style="color:#777">Make sure the Momiji server is running and you're on the same Wi-Fi, then try again.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:800;padding:12px 28px;border:0;border-radius:14px;background:#ff6b3d;color:#fff">Try again</button></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Cache-first TTS audio. Range requests (media elements) get a 206 slice of the cached clip. */
async function ttsClip(event, url) {
  const cache = await caches.open(AUDIO);
  let res = await cache.match(url.href);
  if (!res) {
    // fetch the whole clip (no Range header) so a complete 200 response gets cached
    res = await fetch(url.href, { credentials: 'same-origin' });
    if (cacheable(res)) event.waitUntil(cache.put(url.href, res.clone()).then(trimAudio).catch(() => undefined));
  }
  const range = event.request.headers.get('range');
  return range && res.status === 200 ? slice(res, range) : res;
}

async function slice(res, range) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return new Response(buf, { status: 200, headers: res.headers });
  let start = 0;
  let end = size - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else if (m[2]) {
    start = Math.max(0, size - Number(m[2]));
  }
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const headers = new Headers(res.headers);
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

let audioPuts = 0;
async function trimAudio() {
  if (audioPuts++ % 25) return;
  const cache = await caches.open(AUDIO);
  const keys = await cache.keys();
  // keys() is in insertion order: drop the oldest clips
  for (let i = 0; i < keys.length - AUDIO_MAX; i++) await cache.delete(keys[i]);
}
