const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../crm-offline.js');

const ent = (id, tipo, datos, estado = 'pendiente', seg = 0, error = null) => ({
  id, tipo, datos, estado, error, creada: new Date(Date.UTC(2026, 10, 20, 10, 0, seg)).toISOString(),
});
const S0 = () => ({ clients: [], visits: [], quotes: [] });

test('necesitaReponer: 4 repone, 6 no, mínimo configurable', () => {
  assert.equal(C.necesitaReponer(['a', 'b', 'c', 'd']), true);
  assert.equal(C.necesitaReponer(['a', 'b', 'c', 'd', 'e', 'f']), false);
  assert.equal(C.necesitaReponer(['a', 'b', 'c'], 3), false);
});

test('tomarNumero: toma el primero; vacía devuelve null', () => {
  assert.deepEqual(C.tomarNumero(['1', '2', '3']), { num: '1', resto: ['2', '3'] });
  assert.deepEqual(C.tomarNumero([]), { num: null, resto: [] });
});

test('cantidadAReservar: completa hasta el objetivo, nunca negativo', () => {
  assert.equal(C.cantidadAReservar(['a', 'b', 'c', 'd']), 6);
  assert.equal(C.cantidadAReservar([]), 10);
  assert.equal(C.cantidadAReservar(new Array(12).fill('x')), 0);
  assert.equal(C.cantidadAReservar(['a'], 3), 2);
});

test('aplicarFilaCRM: visita con prospecto se agrega marcada', () => {
  const S = S0();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', { visita: { id: 'v1', clientId: 'c1' }, prospecto: { id: 'c1', name: 'X' } })]);
  assert.equal(S.visits.length, 1);
  assert.deepEqual(S.visits[0]._fila, { estado: 'pendiente', error: null, id: 'e1' });
  assert.equal(S.clients.length, 1);
  assert.equal(S.clients[0]._fila.id, 'e1');
});

test('aplicarFilaCRM: dos veces no duplica y actualiza el estado', () => {
  const S = S0();
  const e = ent('e1', 'crm.visita', { visita: { id: 'v1' }, prospecto: { id: 'c1' } });
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [{ ...e, estado: 'problema', error: 'boom' }]);
  assert.equal(S.visits.length, 1);
  assert.equal(S.clients.length, 1);
  assert.deepEqual(S.visits[0]._fila, { estado: 'problema', error: 'boom', id: 'e1' });
});

test('aplicarFilaCRM: lo que ya vino del servidor gana', () => {
  const S = S0();
  S.visits.push({ id: 'v1', lugar: 'servidor' });
  S.quotes.push({ id: 'q1', num: 'C-1', status: 'enviada' });
  C.aplicarFilaCRM(S, [
    ent('e1', 'crm.visita', { visita: { id: 'v1', lugar: 'telefono' }, prospecto: null }),
    ent('e2', 'crm.cotizacion', { cotizacion: { id: 'q1', num: null, status: 'pendiente' } }, 'pendiente', 1),
  ]);
  assert.equal(S.visits.length, 1);
  assert.equal(S.visits[0].lugar, 'servidor');
  assert.equal(S.visits[0]._fila, undefined);
  assert.equal(S.quotes.length, 1);
  assert.equal(S.quotes[0].num, 'C-1');
  assert.equal(S.quotes[0]._fila, undefined);
});

test('aplicarFilaCRM: entradas enviadas se ignoran', () => {
  const S = S0();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', { visita: { id: 'v1' } }, 'enviado')]);
  assert.equal(S.visits.length, 0);
});

test('aplicarFilaCRM: cotización nueva pendiente queda visible', () => {
  const S = S0();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion', { cotizacion: { id: 'q9', num: null, status: 'pendiente' } })]);
  assert.equal(S.quotes.length, 1);
  assert.equal(S.quotes[0]._fila.estado, 'pendiente');
});

const edicion = (estado, extra = {}, error = null) => ent('e1', 'crm.cotizacion.editar', {
  id: 'q1', base: 'x', cambios: { notes: 'nuevo', items: [1, 2] }, requiereAprobacion: false, nota: '',
  version_telefono: { id: 'q1', notes: 'nuevo', items: [1, 2], status: 'borrador', num: null, history: [], won: true },
  ...extra,
}, estado, 0, error);
const qServ = () => ({ id: 'q1', num: 'C-1', status: 'enviada', notes: 'viejo', items: [1], history: ['h1'], sentAt: 's' });

test('aplicarFilaCRM: edición pendiente superpone solo los campos editables', () => {
  const S = S0(); S.quotes.push(qServ());
  const e = edicion('pendiente');
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  const q = S.quotes[0];
  assert.equal(S.quotes.length, 1);
  assert.equal(q.notes, 'nuevo');
  assert.deepEqual(q.items, [1, 2]);
  assert.equal(q.status, 'enviada');
  assert.equal(q.num, 'C-1');
  assert.deepEqual(q.history, ['h1']);
  assert.equal(q.sentAt, 's');
  assert.equal(q.won, undefined);
  assert.deepEqual(q._fila, { estado: 'pendiente', error: null, id: 'e1' });
});

test('aplicarFilaCRM: requiereAprobacion deja la cotización en pendiente', () => {
  const S = S0(); S.quotes.push(qServ());
  C.aplicarFilaCRM(S, [edicion('pendiente', { requiereAprobacion: true })]);
  assert.equal(S.quotes[0].status, 'pendiente');
  assert.equal(S.quotes[0].num, 'C-1');
});

test('aplicarFilaCRM: _base guarda lo original, no es enumerable y sobrevive a reaplicar', () => {
  const S = S0(); S.quotes.push(qServ());
  const e = edicion('pendiente', { requiereAprobacion: true });
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  const q = S.quotes[0];
  assert.equal(q._base.notes, 'viejo');
  assert.deepEqual(q._base.items, [1]);
  assert.equal(q._base.status, 'enviada');
  assert.equal(Object.keys(q).includes('_base'), false);
  assert.equal(JSON.stringify(q).includes('_base'), false);
});

test('aplicarFilaCRM: edición con problema no cambia nada del servidor, solo marca', () => {
  const S = S0(); S.quotes.push(qServ());
  const e = edicion('problema', {}, 'CONFLICTO: cambió');
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  const q = S.quotes[0];
  assert.equal(q.status, 'enviada');
  assert.deepEqual(q.history, ['h1']);
  assert.equal(q.notes, 'viejo');
  assert.deepEqual(q.items, [1]);
  assert.equal(q._base, undefined);
  assert.deepEqual(q._fila, { estado: 'problema', error: 'CONFLICTO: cambió', id: 'e1' });
  assert.deepEqual(e.datos.version_telefono.items, [1, 2]);
});

test('aplicarFilaCRM: copias profundas, mutar S no toca los datos de la fila', () => {
  const S = S0(); S.quotes.push(qServ());
  const v = ent('e2', 'crm.visita', { visita: { id: 'v1', tags: ['a'] }, prospecto: null }, 'pendiente', 1);
  const ed = edicion('pendiente');
  C.aplicarFilaCRM(S, [v, ed]);
  S.visits[0].tags.push('b');
  S.quotes[0].items.push(99);
  assert.deepEqual(v.datos.visita.tags, ['a']);
  assert.deepEqual(ed.datos.cambios.items, [1, 2]);
});

test('aplicarFilaCRM: edición de cotización ausente no hace nada', () => {
  const S = S0();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion.editar', { id: 'zz', cambios: {}, version_telefono: { id: 'zz' } })]);
  assert.equal(S.quotes.length, 0);
});

test('esConflicto', () => {
  assert.equal(C.esConflicto('CONFLICTO: otra versión'), true);
  assert.equal(C.esConflicto(new Error('CONFLICTO x')), true);
  assert.equal(C.esConflicto('otro error'), false);
  assert.equal(C.esConflicto(null), false);
});

test('estadoPdf: oficial, sujeta, borrador', () => {
  assert.equal(C.estadoPdf({ status: 'pendiente', num: 'C-1' }), 'sujeta');
  assert.equal(C.estadoPdf({ status: 'borrador', num: null }), 'borrador');
  assert.equal(C.estadoPdf({ status: 'enviada', num: 'C-1' }), 'oficial');
});

// ── Reversión del overlay ──
const originalesOk = (q) => {
  assert.equal(q.status, 'enviada');
  assert.equal(q.notes, 'viejo');
  assert.deepEqual(q.items, [1]);
  assert.equal(q._base, undefined);
};

test('aplicarFilaCRM: pendiente → problema revierte el overlay y deja la marca', () => {
  const S = S0(); S.quotes.push(qServ());
  C.aplicarFilaCRM(S, [edicion('pendiente', { requiereAprobacion: true })]);
  assert.equal(S.quotes[0].status, 'pendiente');
  const e = edicion('problema', { requiereAprobacion: true }, 'CONFLICTO: x');
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  originalesOk(S.quotes[0]);
  assert.deepEqual(S.quotes[0]._fila, { estado: 'problema', error: 'CONFLICTO: x', id: 'e1' });
});

test('aplicarFilaCRM: pendiente → enviado revierte y quita la marca', () => {
  const S = S0(); S.quotes.push(qServ());
  C.aplicarFilaCRM(S, [edicion('pendiente', { requiereAprobacion: true })]);
  C.aplicarFilaCRM(S, [edicion('enviado')]);
  C.aplicarFilaCRM(S, [edicion('enviado')]);
  originalesOk(S.quotes[0]);
  assert.equal(S.quotes[0]._fila, undefined);
});

test('aplicarFilaCRM: pendiente → entrada desaparecida revierte y quita la marca', () => {
  const S = S0(); S.quotes.push(qServ());
  C.aplicarFilaCRM(S, [edicion('pendiente', { requiereAprobacion: true })]);
  C.aplicarFilaCRM(S, []);
  originalesOk(S.quotes[0]);
  assert.equal(S.quotes[0]._fila, undefined);
});

test('aplicarFilaCRM: si otra edición sigue pendiente el overlay se mantiene', () => {
  const S = S0(); S.quotes.push(qServ());
  const e1 = edicion('pendiente');
  const e2 = { ...edicion('pendiente'), id: 'e2', creada: '2026-11-20T11:00:00.000Z' };
  C.aplicarFilaCRM(S, [e1, e2]);
  C.aplicarFilaCRM(S, [{ ...e1, estado: 'problema', error: 'CONFLICTO' }, e2]);
  assert.equal(S.quotes[0].notes, 'nuevo');
  assert.ok(S.quotes[0]._base);
  assert.equal(S.quotes[0]._base.notes, 'viejo');
});

test('textoCopia: misma fecha muestra solo la hora', () => {
  const g = new Date(2026, 10, 20, 9, 5);
  assert.equal(C.textoCopia(g.toISOString(), new Date(2026, 10, 20, 18, 0)), 'Sin conexión · datos de las 09:05');
});

test('textoCopia: otro día agrega la fecha; inválida da texto genérico', () => {
  const g = new Date(2026, 10, 18, 17, 42);
  assert.equal(C.textoCopia(g.toISOString(), new Date(2026, 10, 20, 8, 0)), 'Sin conexión · datos de las 17:42 del 18 nov');
  assert.equal(C.textoCopia('x'), 'Sin conexión · datos guardados');
});

test('firmaFila: cambia con el estado, igual si no cambia nada', () => {
  const a = [ent('1', 'crm.visita', {}), ent('2', 'crm.cotizacion', {}, 'problema')];
  assert.equal(C.firmaFila(a), '1:pendiente|2:problema');
  assert.equal(C.firmaFila([]), '');
  assert.equal(C.firmaFila(undefined), '');
  assert.notEqual(C.firmaFila(a), C.firmaFila([a[0], { ...a[1], estado: 'pendiente' }]));
});
