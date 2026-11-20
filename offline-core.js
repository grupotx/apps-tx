// Lógica pura de la fila de envíos sin conexión (sin red ni IndexedDB).
// Script clásico: en navegador expone window.TXOfflineCore; en Node, module.exports.
(function (g) {
  // Crea una entrada nueva de la fila, lista para guardarse como pendiente.
  function nuevaEntrada({ id, tipo, datos, archivos = [], dependeDe = null, ahora = new Date() }) {
    return {
      id, tipo, datos, archivos,
      estado: 'pendiente',
      intentos: 0,
      error: null,
      creada: ahora.toISOString(),
      dependeDe,
    };
  }

  // 'red' = reintentar luego; 'sesion' = hay que volver a ingresar; 'regla' = el servidor rechazó el dato.
  function clasificarError(e) {
    const msg = String((e && e.message) || e || '');
    const status = e && e.status;
    if (status === 401 || (e && e.code === 'PGRST301') || /JWT expired|invalid JWT|Auth session missing/i.test(msg)) return 'sesion';
    if (e instanceof TypeError || (e && e.name === 'AbortError')) return 'red';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'red';
    if (status === 0 || status === 408 || status === 429 || status >= 500) return 'red';
    return 'regla';
  }

  // Envía las pendientes en orden de creación. Se detiene ante error de red o sesión.
  async function procesarFila({ listar, guardar, enviar }) {
    const todas = await listar();
    const porId = new Map(todas.map(e => [e.id, e]));
    const cola = todas.filter(e => e.estado === 'pendiente')
      .sort((a, b) => (a.creada < b.creada ? -1 : a.creada > b.creada ? 1 : 0));
    let enviados = 0, problemas = 0, detenido = null;

    for (const e of cola) {
      if (e.dependeDe) {
        const padre = porId.get(e.dependeDe);
        if (padre && padre.estado === 'problema') {
          e.estado = 'problema';
          e.error = 'Depende de un registro con problema';
          await guardar(e);
          problemas++;
          continue;
        }
        if (padre && padre.estado === 'pendiente') continue; // se reintenta en otra pasada
      }
      try {
        await enviar(e);
        e.estado = 'enviado';
        e.error = null;
        await guardar(e);
        enviados++;
      } catch (err) {
        const tipo = clasificarError(err);
        if (tipo === 'red' || tipo === 'sesion') { detenido = tipo; break; }
        e.estado = 'problema';
        e.intentos += 1;
        e.error = String((err && err.message) || err);
        await guardar(e);
        problemas++;
      }
    }
    return { enviados, problemas, detenido };
  }

  function resumen(entradas) {
    return {
      pendientes: entradas.filter(e => e.estado === 'pendiente').length,
      problemas: entradas.filter(e => e.estado === 'problema').length,
    };
  }

  const api = { nuevaEntrada, clasificarError, procesarFila, resumen };
  g.TXOfflineCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
