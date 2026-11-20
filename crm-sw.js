// Service worker del CRM (registrado con scope ./crm: no controla las otras apps del sitio).
// Mismo origen: red primero (con tope de espera si hay copia), caché de respaldo. CDN con versión fija: caché primero.
// Otros orígenes (Supabase, fuentes, mapas): no se interceptan.
const C = 'crm-v1';
const PREFIJO = 'crm-';      // al activar solo se borran cachés viejas del CRM (las de otras apps del sitio no se tocan)
const TOPE_RED_MS = 4000;    // con señal débil: pasado este tiempo, si hay copia en caché se sirve la copia
const BASE = ['crm.html', 'offline-core.js', 'offline.js', 'crm-offline.js', 'foto-archivada.js'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(async c => {
    await c.addAll(BASE); // los archivos propios son obligatorios
    // las librerías de CDN van una a una: si una falla, la instalación no se cae (se cachea al primer uso)
    await Promise.all(CDN.map(u => c.add(new Request(u, { mode: 'cors' })).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith(PREFIJO) && k !== C).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// La página puede pedirse como /crm, /crm.html o con ?…: sin copia exacta, una navegación usa crm.html.
const copiaDe = req => caches.match(req, { cacheName: C })
  .then(m => m || caches.match(req, { cacheName: C, ignoreSearch: true }))
  .then(m => m || (req.mode === 'navigate' ? caches.match('crm.html', { cacheName: C }) : undefined));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    const red = fetch(req);
    // la copia se actualiza aunque se haya servido la de caché (el SW sigue vivo hasta terminar)
    e.waitUntil(red.then(r => { if (r.ok) { const cp = r.clone(); return caches.open(C).then(c => c.put(req, cp)); } }).catch(() => {}));
    e.respondWith(new Promise(resolve => {
      let listo = false;
      const servir = r => { if (!listo) { listo = true; resolve(r); } };
      // pasado el tope, si hay copia se sirve; si no hay, se sigue esperando a la red
      const t = setTimeout(() => { copiaDe(req).then(m => { if (m) servir(m); }, () => {}); }, TOPE_RED_MS);
      red.then(r => { clearTimeout(t); servir(r); },
        () => { clearTimeout(t); copiaDe(req).then(m => servir(m || Response.error()), () => servir(Response.error())); });
    }));
  } else if (CDN_HOSTS.includes(u.hostname)) {
    e.respondWith(caches.match(req, { cacheName: C }).then(m => m || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') { const cp = r.clone(); e.waitUntil(caches.open(C).then(c => c.put(req, cp)).catch(() => {})); }
      return r;
    })));
  }
});
