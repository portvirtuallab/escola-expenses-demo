// Service worker: makes the app installable and usable offline.
// App shell → stale-while-revalidate. Heavy libraries (OCR, PDF, fonts) → cache-first.
// API calls (Google Apps Script) and Google Sign-In are never cached.
const VERSION = 'v2.0.1';
const SHELL = `shell-${VERSION}`;
const LIBS = `libs-${VERSION}`;
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'app.css',
  'config.js', 'rules.js', 'app.js', 'store.js', 'backends.js', 'auth.js', 'data.js',
  'scanner.js', 'rates.js', 'pdf.js',
  'logo_blue.png', 'mark_white.png', 'mark_blue.png', 'icon-192.png', 'favicon-64.png',
  'inter-latin-wght-normal.woff2', 'pdf-lib.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, LIBS].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Google APIs, Sign-In and exchange rates go to the network
  if (/(tesseract|worker\.min|traineddata|pdf-lib|\.woff2)/.test(url.pathname)) {
    e.respondWith(caches.open(LIBS).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  const isPage = req.mode === 'navigate';
  e.respondWith(caches.open(SHELL).then(async c => {
    const cached = await c.match(isPage ? 'index.html' : req, { ignoreSearch: isPage });
    const network = fetch(req).then(r => { if (r.ok) c.put(isPage ? 'index.html' : req, r.clone()); return r; }).catch(() => cached);
    return cached || network;
  }));
});

// Downloads the receipt reader and PDF builder in the background so they also work offline.
const OFFLINE_LIBS = [
  'tesseract.min.js', 'worker.min.js',
  'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js',
  'eng.traineddata.gz', 'pdf-lib.min.js', 'inter-latin-ext-wght-normal.woff2'
];
self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
  if (e.data === 'warm-offline') e.waitUntil(caches.open(LIBS).then(async c => {
    for (const f of OFFLINE_LIBS) if (!(await c.match(f))) { try { const r = await fetch(f); if (r.ok) await c.put(f, r); } catch { /* retry next time */ } }
  }));
});
