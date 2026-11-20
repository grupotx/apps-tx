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

  // ---------- jornada y acciones de ruta ----------
  const T_JORNADA = 'ent.jornada';
  const T_RUTA = 'ent.ruta';

  // Patente para una llegada: la de la jornada; si no hay, la de la ruta de la guía; si no, null (hay que pedirla).
  function patenteParaLlegada(jornada, ruta) {
    const p = (jornada && jornada.patente) || (ruta && ruta.patente) || '';
    return String(p).trim() || null;
  }

  // datos de 'ent.jornada' → fila de ent_jornadas (id generado en el teléfono: reenviarla no duplica)
  function filaJornada(d) {
    return { id: d.id, chofer_id: d.chofer_id, patente: d.patente, fecha: d.fecha, inicio_at: d.inicio_at };
  }

  function argsRuta(d) { return { p_ruta: d.ruta, p_accion: d.accion }; }

  // Un reenvío de una acción de ruta que el servidor ya aplicó responde con estos errores: cuenta como enviado.
  function rutaYaHecha(accion, err) {
    const msg = String((err && err.message) || err || '');
    if (accion === 'aceptar') return /La ruta ya fue aceptada|La ruta ya salió/.test(msg);
    if (accion === 'salir') return /La ruta ya salió/.test(msg);
    return false;
  }

  // Aplica a las rutas las acciones aún en la fila: aceptar → 'aceptada' (si estaba 'asignada'),
  // salir → 'en_ruta' (si estaba 'asignada'/'aceptada'). Con problema se deja el estado del servidor.
  // Cada ruta tocada recibe r.fila = { estado, error, ids } como en aplicarFila.
  function aplicarFilaRutas(rutas, entradas) {
    const porRuta = new Map();
    for (const e of (entradas || []).slice().sort(porCreada)) {
      if (e.tipo !== T_RUTA || (e.estado !== 'pendiente' && e.estado !== 'problema')) continue;
      const id = e.datos && e.datos.ruta;
      if (!id) continue;
      if (!porRuta.has(id)) porRuta.set(id, []);
      porRuta.get(id).push(e);
    }
    return (rutas || []).map(r0 => {
      const es = porRuta.get(r0.id);
      if (!es) return r0;
      const r1 = Object.assign({}, r0);
      const problemas = es.filter(e => e.estado === 'problema');
      for (const e of es) {
        if (e.estado !== 'pendiente') continue;
        if (e.datos.accion === 'aceptar' && r1.estado === 'asignada') r1.estado = 'aceptada';
        if (e.datos.accion === 'salir' && (r1.estado === 'asignada' || r1.estado === 'aceptada')) r1.estado = 'en_ruta';
      }
      r1.fila = problemas.length
        ? { estado: 'problema', error: problemas[0].error || 'No se pudo enviar', ids: problemas.map(e => e.id) }
        : { estado: 'pendiente', error: null, ids: es.map(e => e.id) };
      return r1;
    });
  }

  const api = { T_LLEGADA, T_CIERRE, T_JORNADA, T_RUTA, argsLlegada, argsCierre, rutasCierre, llegadaEnFila, aplicarFila,
    patenteParaLlegada, filaJornada, argsRuta, rutaYaHecha, aplicarFilaRutas };
  g.EntregasOffline = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
