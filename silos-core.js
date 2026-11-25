// Silos sin conexion: logica pura de la fila (mismo patron que terreno-core.js).
// Script clasico: en navegador expone window.SC; en Node, module.exports.
(function (g) {
  'use strict';

  // La ruta sube siempre al mismo lugar aunque se reintente: determinista por entrada e indice.
  const rutaFoto = (entradaId, i) => `${entradaId}/${i + 1}.jpg`;

  // Lo que se encola al guardar una solicitud sin conexion. Mismo contrato que TC.entradaRegistro:
  // `base` es la version que se estaba corrigiendo (para detectar cambios de otra persona mientras
  // no habia señal), `fotos` es solo la cantidad de nuevas (los blobs viajan aparte, en los archivos
  // de la fila), y `hechoEn` es la hora real, no la de sincronizacion.
  // `manual` (Tarea 6): true solo para la edicion manual del formulario completo (formSolicitud) —
  // Instalar/Evaluar/Retirar tambien corrigen la solicitud (cambian su estado) pero NO la dejan en true.
  // Es la unica entrada cuyo "Ver mi version" puede reabrir con seguridad el formulario completo
  // (vendedor, cliente, RUT, obra, direccion): ese formulario no tiene el permiso ni los campos de
  // Instalar/Retirar, asi que una entrada de esas nunca debe poder reabrirlo (ver bandaFilaSol).
  const entradaSolicitud = ({ id, fila, datos, fotos, base, baseFresca, registroId, clienteNuevo, hechoEn, manual }) => ({
    tipo: 'silos.solicitud',
    datos: {
      id, registroId: registroId || null, fila: fila || {}, datos: datos || {},
      fotosGuardadas: [], nFotosNuevas: Number(fotos) || 0,
      base: base || null, baseFresca: !!baseFresca, clienteNuevo: clienteNuevo || null, hechoEn,
      manual: !!manual,
    },
  });

  // Lo que se encola al registrar un evento (Instalacion, Mantencion, etc.) sin conexion. Los eventos
  // nunca se corrigen, solo se crean: a diferencia de entradaSolicitud no llevan `base` ni `registroId`.
  const entradaEvento = ({ id, tipo, fila, datos, fotos, hechoEn }) => ({
    tipo: 'silos.evento',
    datos: {
      id, tipo: tipo || null, fila: fila || {}, datos: datos || {},
      fotosGuardadas: [], nFotosNuevas: Number(fotos) || 0,
      hechoEn,
    },
  });

  // Mensaje literal que offline-core.js (procesarFila) pone en una entrada cuando la que debia ir antes
  // (dependeDe) termino con problema: no dice la causa, solo que depende de otra. Antes de mostrarlo se
  // sube por la cadena hasta la entrada cuyo error es el propio, para que se vea la causa real y no el
  // generico. Copiado de terreno-core.js: es generico sobre la forma {id, dependeDe, estado, error}.
  const MSG_DEPENDE = 'Depende de un registro con problema';
  const causaCadena = (entradas, entrada) => {
    const porId = new Map((entradas || []).map((e) => [e.id, e]));
    let actual = entrada; const vistos = new Set();
    while (actual && actual.error === MSG_DEPENDE && actual.dependeDe && !vistos.has(actual.id)) {
      vistos.add(actual.id);
      actual = porId.get(actual.dependeDe) || null;
    }
    return (actual && actual.error) || entrada.error;
  };

  // Todas las entradas unidas a `id` por `dependeDe`, en cualquier sentido (de quien depende de ella y de
  // quien ella depende): Reintentar y Descartar actuan sobre la cadena completa, nunca sobre un solo eslabon
  // (si no, uno queda huerfano: con problema sin botones, o enviandose antes que su dependencia). Copiado
  // de terreno-core.js: es generico sobre la forma {id, dependeDe, estado, error}.
  const cadenaCompleta = (entradas, id) => {
    const todas = entradas || [];
    const vistos = new Set([id]), cola = [id];
    while (cola.length) {
      const x = cola.shift();
      const e = todas.find((y) => y.id === x);
      if (e && e.dependeDe && !vistos.has(e.dependeDe)) { vistos.add(e.dependeDe); cola.push(e.dependeDe); }
      todas.forEach((y) => { if (y.dependeDe === x && !vistos.has(y.id)) { vistos.add(y.id); cola.push(y.id); } });
    }
    return [...vistos];
  };

  // Solo lo que depende de `id`, directa o transitivamente (nunca de qué depende `id`): la mitad de abajo de
  // `cadenaCompleta`. Copiado de terreno-core.js: es generico sobre la forma {id, dependeDe, estado, error}.
  const descendientes = (entradas, id) => {
    const todas = entradas || [];
    const vistos = new Set(), cola = [id];
    while (cola.length) {
      const x = cola.shift();
      todas.forEach((y) => { if (y.dependeDe === x && !vistos.has(y.id)) { vistos.add(y.id); cola.push(y.id); } });
    }
    return [...vistos];
  };

  // Mezcla lo pendiente con la lista de solicitudes ya cargada, sin mutar ninguna de las dos listas.
  // Mismo contrato que TC.aplicarFilaTerreno: una entrada que corrige una solicitud existente la
  // reemplaza en su sitio (asi no se ve doble); una nueva va al principio, en el orden en que llego.
  // `_fila` queda con `entradaId`/`estado`/`error` (el error sube por la cadena con causaCadena si la
  // entrada esta en problema). Los eventos (`silos.evento`) no pasan por aqui: nunca corrigen nada.
  const aplicarFilaSilos = (solicitudes, entradas) => {
    const lista = (solicitudes || []).slice();
    const nuevas = [];
    const rutaDe = (x) => (x && typeof x === 'object' ? x.ruta : x);
    (entradas || []).forEach((e) => {
      if (!e || e.tipo !== 'silos.solicitud' || !e.datos) return;
      const d = e.datos;
      const id = d.registroId || d.id || e.id;
      // Si ya hay un problema en esta solicitud se deja ese: es la unica entrada con Reintentar
      // y Descartar, y una pendiente posterior no debe taparlo. `manual` viaja para que bandaFilaSol
      // sepa si "Ver mi version" puede reabrir con seguridad el formulario completo (Tarea 6, Critical
      // de la revision: Instalar/Retirar nunca deben poder reabrirlo).
      let marca = { entradaId: e.id, estado: e.estado, error: e.estado === 'problema' ? causaCadena(entradas, e) : (e.error || null), manual: !!d.manual };
      let lugar = lista, idx = lista.findIndex((r) => r && r.id === id);
      if (idx < 0) { lugar = nuevas; idx = nuevas.findIndex((r) => r.id === id); }
      const previo = idx >= 0 ? lugar[idx] : { id };
      if (previo._fila && previo._fila.estado === 'problema' && e.estado !== 'problema') marca = previo._fila;
      const datos = { ...(previo._datos || {}), ...(d.datos || {}) };
      const fila = { ...previo, ...datos, ...(d.fila || {}), id, _datos: datos,
        fotos: (d.fotosGuardadas || []).map(rutaDe).filter(Boolean), _fila: marca };
      if (idx >= 0) lugar[idx] = fila; else nuevas.push(fila);
    });
    return [...nuevas, ...lista];
  };

  // La base responde con mensajes que empiezan con CONFLICTO: o NO_EXISTE:; se distinguen por
  // el prefijo porque el cliente no recibe un codigo aparte. Copiado de terreno-core.js.
  const msgDe = (error) => String((error && error.message) || error || '');
  const esConflicto = (error) => msgDe(error).startsWith('CONFLICTO:');
  const noExiste = (error) => msgDe(error).startsWith('NO_EXISTE:');
  // SIN_PERMISO: la fila y la version son correctas, pero la politica de UPDATE no deja tocarla en su
  // estado actual (p. ej. cambio de rol, o la solicitud avanzo de estado mientras no habia señal). A
  // diferencia de CONFLICTO/NO_EXISTE, ni "Reintentar" (mismo resultado: el permiso no cambia solo) ni
  // "Ver mi version" (reabrir el formulario no da permiso) arreglan esto: ver bandaFilaSol (Important
  // de la revision de la Tarea 6).
  const esSinPermiso = (error) => msgDe(error).startsWith('SIN_PERMISO:');
  const MSG_CONFLICTO = 'Otra persona corrigió este registro mientras no tenías señal. Revisa tu versión antes de volver a guardarla.';
  const MSG_SIN_PERMISO = 'Ya no tienes permiso para corregir esta solicitud (cambió de estado o de dueño mientras no tenías señal). Descártala: quien tenga el permiso deberá corregirla de nuevo.';

  // Igualdad profunda sin importar el orden de las llaves (jsonb no conserva el orden de inserción de
  // un objeto, así que comparar con JSON.stringify fallaría aunque el contenido sea el mismo). Los
  // arreglos sí comparan por orden. Copiado de terreno-core.js (igualProfundo).
  const igualProfundo = (a, b) => {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => igualProfundo(v, b[i]));
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && ka.every((k) => igualProfundo(a[k], b[k]));
    }
    return false;
  };

  // Si lo que el servidor tiene AHORA para esta solicitud es exactamente lo que esta entrada estaba por
  // mandar: una respuesta perdida justo después de aplicarse con éxito hace que el reintento (misma
  // entrada, misma `base` ya vieja) choque contra su propia versión nueva (CONFLICTO). Copiado del mismo
  // criterio de terreno-core.js (mismoContenido), con los campos que sil_guardar_solicitud compara/escribe:
  // `estado`, `silo_id` y `data` (el resto de la fila, como `updated_at`, no es contenido propio).
  const CAMPOS_CONTENIDO_SOLICITUD = ['estado', 'silo_id'];
  const mismoContenidoSolicitud = (actual, cuerpo) => !!actual && !!cuerpo
    && CAMPOS_CONTENIDO_SOLICITUD.every((k) => (actual[k] ?? null) === (cuerpo[k] ?? null))
    && igualProfundo(actual.data || {}, cuerpo.data || {});

  const API = { rutaFoto, entradaSolicitud, entradaEvento, aplicarFilaSilos, cadenaCompleta, descendientes, causaCadena, esConflicto, noExiste, esSinPermiso, MSG_CONFLICTO, MSG_SIN_PERMISO, igualProfundo, mismoContenidoSolicitud };
  if (typeof window !== 'undefined') g.SC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
