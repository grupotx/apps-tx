// Service worker: abre la app sin señal.
// Mismo origen: red primero, caché de respaldo. CDN con versión fija: caché primero.
// Otros orígenes (Supabase, mapas, OSM): no se interceptan.
const C = 'entregas-tx-v4';
const BASE = ['./', 'index.html', 'styles.css', 'app.js', 'planificacion.js', 'cliente.js', 'logistica.js', 'manifest.webmanifest', 'icon-512.png',
  '../offline-core.js', '../offline.js', '../foto-archivada.js'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(async c => {
    await c.addAll(BASE); // los archivos propios son obligatorios
    // las librerías de CDN van una a una: si una falla, la instalación no se cae (se cachea al primer uso)
    await Promise.all(CDN.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); } return r; })
      .catch(() => caches.match(req).then(m => m || caches.match(req, { ignoreSearch: true }))));
  } else if (CDN_HOSTS.includes(u.hostname)) {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(r => { if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(C).then(c => c.put(req, cp)); } return r; })));
  }
});
