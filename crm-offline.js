// CRM sin conexión: funciones puras (reserva de números, fila de envíos → estado en pantalla).
// Script clásico: en navegador expone window.CO; en Node, module.exports.
(function (g) {
  'use strict';

  // ── Reserva de números de cotización ──
  const necesitaReponer = (reserva, minimo = 5) => reserva.length < minimo;

  function tomarNumero(reserva) {
    if (!reserva.length) return { num: null, resto: [] };
    return { num: reserva[0], resto: reserva.slice(1) };
  }

  const cantidadAReservar = (reserva, objetivo = 10) => Math.max(0, objetivo - reserva.length);

  // ── Fila → estado en memoria ──
  const porCreada = (a, b) => (a.creada < b.creada ? -1 : a.creada > b.creada ? 1 : 0);
  const marca = (e) => ({ estado: e.estado, error: e.error || null, id: e.id });

  // Copia profunda: lo que entra a S no comparte referencias con los datos encolados.
  const clonar = (x) => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
  // Campos que una edición puede superponer sobre la cotización del servidor.
  const CAMPOS_EDITABLES = ['items', 'payment', 'conditions', 'notes', 'contact', 'nextAction', 'nextDate', 'listId', 'entrega', 'validDays'];

  // Agrega obj a la lista si no existe. Si ya existe y es nuestro (_fila), refresca la marca;
  // si existe sin _fila vino del servidor y gana (no se toca).
  function agregar(lista, obj, e) {
    if (!obj || obj.id == null) return;
    const actual = lista.find((x) => x.id === obj.id);
    if (!actual) lista.push({ ...clonar(obj), _fila: marca(e) });
    else if (actual._fila) actual._fila = marca(e);
  }

  function aplicarFilaCRM(S, entradas) {
    const pend = (entradas || []).filter((e) => e.estado === 'pendiente' || e.estado === 'problema').sort(porCreada);
    // Reversión: sin edición pendiente para la cotización, vuelven los valores del servidor
    // y se quita la marca si su entrada ya no está activa (enviada o desaparecida).
    const conEdicion = new Set(pend.filter((e) => e.tipo === 'crm.cotizacion.editar' && e.estado === 'pendiente').map((e) => (e.datos || {}).id));
    const activas = new Set(pend.map((e) => e.id));
    for (const q of S.quotes) {
      if (q._base && !conEdicion.has(q.id)) {
        Object.assign(q, clonar(q._base));
        delete q._base;
      }
      if (q._fila && !activas.has(q._fila.id)) delete q._fila;
    }
    // Lo agregado por la fila (visitas, prospectos, tareas, oportunidades) se queda en pantalla al
    // enviarse; solo pierde la marca "Pendiente de enviar".
    for (const k of ['visits', 'clients', 'tasks', 'opps']) {
      for (const x of S[k] || []) if (x._fila && !activas.has(x._fila.id)) delete x._fila;
    }
    for (const e of pend) superponerEntrada(S, e);
  }

  // Superpone una sola entrada (sin limpiar marcas de otras): para mostrar al tiro lo recién encolado.
  function superponerEntrada(S, e) {
    const d = e.datos || {};
    if (e.tipo === 'crm.visita') {
      if (d.prospecto) agregar(S.clients, d.prospecto, e);
      agregar(S.visits, d.visita, e);
      if (d.tarea && S.tasks) agregar(S.tasks, d.tarea, e);
      if (d.opp && d.opp.modo === 'nueva' && S.opps) agregar(S.opps, d.opp.obj, e);
    } else if (e.tipo === 'crm.cotizacion') {
      agregar(S.quotes, d.cotizacion, e);
    } else if (e.tipo === 'crm.cotizacion.editar') {
      const q = S.quotes.find((x) => x.id === d.id);
      if (!q) return;
      // Con varias ediciones pendientes de la misma cotización gana la última (orden por creada)
      // y _fila.id apunta a ella. En 'problema' (p. ej. CONFLICTO) no se toca nada del servidor:
      // la decisión del jefe no debe taparse; la versión del teléfono queda en datos.version_telefono.
      if (e.estado === 'pendiente') {
        if (!q._base) {
          // Original del servidor, no enumerable para que nunca se serialice.
          const base = {};
          for (const k of [...CAMPOS_EDITABLES, 'status']) base[k] = clonar(q[k]);
          Object.defineProperty(q, '_base', { value: base, enumerable: false, writable: true, configurable: true });
        }
        const cambios = d.cambios || {};
        for (const k of CAMPOS_EDITABLES) if (k in cambios) q[k] = clonar(cambios[k]);
        if (d.requiereAprobacion) q.status = 'pendiente';
      }
      q._fila = marca(e);
    }
  }

  // ── Visitas: el prospecto ya existía en el servidor (crm_resolver_cliente devolvió otro id) ──
  // Copia de los datos con visita, tarea y oportunidad apuntando al cliente nuevoId (no muta datos).
  function reasignarCliente(datos, nuevoId) {
    const r = clonar(datos);
    if (r.visita) r.visita.clientId = nuevoId;
    if (r.tarea) r.tarea.clientId = nuevoId;
    if (r.opp && r.opp.obj) r.opp.obj.clientId = nuevoId;
    return r;
  }

  // En memoria: quita el prospecto creado en el teléfono (no existe en el servidor) y mueve la
  // visita, tarea y oportunidad de esa entrada al cliente nuevoId.
  function reasignarEnS(S, datos, nuevoId) {
    const viejo = datos.prospecto && datos.prospecto.id;
    if (viejo && viejo !== nuevoId) {
      const i = S.clients.findIndex((c) => c.id === viejo);
      if (i >= 0) S.clients.splice(i, 1);
    }
    const mover = (lista, obj) => {
      const x = obj && (lista || []).find((y) => y.id === obj.id);
      if (x) x.clientId = nuevoId;
    };
    mover(S.visits, datos.visita);
    mover(S.tasks, datos.tarea);
    if (datos.opp && datos.opp.modo === 'nueva') mover(S.opps, datos.opp.obj);
  }

  // Entrada descartada: lo que solo existía por ella (marcado con su id) sale de S.
  function quitarEntrada(S, id) {
    // (cotizaciones: las edita el flujo de cotizaciones; una editada del servidor no debe salir)
    for (const k of ['visits', 'clients', 'tasks', 'opps']) {
      const l = S[k] || [];
      for (let i = l.length - 1; i >= 0; i--) if (l[i]._fila && l[i]._fila.id === id) l.splice(i, 1);
    }
  }

  // Envío directo (sin fila): lo agregado con el id ficticio deja de estar "Pendiente de enviar";
  // las demás marcas y ediciones de cotización no se tocan.
  function soltarEntrada(S, id) {
    for (const k of ['visits', 'clients', 'tasks', 'opps']) {
      for (const x of S[k] || []) if (x._fila && x._fila.id === id) delete x._fila;
    }
  }

  // Cliente elegido que solo existe en el teléfono (prospecto de otra visita aún sin enviar): se reenvía
  // como prospecto (crm_resolver_cliente es idempotente) para que la visita no dependa de que el otro envío
  // llegue con ese mismo id. Cliente del servidor → null.
  function prospectoParaFila(c) {
    if (!c || !c._fila) return null;
    const r = clonar({ ...c });
    delete r._fila;
    delete r._base;
    return r;
  }

  const MSG_CLIENTE_EXISTE = 'Ese RUT ya pertenece a un cliente de otro vendedor. Habla con tu jefatura.';
  // crm_resolver_cliente lanza 'CLIENTE_EXISTE: …' (cliente que este usuario no puede ver): regla, no se reintenta.
  function errorClienteExiste(error) {
    const m = typeof error === 'string' ? error : error && error.message;
    return typeof m === 'string' && m.includes('CLIENTE_EXISTE') ? MSG_CLIENTE_EXISTE : null;
  }
  const textoProspectoExistia = (nombre) => 'El prospecto «' + nombre + '» ya existía; la visita quedó en ese cliente.';

  const esConflicto = (error) => {
    const m = typeof error === 'string' ? error : error && error.message;
    return typeof m === 'string' && m.startsWith('CONFLICTO');
  };

  // Cómo se emite el PDF de una cotización.
  function estadoPdf(q) {
    if (q.status === 'pendiente') return 'sujeta';
    if (!q.num) return 'borrador';
    return 'oficial';
  }

  // Aviso de la barra cuando se muestra la copia local (hora local del equipo; si la copia es de otro
  // día se agrega " del D mmm"). modo 'sin-red': "Sin conexión · datos de las HH:MM";
  // modo 'cargando' (hay red pero la carga tarda): "Datos de las HH:MM · cargando datos actualizados…".
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  function textoCopia(guardadoEn, ahora = new Date(), modo = 'sin-red') {
    const d = new Date(guardadoEn);
    const p2 = (n) => String(n).padStart(2, '0');
    let cuando = 'datos guardados';
    if (!isNaN(d)) {
      cuando = 'datos de las ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
      if (d.toDateString() !== ahora.toDateString()) cuando += ' del ' + d.getDate() + ' ' + MESES[d.getMonth()];
    }
    if (modo === 'cargando') return cuando.charAt(0).toUpperCase() + cuando.slice(1) + ' · cargando datos actualizados…';
    return 'Sin conexión · ' + cuando;
  }

  // Firma de la fila visible (id:estado, en orden): si no cambia, no hace falta repintar.
  const firmaFila = (entradas) => (entradas || []).map((e) => e.id + ':' + e.estado).join('|');

  // El indicador de la fila sobra solo si el aviso de la copia ya dice "Sin conexión" y la fila no
  // tiene nada que contar (nunca se oculta con pendientes o problemas).
  const filaRedundante = (copiaSinRed, resumen) => !!copiaSinRed && !(resumen && (resumen.pendientes || resumen.problemas));

  // Una carga sigue vigente solo si no hubo escrituras desde que empezó (contador de escrituras).
  const snapshotVigente = (inicio, actual) => actual === inicio;

  const API = { necesitaReponer, tomarNumero, cantidadAReservar, aplicarFilaCRM, superponerEntrada, reasignarCliente, reasignarEnS, quitarEntrada, soltarEntrada, prospectoParaFila, errorClienteExiste, textoProspectoExistia, esConflicto, estadoPdf, textoCopia, firmaFila, filaRedundante, snapshotVigente };
  if (typeof window !== 'undefined') g.CO = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
