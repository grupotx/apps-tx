// Entregas sin conexión: funciones puras (fila de envíos → guías en pantalla, argumentos de las RPC).
// Script clásico: en navegador expone window.EntregasOffline; en Node, module.exports.
(function (g) {
  'use strict';
  const T_LLEGADA = 'ent.llegada';
  const T_CIERRE = 'ent.cierre';

  const porCreada = (a, b) => (a.creada < b.creada ? -1 : a.creada > b.creada ? 1 : 0);

  // datos de 'ent.llegada' → argumentos de ent_marcar_llegada
  function argsLlegada(d) {
    return { p_guia: d.guia, p_patente: d.patente ?? null, p_lat: d.lat, p_lng: d.lng, p_precision: d.precision, p_at: d.at };
  }

  // datos de 'ent.cierre' → argumentos de ent_cerrar_entrega
  function argsCierre(d) {
    return {
      p_guia: d.guia, p_resultado: d.resultado, p_fotos: d.fotos, p_receptor_nombre: d.receptor_nombre,
      p_receptor_rut: d.receptor_rut ?? null, p_receptor_cargo: d.receptor_cargo ?? null,
      p_receptor_telefono: d.receptor_telefono ?? null, p_firma_path: d.firma, p_observacion: d.observacion ?? null,
      p_lat: d.lat ?? null, p_lng: d.lng ?? null, p_devoluciones: d.devoluciones || [], p_at: d.at,
    };
  }

  // Rutas fijas en el bucket para un intento de cierre (se guardan en la fila: los reintentos reusan las mismas).
  function rutasCierre(guiaId, ts, nFotos) {
    const fotos = [];
    for (let i = 0; i < nFotos; i++) fotos.push(`${guiaId}/foto_${ts}_${i + 1}.jpg`);
    return { fotos, firma: `${guiaId}/firma_${ts}.png` };
  }

  // id de la llegada de esa guía que sigue en la fila (pendiente o con problema), o null.
  function llegadaEnFila(entradas, guiaId) {
    const ls = (entradas || []).filter(e => e.tipo === T_LLEGADA && e.datos && e.datos.guia === guiaId
      && (e.estado === 'pendiente' || e.estado === 'problema')).sort(porCreada);
    return ls.length ? ls[ls.length - 1].id : null;
  }

  // Aplica a la lista de guías lo que aún está en la fila del teléfono.
  // - llegada pendiente → 'en_destino' (si la guía seguía 'asignada')
  // - cierre pendiente → estado = resultado del cierre
  // - con problema → se deja el estado del servidor
  // Cada guía tocada recibe g.fila = { estado: 'pendiente'|'problema', error, ids } (ids en orden de creación).
  function aplicarFila(guias, entradas) {
    const porGuia = new Map();
    for (const e of (entradas || []).slice().sort(porCreada)) {
      if (e.tipo !== T_LLEGADA && e.tipo !== T_CIERRE) continue;
      if (e.estado !== 'pendiente' && e.estado !== 'problema') continue;
      const id = e.datos && e.datos.guia;
      if (!id) continue;
      if (!porGuia.has(id)) porGuia.set(id, []);
      porGuia.get(id).push(e);
    }
    return (guias || []).map(g0 => {
      const es = porGuia.get(g0.id);
      if (!es) return g0;
      const g1 = Object.assign({}, g0);
      const problemas = es.filter(e => e.estado === 'problema');
      const cierre = es.filter(e => e.tipo === T_CIERRE && e.estado === 'pendiente').pop();
      const llegada = es.find(e => e.tipo === T_LLEGADA && e.estado === 'pendiente');
      if (cierre) g1.estado = cierre.datos.resultado;
      else if (llegada && g1.estado === 'asignada') g1.estado = 'en_destino';
      g1.fila = problemas.length
        ? { estado: 'problema', error: problemas[0].error || 'No se pudo enviar', ids: problemas.map(e => e.id) }
        : { estado: 'pendiente', error: null, ids: es.map(e => e.id) };
      return g1;
    });
  }

  const api = { T_LLEGADA, T_CIERRE, argsLlegada, argsCierre, rutasCierre, llegadaEnFila, aplicarFila };
  g.EntregasOffline = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
