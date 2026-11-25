// Service worker de Mantención (registrado con scope ./mantencion: no controla las otras apps del sitio).
// Mismo origen: red primero (con tope de espera si hay copia), caché de respaldo. CDN con versión fija: caché primero.
// Otros orígenes (Supabase, fuentes): no se interceptan.
const C = 'mantencion-v1';
const PREFIJO = 'mantencion-';  // al activar solo se borran cachés viejas de Mantención (las de otras apps del sitio no se tocan)
const TOPE_RED_MS = 4000;    // con señal débil: pasado este tiempo, si hay copia en caché se sirve la copia
const BASE = ['mantencion.html', 'offline-core.js', 'offline.js', 'mantencion-core.js'];
const CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js'
];
const CDN_HOSTS = ['cdn.jsdelivr.net'];
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

// La página puede pedirse como /mantencion, /mantencion.html o con ?…: sin copia exacta, una navegación usa mantencion.html.
const copiaDe = req => caches.match(req, { cacheName: C })
  .then(m => m || caches.match(req, { cacheName: C, ignoreSearch: true }))
  .then(m => m || (req.mode === 'navigate' ? caches.match('mantencion.html', { cacheName: C }) : undefined));

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
      if (r.ok) { const cp = r.clone(); e.waitUntil(caches.open(C).then(c => c.put(req, cp)).catch(() => {})); }
      // Respuesta opaca (la etiqueta <script> no usa crossorigin) o fallida: no se guarda tal cual (un 5xx quedaría para siempre).
      // Se sirve a la página y, en paralelo, se pide la misma URL con CORS y se guarda solo si viene ok: así la caché se cura sola.
      else e.waitUntil(fetch(new Request(req.url, { mode: 'cors' })).then(x => x.ok ? caches.open(C).then(c => c.put(req.url, x)) : undefined).catch(() => {}));
      return r;
    })));
  }
});
