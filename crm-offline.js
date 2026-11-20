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

  // Agrega obj a la lista si no existe. Si ya existe y es nuestro (_fila), refresca la marca;
  // si existe sin _fila vino del servidor y gana (no se toca).
  function agregar(lista, obj, e) {
    if (!obj || obj.id == null) return;
    const actual = lista.find((x) => x.id === obj.id);
    if (!actual) lista.push({ ...obj, _fila: marca(e) });
    else if (actual._fila) actual._fila = marca(e);
  }

  function aplicarFilaCRM(S, entradas) {
    const pend = (entradas || []).filter((e) => e.estado === 'pendiente' || e.estado === 'problema').sort(porCreada);
    for (const e of pend) {
      const d = e.datos || {};
      if (e.tipo === 'crm.visita') {
        if (d.prospecto) agregar(S.clients, d.prospecto, e);
        agregar(S.visits, d.visita, e);
      } else if (e.tipo === 'crm.cotizacion') {
        agregar(S.quotes, d.cotizacion, e);
      } else if (e.tipo === 'crm.cotizacion.editar') {
        const q = S.quotes.find((x) => x.id === d.id);
        if (!q) continue;
        // Superpone los campos editados en el teléfono (idempotente).
        const v = d.version_telefono || {};
        Object.assign(q, d.cambios || {}, v, { id: q.id });
        q._fila = marca(e);
      }
    }
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

  const API = { necesitaReponer, tomarNumero, cantidadAReservar, aplicarFilaCRM, esConflicto, estadoPdf };
  if (typeof window !== 'undefined') g.CO = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
