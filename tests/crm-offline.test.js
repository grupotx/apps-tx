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

test('aplicarFilaCRM: edición se superpone sobre la cotización existente', () => {
  const S = S0();
  S.quotes.push({ id: 'q1', num: 'C-1', status: 'enviada', notes: 'viejo', items: [1] });
  const e = ent('e1', 'crm.cotizacion.editar', {
    id: 'q1', base: 'x', cambios: { notes: 'nuevo', items: [1, 2] }, requiereAprobacion: false, nota: '',
    version_telefono: { id: 'q1', notes: 'nuevo', items: [1, 2], payment: 'contado' },
  }, 'problema', 0, 'CONFLICTO: cambió');
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  assert.equal(S.quotes.length, 1);
  assert.equal(S.quotes[0].notes, 'nuevo');
  assert.deepEqual(S.quotes[0].items, [1, 2]);
  assert.equal(S.quotes[0].payment, 'contado');
  assert.equal(S.quotes[0].num, 'C-1');
  assert.deepEqual(S.quotes[0]._fila, { estado: 'problema', error: 'CONFLICTO: cambió', id: 'e1' });
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
