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
    // La marca de entrega del PDF se rehace desde las entradas activas.
    for (const q of S.quotes) delete q._filaEntrega;
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
      if (d.prospecto) agregar(S.clients, d.prospecto, e);
      agregar(S.quotes, d.cotizacion, e);
      if (d.tarea && S.tasks) agregar(S.tasks, d.tarea, e);
      if (d.opp && d.opp.modo === 'nueva' && S.opps) agregar(S.opps, d.opp.obj, e);
    } else if (e.tipo === 'crm.cotizacion.entrega') {
      // Entrega del PDF sin enviar: línea de historia (sin duplicar), fecha de envío y borrador→enviada.
      // Marca aparte (_filaEntrega): la cotización sigue siendo del servidor (acciones, quitarEntrada).
      const q = S.quotes.find((x) => x.id === d.id);
      if (!q) return;
      const l = d.linea;
      if (l) {
        q.history = q.history || [];
        if (!q.history.some((h) => h && h.ts === l.ts && h.text === l.text && h.user === l.user)) q.history.push(clonar(l));
      }
      if (d.sentAt) q.sentAt = d.sentAt;
      if (d.aEnviada && q.status === 'borrador') q.status = 'enviada';
      // con varias entregas pendientes, un problema no queda tapado por una pendiente posterior
      if (!q._filaEntrega || q._filaEntrega.estado !== 'problema' || e.estado === 'problema') q._filaEntrega = marca(e);
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
    if (r.cotizacion) r.cotizacion.clientId = nuevoId;
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
    mover(S.quotes, datos.cotizacion);
    mover(S.tasks, datos.tarea);
    if (datos.opp && datos.opp.modo === 'nueva') mover(S.opps, datos.opp.obj);
  }

  // Entrada descartada: lo que solo existía por ella (marcado con su id) sale de S.
  // Una edición (tipo 'crm.cotizacion.editar') no agregó nada: la cotización es del servidor y se queda
  // (en 'problema' no tiene _base; su marca la quita aplicarFilaCRM).
  function quitarEntrada(S, id, tipo) {
    if (tipo === 'crm.cotizacion.editar') return;
    for (const k of ['visits', 'clients', 'tasks', 'opps']) {
      const l = S[k] || [];
      for (let i = l.length - 1; i >= 0; i--) if (l[i]._fila && l[i]._fila.id === id) l.splice(i, 1);
    }
    // Cotizaciones: solo la creada por la entrada (sin _base); una del servidor con edición pendiente se
    // queda (su reversión la hace aplicarFilaCRM).
    const qs = S.quotes || [];
    for (let i = qs.length - 1; i >= 0; i--) if (qs[i]._fila && qs[i]._fila.id === id && !qs[i]._base) qs.splice(i, 1);
  }

  // Ids de las entradas que dependen (en cadena, vía dependeDe) de la entrada id: se descartan con ella.
  function dependientes(entradas, id) {
    const out = [];
    const cola = [id];
    while (cola.length) {
      const p = cola.shift();
      for (const e of entradas || []) if (e.dependeDe === p && !out.includes(e.id) && e.id !== id) { out.push(e.id); cola.push(e.id); }
    }
    return out;
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
  const textoProspectoExistia = (nombre, que = 'la visita') => 'El prospecto «' + nombre + '» ya existía; ' + que + ' quedó en ese cliente.';

  // ── Edición de cotizaciones propias por la fila (crm_editar_cotizacion) ──
  const MSG_CONFLICTO = 'Otra persona cambió esta cotización. Revisa tu versión.';
  // Campos editables de la cotización (copia profunda), en camelCase como en S.
  function cambiosEdicion(q) {
    const c = {};
    for (const k of CAMPOS_EDITABLES) if (q && k in q) c[k] = clonar(q[k]);
    return c;
  }
  // p_cambios de crm_editar_cotizacion: nombres de columna (snake_case), solo las claves presentes.
  const SNAKE = { nextAction: 'next_action', nextDate: 'next_date', listId: 'list_id', validDays: 'valid_days' };
  function cambiosRPC(cambios) {
    const r = {};
    for (const k of Object.keys(cambios || {})) if (CAMPOS_EDITABLES.includes(k)) r[SNAKE[k] || k] = cambios[k];
    return r;
  }
  // Versión leída: updated_at CRUDO, tal como llegó del servidor (nunca por Date: trunca a ms y cambia la zona).
  const baseEdicion = (q) => (q && typeof q.updatedAt === 'string' && q.updatedAt ? q.updatedAt : null);
  const EDITABLE_SIN_RED = ['borrador', 'enviada', 'negociacion'];
  // ¿La edición puede ir por la fila (y así funcionar sin señal)? antes: la cotización como estaba; despues: editada.
  // → {ok:true,msg:null} o {ok:false,msg}: por qué esta edición necesita señal (va por el camino directo de siempre).
  function edicionPorFila(antes, despues, yo) {
    const no = (msg) => ({ ok: false, msg });
    if (!antes || antes.userId !== yo) return no('Editar la cotización de otro vendedor requiere señal.');
    if (!EDITABLE_SIN_RED.includes(antes.status)) return no('Las cotizaciones pendientes de aprobación, rechazadas, ganadas o perdidas solo se pueden editar con señal.');
    if (antes._fila) return no('Esta cotización aún no llega al servidor; edítala cuando se haya enviado.');
    if (!baseEdicion(antes)) return no('Esta cotización solo se puede editar con señal.');
    if (despues && (despues.clientId !== antes.clientId || despues.userId !== antes.userId || despues.date !== antes.date)) return no('Cambiar cliente, vendedor o fecha de emisión requiere señal.');
    return { ok: true, msg: null };
  }
  // JSON con claves ordenadas (jsonb no conserva el orden); null, undefined y '' cuentan igual.
  function canonico(x) {
    if (x === '' || x === undefined) x = null;
    if (Array.isArray(x)) return '[' + x.map(canonico).join(',') + ']';
    if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canonico(x[k])).join(',') + '}';
    return JSON.stringify(x);
  }
  // ¿Esta edición ya se aplicó? (el reintento de un envío que sí llegó, con la respuesta perdida, da CONFLICTO).
  // d: datos de la entrada {cambios (camelCase), nota, requiereAprobacion}; yo: id del usuario.
  // La prueba es la línea que la RPC escribe tal cual (p_nota, con el total) por este usuario, más los campos
  // iguales. Sin requiereAprobacion el estado además debe seguir editable; con ella, el estado puede haber
  // cambiado después por la jefatura (aprobó/rechazó: la edición ya estaba).
  function yaAplicada(row, d, yo) {
    if (!row || !d || !d.nota) return false;
    if (!(row.history || []).some((h) => h && h.user === yo && h.text === d.nota)) return false;
    if (!d.requiereAprobacion && !EDITABLE_SIN_RED.includes(row.status)) return false;
    const c = cambiosRPC(d.cambios);
    return Object.keys(c).every((k) => canonico(row[k]) === canonico(c[k]));
  }

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

  // Marca de agua del PDF ({texto, sub} o null). Sin número siempre "BORRADOR" (el número lo pone el servidor
  // al enviarse); pendiente → "SUJETA A APROBACIÓN" (se puede entregar); guardada como borrador → "BORRADOR";
  // rechazada → "RECHAZADA"; emitida o aprobada → sin marca.
  function marcaAguaPdf(q) {
    if (q.status === 'rechazada') return { texto: 'RECHAZADA', sub: null };
    if (!q.num) return { texto: 'BORRADOR', sub: q.status === 'pendiente' ? 'SUJETA A APROBACIÓN' : null };
    if (q.status === 'borrador') return { texto: 'BORRADOR', sub: null };
    if (estadoPdf(q) === 'sujeta') return { texto: 'SUJETA A APROBACIÓN', sub: null };
    return null;
  }

  // El cliente ya tiene el PDF: se envió (sentAt o historia "Enviada…") o se descargó/compartió.
  const pdfEntregado = (q) => !!(q && (q.sentAt || (q.history || []).some((h) => /^(Enviada|PDF descargado|PDF compartido)/.test((h && h.text) || ''))));

  // Aviso al vendedor: cotización rechazada cuyo PDF ya tiene el cliente. Deja de avisar al cerrarla
  // (perdida) o al duplicarla (la nueva lleva otro número).
  function alertaRechazo(q, quotes) {
    if (!q || q.status !== 'rechazada' || !pdfEntregado(q)) return null;
    if ((quotes || []).some((x) => x.dupFrom && x.dupFrom === q.num)) return null;
    return 'Contacta al cliente: la cotización ' + q.num + ' fue rechazada';
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

  const API = { necesitaReponer, tomarNumero, cantidadAReservar, aplicarFilaCRM, superponerEntrada, reasignarCliente, reasignarEnS, quitarEntrada, dependientes, soltarEntrada, prospectoParaFila, errorClienteExiste, textoProspectoExistia, esConflicto, MSG_CONFLICTO, cambiosEdicion, cambiosRPC, baseEdicion, edicionPorFila, yaAplicada, estadoPdf, marcaAguaPdf, pdfEntregado, alertaRechazo, textoCopia, firmaFila, filaRedundante, snapshotVigente };
  if (typeof window !== 'undefined') g.CO = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
