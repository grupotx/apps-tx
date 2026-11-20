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

// ---------- fix ronda 1: patente, jornada y acciones de ruta ----------
test('patenteParaLlegada: jornada, luego ruta, si no null', () => {
  assert.equal(E.patenteParaLlegada({ patente: 'ABCD12' }, { patente: 'ZZZZ99' }), 'ABCD12');
  assert.equal(E.patenteParaLlegada(null, { patente: 'ZZZZ99' }), 'ZZZZ99');
  assert.equal(E.patenteParaLlegada({ patente: '  ' }, null), null);
  assert.equal(E.patenteParaLlegada(null, null), null);
  assert.equal(E.patenteParaLlegada({ patente: null }, { patente: '' }), null);
});

test('filaJornada: usa el id generado en el teléfono y la hora real', () => {
  assert.deepEqual(E.filaJornada({ id: 'j1', chofer_id: 'u1', patente: 'ABCD12', fecha: '2026-11-19', inicio_at: '2026-11-19T10:00:00.000Z', cerrar: 'j0', fin_at: 'x' }),
    { id: 'j1', chofer_id: 'u1', patente: 'ABCD12', fecha: '2026-11-19', inicio_at: '2026-11-19T10:00:00.000Z' });
});

test('argsRuta: parámetros de ent_chofer_ruta', () => {
  assert.deepEqual(E.argsRuta({ ruta: 'r1', accion: 'salir', at: 'x' }), { p_ruta: 'r1', p_accion: 'salir' });
});

test('rutaYaHecha: errores de "ya aplicado" cuentan como enviado; otros no', () => {
  assert.equal(E.rutaYaHecha('aceptar', { message: 'La ruta ya fue aceptada' }), true);
  assert.equal(E.rutaYaHecha('aceptar', { message: 'La ruta ya salió' }), true);
  assert.equal(E.rutaYaHecha('salir', { message: 'La ruta ya salió' }), true);
  assert.equal(E.rutaYaHecha('salir', { message: 'La ruta ya fue aceptada' }), false);
  assert.equal(E.rutaYaHecha('aceptar', { message: 'Ruta no asignada a este chofer' }), false);
  assert.equal(E.rutaYaHecha('aceptar', new TypeError('Failed to fetch')), false);
  assert.equal(E.rutaYaHecha('otra', { message: 'La ruta ya salió' }), false);
});

const entR = (id, ruta, accion, estado, seg, error = null) => ({
  id, tipo: 'ent.ruta', estado, error, datos: { ruta, accion },
  creada: new Date(Date.UTC(2026, 10, 19, 10, 0, seg)).toISOString(),
});

test('aplicarFilaRutas: aceptar pendiente → aceptada; salir pendiente → en_ruta', () => {
  const rs = [{ id: 'r1', estado: 'asignada' }, { id: 'r2', estado: 'aceptada' }, { id: 'r3', estado: 'asignada' }];
  const r = E.aplicarFilaRutas(rs, [entR('A', 'r1', 'aceptar', 'pendiente', 1), entR('B', 'r2', 'salir', 'pendiente', 2)]);
  assert.equal(r[0].estado, 'aceptada');
  assert.deepEqual(r[0].fila, { estado: 'pendiente', error: null, ids: ['A'] });
  assert.equal(r[1].estado, 'en_ruta');
  assert.equal(r[2], rs[2]);
  assert.equal(rs[0].estado, 'asignada');
});

test('aplicarFilaRutas: aceptar y salir pendientes en orden → en_ruta', () => {
  const r = E.aplicarFilaRutas([{ id: 'r1', estado: 'asignada' }], [entR('B', 'r1', 'salir', 'pendiente', 2), entR('A', 'r1', 'aceptar', 'pendiente', 1)]);
  assert.equal(r[0].estado, 'en_ruta');
  assert.deepEqual(r[0].fila.ids, ['A', 'B']);
});

test('aplicarFilaRutas: no retrocede una ruta ya en_ruta; con problema deja estado y expone motivo', () => {
  assert.equal(E.aplicarFilaRutas([{ id: 'r1', estado: 'en_ruta' }], [entR('A', 'r1', 'aceptar', 'pendiente', 1)])[0].estado, 'en_ruta');
  const r = E.aplicarFilaRutas([{ id: 'r1', estado: 'asignada' }], [entR('A', 'r1', 'aceptar', 'problema', 1, 'Ruta no asignada a este chofer')]);
  assert.equal(r[0].estado, 'asignada');
  assert.deepEqual(r[0].fila, { estado: 'problema', error: 'Ruta no asignada a este chofer', ids: ['A'] });
});

// ---------- fix ronda 2 ----------
test('aplicarFilaRutas: tras una acción con problema no se aplican las pendientes siguientes de esa ruta', () => {
  const r = E.aplicarFilaRutas([{ id: 'r1', estado: 'asignada' }, { id: 'r2', estado: 'asignada' }], [
    entR('A', 'r1', 'aceptar', 'problema', 1, 'Ruta no asignada a este chofer'),
    entR('B', 'r1', 'salir', 'pendiente', 2),
    entR('C', 'r2', 'aceptar', 'pendiente', 3),
    entR('D', 'r2', 'salir', 'problema', 4, 'x'),
  ]);
  assert.equal(r[0].estado, 'asignada');            // salir pendiente ignorado: no desbloquea guías
  assert.equal(r[0].fila.estado, 'problema');
  assert.deepEqual(r[0].fila.ids, ['A']);
  assert.equal(r[1].estado, 'aceptada');            // la pendiente anterior al problema sí se aplica
  assert.equal(r[1].fila.estado, 'problema');
});

test('jornadasConProblema: solo jornadas con problema, con patente y motivo, en orden', () => {
  const ej = (id, estado, seg, patente, error = null) => ({ id, tipo: 'ent.jornada', estado, error, datos: { patente },
    creada: new Date(Date.UTC(2026, 10, 19, 10, 0, seg)).toISOString() });
  const lista = [
    ej('J2', 'problema', 2, 'RUTA77'),
    ej('J1', 'problema', 1, 'ABCD12', 'new row violates row-level security policy'),
    ej('J3', 'pendiente', 3, 'ZZZZ99'),
    entR('A', 'r1', 'aceptar', 'problema', 4, 'x'),
  ];
  assert.deepEqual(E.jornadasConProblema(lista), [
    { id: 'J1', patente: 'ABCD12', error: 'new row violates row-level security policy' },
    { id: 'J2', patente: 'RUTA77', error: 'No se pudo enviar' },
  ]);
  assert.deepEqual(E.jornadasConProblema([]), []);
});
