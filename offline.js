// Capa de navegador de la fila de envíos sin conexión (IndexedDB + red + indicador).
// Script clásico; requiere offline-core.js cargado antes. Expone window.TXOffline.
// registrarTipo(tipo, enviar(datos, archivos, { id, intentos })): id estable para deduplicar reintentos.
  // Importante: llamar registrarTipo() para todos los tipos ANTES de iniciar().
(function (g) {
  'use strict';
  const Core = g.TXOfflineCore;
  const TOPE_CONSULTA_MS = 8000;
  const INTERVALO_MS = 60000;
  const MARGEN_TOKEN_MS = 60000;
  const RETENCION_ENVIADOS_MS = 24 * 3600 * 1000;

  let db = null, nombreDb = null, sb = null;
  let temporizador = null, escuchas = null;
  let enCurso = null, repetir = false, persistPedido = false;
  const handlers = {};

  // ---------- IndexedDB (envoltorio mínimo) ----------
  function abrir(nombre) {
    return new Promise((ok, mal) => {
      const r = indexedDB.open(nombre, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['consultas', 'fila', 'archivos'].forEach(s => {
          if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, s === 'fila' ? { keyPath: 'id' } : undefined);
        });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => mal(r.error);
    });
  }
  // Ejecuta fn(store) dentro de una transacción y resuelve con el resultado del request devuelto.
  function op(almacen, modo, fn) {
    return new Promise((ok, mal) => {
      if (!db) return mal(new Error('TXOffline no está iniciado'));
      const t = db.transaction(almacen, modo);
      const req = fn(t.objectStore(almacen));
      t.oncomplete = () => ok(req ? req.result : undefined);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error || new Error('Transacción abortada'));
    });
  }
  const leer = (a, k) => op(a, 'readonly', s => s.get(k));
  const todos = a => op(a, 'readonly', s => s.getAll());
  const poner = (a, v, k) => op(a, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k)));
  const borrar = (a, k) => op(a, 'readwrite', s => s.delete(k));

  // ---------- Utilidades ----------
  function msgDe(e) { return String((e && e.message) || e || ''); }

  // Todo error de un handler que no tenga forma de red/sesión se registra y se relanza como Error
  // plano (clasifica 'regla' -> 'problema'); así un bug no detiene la fila en silencio.
  function esRedOSesion(e) {
    const t = Core.clasificarError(e);
    if (t === 'sesion') return true;
    if (e instanceof TypeError) return /^(failed to fetch|networkerror|load failed)/i.test(msgDe(e));
    return t === 'red';
  }
  function envolver(fn) {
    return async function (datos, archivos, meta) {
      try {
        return await fn(datos, archivos, meta);
      } catch (e) {
        if (esRedOSesion(e)) throw e;
        console.error('[TXOffline] error no de red en un envío:', e);
        throw new Error(msgDe(e));
      }
    };
  }

  // Una sola pasada a la vez entre pestañas (Web Locks); sin soporte, se sigue como antes.
  async function conBloqueo(fn) {
    if (!g.navigator || !g.navigator.locks) return fn();
    return g.navigator.locks.request('tx-offline-' + nombreDb, { ifAvailable: true }, async lock => {
      if (!lock) return { enviados: 0, problemas: 0, detenido: null, omitido: true };
      return fn();
    });
  }

  async function cargarArchivos(entrada) {
    const out = {};
    const pref = entrada.id + '/';
    for (const clave of entrada.archivos) {
      const blob = await leer('archivos', clave);
      if (blob) out[clave.startsWith(pref) ? clave.slice(pref.length) : clave] = blob;
    }
    return out;
  }

  async function emitir() {
    if (!db) return;
    const lista = await todos('fila');
    const r = Core.resumen(lista);
    g.dispatchEvent(new CustomEvent('txoffline:cambio', { detail: r }));
    return r;
  }

  // Comprueba/renueva la sesión antes de enviar. Devuelve null si está bien, o 'red' | 'sesion'.
  async function asegurarSesion() {
    try {
      const { data, error } = await sb.auth.getSession();
      if (error) throw error;
      const s = data && data.session;
      if (!s) return 'sesion';
      if (s.expires_at && s.expires_at * 1000 - Date.now() < MARGEN_TOKEN_MS) {
        const r = await sb.auth.refreshSession();
        if (r.error) throw r.error;
        if (!r.data || !r.data.session) return 'sesion';
      }
      return null;
    } catch (e) {
      const t = Core.clasificarError(e);
      return t === 'red' ? 'red' : 'sesion';
    }
  }

  async function limpiar() {
    const lista = await todos('fila');
    const ahora = Date.now();
    for (const e of lista) {
      if (e.estado !== 'enviado') continue;
      for (const clave of e.archivos || []) await borrar('archivos', clave);
      if (e.enviadaEn && ahora - Date.parse(e.enviadaEn) > RETENCION_ENVIADOS_MS) await borrar('fila', e.id);
    }
  }

  async function pasada() {
    const falla = await asegurarSesion();
    if (falla) return { enviados: 0, problemas: 0, detenido: falla };
    const r = await Core.procesarFila({
      listar: () => todos('fila'),
      guardar: e => {
        if (e.estado === 'enviado' && !e.enviadaEn) e.enviadaEn = new Date().toISOString();
        return poner('fila', e);
      },
      enviar: async e => {
        const h = handlers[e.tipo];
        if (!h) throw new Error('Tipo de envío no registrado: ' + e.tipo);
        await h(e.datos, await cargarArchivos(e), { id: e.id, intentos: e.intentos });
      },
    });
    await limpiar();
    return r;
  }

  // ---------- API ----------
  function registrarTipo(tipo, enviar) { handlers[tipo] = envolver(enviar); }

  function sincronizar() {
    if (!db) return Promise.resolve({ enviados: 0, problemas: 0, detenido: null });
    if (enCurso) { repetir = true; return enCurso; }
    enCurso = (async () => {
      const total = { enviados: 0, problemas: 0, detenido: null };
      try {
        do {
          repetir = false;
          const r = await conBloqueo(pasada);
          total.enviados += r.enviados; total.problemas += r.problemas; total.detenido = r.detenido;
          if (r.detenido || r.omitido) break;
        } while (repetir);
      } catch (e) {
        console.error('[TXOffline] error al sincronizar:', e);
      } finally {
        enCurso = null; repetir = false;
        try { await emitir(); } catch (_) { /* base cerrada */ }
      }
      return total;
    })();
    return enCurso;
  }

  async function iniciar({ app, sb: cliente, usuarioId }) {
    if (!Core) throw new Error('Falta cargar offline-core.js antes de offline.js');
    if (db) db.close();
    sb = cliente;
    nombreDb = 'tx-offline-' + app + '-' + usuarioId;
    db = await abrir(nombreDb);
    // pide almacenamiento persistente: sin esto Android puede borrar la fila con poco espacio
    if (!persistPedido) try { persistPedido = true; const p = g.navigator && g.navigator.storage && g.navigator.storage.persist && g.navigator.storage.persist(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* sin soporte */ }
    const disparar = () => { sincronizar(); };
    if (escuchas) g.removeEventListener('online', escuchas);
    escuchas = disparar;
    g.addEventListener('online', disparar);
    if (temporizador) clearInterval(temporizador);
    temporizador = setInterval(disparar, INTERVALO_MS);
    await emitir();
    disparar();
  }

  async function encolar(tipo, datos, opciones) {
    const { archivos = {}, dependeDe = null } = opciones || {};
    const id = crypto.randomUUID();
    const claves = [];
    for (const nombre of Object.keys(archivos)) {
      const clave = id + '/' + nombre;
      await poner('archivos', archivos[nombre], clave);
      claves.push(clave);
    }
    await poner('fila', Core.nuevaEntrada({ id, tipo, datos, archivos: claves, dependeDe }));
    await emitir();
    sincronizar();
    return id;
  }

  async function consultar(clave, fn) {
    let timer;
    try {
      const tope = new Promise((_, mal) => {
        timer = setTimeout(() => { const e = new Error('Tiempo de espera agotado'); e.name = 'AbortError'; mal(e); }, TOPE_CONSULTA_MS);
      });
      const datos = await Promise.race([Promise.resolve().then(fn), tope]);
      const guardadoEn = new Date().toISOString();
      try { await poner('consultas', { datos, guardadoEn }, clave); } catch (_) { /* sin caché, no es grave */ }
      return { datos, desdeCache: false, guardadoEn };
    } catch (e) {
      if (Core.clasificarError(e) !== 'red') throw e;
      const copia = await leer('consultas', clave).catch(() => null);
      if (!copia) throw e;
      return { datos: copia.datos, desdeCache: true, guardadoEn: copia.guardadoEn };
    } finally {
      clearTimeout(timer);
    }
  }

  // Corrige en el sitio la copia guardada de una consulta (p. ej. una fila que ya se envió y volvió del
  // servidor), en una sola transacción. fn(datos) la modifica (o devuelve otra). Sin copia, no hace nada.
  function ajustarConsulta(clave, fn) {
    return new Promise((ok, mal) => {
      if (!db) return mal(new Error('TXOffline no está iniciado'));
      const t = db.transaction('consultas', 'readwrite');
      const s = t.objectStore('consultas');
      let hubo = false;
      const r = s.get(clave);
      r.onsuccess = () => {
        const c = r.result;
        if (!c || c.datos === undefined) return;
        let d;
        try { d = fn(c.datos); } catch (e) { t.abort(); return; }
        s.put({ datos: d === undefined ? c.datos : d, guardadoEn: c.guardadoEn }, clave);
        hubo = true;
      };
      t.oncomplete = () => ok(hubo);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error || new Error('Transacción abortada'));
    });
  }

  // Almacenamiento local simple (borradores, preferencias): mismo almacén 'consultas', prefijo propio.
  async function guardarLocal(clave, valor) { await poner('consultas', valor, 'local:' + clave); }
  async function leerLocal(clave) {
    const v = await leer('consultas', 'local:' + clave);
    return v === undefined ? null : v;
  }

  async function entradas() {
    const lista = await todos('fila');
    return lista.filter(e => e.estado === 'pendiente' || e.estado === 'problema')
      .sort((a, b) => (a.creada < b.creada ? -1 : a.creada > b.creada ? 1 : 0));
  }

  async function reintentar(id) {
    const e = await leer('fila', id);
    if (e && e.estado === 'problema') {
      e.estado = 'pendiente';
      await poner('fila', e);
      await emitir();
    }
    await sincronizar();
  }

  // Solo entradas con problema; { aunPendiente: true } también descarta una pendiente (p. ej. la que
  // depende de una entrada descartada y ya no podría enviarse).
  async function descartar(id, opciones) {
    const e = await leer('fila', id);
    const aun = !!(opciones && opciones.aunPendiente);
    if (!e || !(e.estado === 'problema' || (aun && e.estado === 'pendiente'))) return;
    for (const clave of e.archivos || []) await borrar('archivos', clave);
    await borrar('fila', id);
    await emitir();
  }

  function montarIndicador(el) {
    let ultimo = { pendientes: 0, problemas: 0 };
    function pintar() {
      const partes = [];
      const sinRed = g.navigator && g.navigator.onLine === false;
      if (sinRed) partes.push('Sin conexión');
      if (ultimo.pendientes) partes.push(ultimo.pendientes + (ultimo.pendientes === 1 ? ' pendiente' : ' pendientes') + ' de enviar');
      if (ultimo.problemas) partes.push(ultimo.problemas + ' con problema');
      el.textContent = partes.join(' · ');
      el.hidden = partes.length === 0;
      el.style.color = ultimo.problemas ? '#c62828' : '';
      el.dataset.estado = ultimo.problemas ? 'problema' : sinRed ? 'sin-conexion' : ultimo.pendientes ? 'pendiente' : 'ok';
    }
    g.addEventListener('txoffline:cambio', ev => { ultimo = ev.detail; pintar(); });
    g.addEventListener('online', pintar);
    g.addEventListener('offline', pintar);
    pintar();
    if (db) emitir().catch(() => {});
  }

  async function puedeCerrarSesion() {
    if (!db) return true;
    const r = Core.resumen(await todos('fila'));
    return r.pendientes === 0 && r.problemas === 0;
  }

  async function alCerrarSesion() {
    if (temporizador) { clearInterval(temporizador); temporizador = null; }
    if (escuchas) { g.removeEventListener('online', escuchas); escuchas = null; }
    const nombre = nombreDb;
    if (db) { db.close(); db = null; }
    if (!nombre) return;
    await new Promise(ok => {
      const r = indexedDB.deleteDatabase(nombre);
      r.onsuccess = r.onerror = r.onblocked = () => ok();
    });
  }

  g.TXOffline = { iniciar, registrarTipo, encolar, sincronizar, consultar, ajustarConsulta, guardarLocal, leerLocal, entradas, reintentar, descartar, montarIndicador, puedeCerrarSesion, alCerrarSesion };
})(window);
