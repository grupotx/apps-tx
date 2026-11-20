const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nuevaEntrada, clasificarError, procesarFila, resumen } = require('../offline-core.js');

// Fila en memoria para las pruebas
function fila(entradas) {
  const enviadas = [];
  return {
    enviadas,
    entradas,
    deps: {
      listar: async () => entradas.slice(),
      guardar: async (e) => { const i = entradas.findIndex(x => x.id === e.id); entradas[i] = { ...e }; },
      enviar: null,
    },
  };
}
const mk = (id, seg, extra = {}) => nuevaEntrada({ id, tipo: 't', datos: {}, ahora: new Date(Date.UTC(2026, 0, 1, 0, 0, seg)), ...extra });

test('nuevaEntrada: pendiente, 0 intentos, creada ISO', () => {
  const ahora = new Date('2026-03-04T05:06:07.000Z');
  const e = nuevaEntrada({ id: 'a', tipo: 'entrega', datos: { x: 1 }, ahora });
  assert.equal(e.estado, 'pendiente');
  assert.equal(e.intentos, 0);
  assert.equal(e.error, null);
  assert.equal(e.creada, '2026-03-04T05:06:07.000Z');
  assert.deepEqual(e.archivos, []);
  assert.equal(e.dependeDe, null);
});

test('clasificarError: red, sesión y regla', () => {
  assert.equal(clasificarError(new TypeError('Failed to fetch')), 'red');
  assert.equal(clasificarError({ status: 503 }), 'red');
  assert.equal(clasificarError({ status: 401 }), 'sesion');
  assert.equal(clasificarError({ code: 'PGRST301' }), 'sesion');
  assert.equal(clasificarError({ message: 'JWT expired' }), 'sesion');
  assert.equal(clasificarError({ message: 'Guía no asignada a este chofer' }), 'regla');
});

test('procesarFila: envía en orden de creación', async () => {
  const f = fila([mk('B', 2), mk('A', 1)]);
  const orden = [];
  f.deps.enviar = async (e) => { orden.push(e.id); };
  const r = await procesarFila(f.deps);
  assert.deepEqual(orden, ['A', 'B']);
  assert.deepEqual(r, { enviados: 2, problemas: 0, detenido: null });
  assert.ok(f.entradas.every(e => e.estado === 'enviado'));
});

test('procesarFila: error de regla marca problema y sigue con las independientes', async () => {
  const f = fila([mk('A', 1), mk('B', 2)]);
  f.deps.enviar = async (e) => { if (e.id === 'A') throw new Error('Guía no asignada a este chofer'); };
  const r = await procesarFila(f.deps);
  const A = f.entradas.find(e => e.id === 'A');
  assert.equal(A.estado, 'problema');
  assert.equal(A.intentos, 1);
  assert.equal(A.error, 'Guía no asignada a este chofer');
  assert.equal(f.entradas.find(e => e.id === 'B').estado, 'enviado');
  assert.deepEqual(r, { enviados: 1, problemas: 1, detenido: null });
});

test('procesarFila: dependiente de un problema pasa a problema sin enviarse', async () => {
  const f = fila([mk('A', 1), mk('B', 2, { dependeDe: 'A' })]);
  const vistos = [];
  f.deps.enviar = async (e) => { vistos.push(e.id); throw new Error('regla rota'); };
  const r = await procesarFila(f.deps);
  assert.deepEqual(vistos, ['A']);
  const B = f.entradas.find(e => e.id === 'B');
  assert.equal(B.estado, 'problema');
  assert.equal(B.error, 'Depende de un registro con problema');
  assert.equal(r.problemas, 2);
});

test('procesarFila: error de red detiene sin tocar la entrada', async () => {
  const f = fila([mk('A', 1), mk('B', 2)]);
  const vistos = [];
  f.deps.enviar = async (e) => { vistos.push(e.id); throw new TypeError('Failed to fetch'); };
  const r = await procesarFila(f.deps);
  assert.deepEqual(vistos, ['A']);
  const A = f.entradas.find(e => e.id === 'A');
  assert.equal(A.estado, 'pendiente');
  assert.equal(A.intentos, 0);
  assert.deepEqual(r, { enviados: 0, problemas: 0, detenido: 'red' });
});

test('procesarFila: error de sesión detiene', async () => {
  const f = fila([mk('A', 1), mk('B', 2)]);
  f.deps.enviar = async () => { throw { status: 401 }; };
  const r = await procesarFila(f.deps);
  assert.equal(r.detenido, 'sesion');
  assert.equal(f.entradas[0].estado, 'pendiente');
});

test('resumen: cuenta pendientes y problemas, ignora enviadas', () => {
  const r = resumen([{ estado: 'pendiente' }, { estado: 'pendiente' }, { estado: 'problema' }, { estado: 'enviado' }]);
  assert.deepEqual(r, { pendientes: 2, problemas: 1 });
});
