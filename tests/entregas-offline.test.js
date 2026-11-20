const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../entregas-tx/entregas-offline.js');

const ent = (id, tipo, guia, estado, seg, extra = {}) => ({
  id, tipo, estado, datos: { guia, ...(extra.datos || {}) }, error: extra.error || null,
  creada: new Date(Date.UTC(2026, 10, 19, 10, 0, seg)).toISOString(),
});
const guia = (id, estado) => ({ id, estado, folio: 'F' + id });

test('aplicarFila: sin entradas devuelve las mismas guías', () => {
  const gs = [guia('a', 'asignada')];
  const r = E.aplicarFila(gs, []);
  assert.equal(r[0], gs[0]);
  assert.equal(r[0].fila, undefined);
});

test('aplicarFila: llegada pendiente → en_destino con fila pendiente', () => {
  const r = E.aplicarFila([guia('a', 'asignada'), guia('b', 'asignada')], [ent('L1', 'ent.llegada', 'a', 'pendiente', 1)]);
  assert.equal(r[0].estado, 'en_destino');
  assert.deepEqual(r[0].fila, { estado: 'pendiente', error: null, ids: ['L1'] });
  assert.equal(r[1].estado, 'asignada');
  assert.equal(r[1].fila, undefined);
});

test('aplicarFila: no muta las guías originales', () => {
  const gs = [guia('a', 'asignada')];
  E.aplicarFila(gs, [ent('L1', 'ent.llegada', 'a', 'pendiente', 1)]);
  assert.equal(gs[0].estado, 'asignada');
  assert.equal(gs[0].fila, undefined);
});

test('aplicarFila: cierre pendiente → estado del resultado', () => {
  const r = E.aplicarFila([guia('a', 'en_destino')], [
    ent('L1', 'ent.llegada', 'a', 'pendiente', 1),
    ent('C1', 'ent.cierre', 'a', 'pendiente', 2, { datos: { resultado: 'entregada_con_devolucion' } }),
  ]);
  assert.equal(r[0].estado, 'entregada_con_devolucion');
  assert.deepEqual(r[0].fila.ids, ['L1', 'C1']);
  assert.equal(r[0].fila.estado, 'pendiente');
});

test('aplicarFila: llegada pendiente no retrocede una guía ya cerrada en el servidor', () => {
  const r = E.aplicarFila([guia('a', 'entregada')], [ent('L1', 'ent.llegada', 'a', 'pendiente', 1)]);
  assert.equal(r[0].estado, 'entregada');
});

test('aplicarFila: con problema deja el estado del servidor y expone motivo e ids de problemas', () => {
  const r = E.aplicarFila([guia('a', 'asignada')], [
    ent('C1', 'ent.cierre', 'a', 'problema', 2, { error: 'Depende de un registro con problema', datos: { resultado: 'entregada' } }),
    ent('L1', 'ent.llegada', 'a', 'problema', 1, { error: 'La guía fue anulada' }),
  ]);
  assert.equal(r[0].estado, 'asignada');
  assert.deepEqual(r[0].fila, { estado: 'problema', error: 'La guía fue anulada', ids: ['L1', 'C1'] });
});

test('aplicarFila: ignora otros tipos y entradas enviadas', () => {
  const r = E.aplicarFila([guia('a', 'asignada')], [
    ent('X', 'otro.tipo', 'a', 'pendiente', 1),
    ent('L1', 'ent.llegada', 'a', 'enviado', 2),
  ]);
  assert.equal(r[0].fila, undefined);
  assert.equal(r[0].estado, 'asignada');
});

test('llegadaEnFila: devuelve la última llegada pendiente/problema de la guía', () => {
  const es = [
    ent('L0', 'ent.llegada', 'a', 'enviado', 0),
    ent('L1', 'ent.llegada', 'a', 'pendiente', 1),
    ent('L2', 'ent.llegada', 'b', 'pendiente', 2),
    ent('C1', 'ent.cierre', 'a', 'pendiente', 3),
  ];
  assert.equal(E.llegadaEnFila(es, 'a'), 'L1');
  assert.equal(E.llegadaEnFila(es, 'b'), 'L2');
  assert.equal(E.llegadaEnFila(es, 'c'), null);
  assert.equal(E.llegadaEnFila([ent('L3', 'ent.llegada', 'a', 'problema', 5)], 'a'), 'L3');
});

test('rutasCierre: mismas rutas que hoy (foto_ts_i.jpg y firma_ts.png)', () => {
  assert.deepEqual(E.rutasCierre('g1', 1700, 2), { fotos: ['g1/foto_1700_1.jpg', 'g1/foto_1700_2.jpg'], firma: 'g1/firma_1700.png' });
});

test('argsLlegada: incluye p_at con la hora del registro', () => {
  assert.deepEqual(E.argsLlegada({ guia: 'g', patente: 'ABCD12', lat: -33.4, lng: -70.6, precision: 12, at: '2026-11-19T10:00:00.000Z' }),
    { p_guia: 'g', p_patente: 'ABCD12', p_lat: -33.4, p_lng: -70.6, p_precision: 12, p_at: '2026-11-19T10:00:00.000Z' });
});

test('argsCierre: mapea datos de la fila a los parámetros de ent_cerrar_entrega', () => {
  const d = {
    guia: 'g', resultado: 'entregada', fotos: ['g/foto_1_1.jpg'], firma: 'g/firma_1.png', receptor_nombre: 'Ana',
    receptor_rut: null, receptor_cargo: 'Bodega', receptor_telefono: null, observacion: null, lat: null, lng: null,
    devoluciones: [], at: '2026-11-19T10:05:00.000Z',
  };
  assert.deepEqual(E.argsCierre(d), {
    p_guia: 'g', p_resultado: 'entregada', p_fotos: ['g/foto_1_1.jpg'], p_receptor_nombre: 'Ana', p_receptor_rut: null,
    p_receptor_cargo: 'Bodega', p_receptor_telefono: null, p_firma_path: 'g/firma_1.png', p_observacion: null,
    p_lat: null, p_lng: null, p_devoluciones: [], p_at: '2026-11-19T10:05:00.000Z',
  });
});
