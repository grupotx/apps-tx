const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claveValida, buscarFilaPorNumero, nombresPendientes, copiasABorrar, prefijoCarpeta } = require('../apps-script/lib.js');

test('claveValida: igual, distinta y vacía', () => {
  assert.equal(claveValida('abc123', 'abc123'), true);
  assert.equal(claveValida('abc124', 'abc123'), false);
  assert.equal(claveValida('abc', 'abc123'), false);
  assert.equal(claveValida('', ''), false);
  assert.equal(claveValida(undefined, 'x'), false);
});

test('buscarFilaPorNumero: índice de la fila o -1', () => {
  const v = [['Número', 'Fecha'], ['000001', 'a'], ['000002', 'b']];
  assert.equal(buscarFilaPorNumero(v, 2), 2);
  assert.equal(buscarFilaPorNumero(v, 1), 1);
  assert.equal(buscarFilaPorNumero(v, 3), -1);
  assert.equal(buscarFilaPorNumero([['Número'], [2]], 2), 1);
});

test('nombresPendientes: solo los que no existen en la carpeta', () => {
  assert.deepEqual(nombresPendientes(['foto_1.jpg'], [{ nombre: 'foto_1.jpg' }, { nombre: 'foto_2.jpg' }]), ['foto_2.jpg']);
  assert.deepEqual(nombresPendientes([], []), []);
});

test('copiasABorrar: deja las 30 más recientes', () => {
  const nombres = Array.from({ length: 32 }, (_, i) => `base-2026-10-${String(i + 1).padStart(2, '0')}.json.gz`);
  assert.deepEqual(copiasABorrar([...nombres].reverse(), 30), ['base-2026-10-01.json.gz', 'base-2026-10-02.json.gz']);
  assert.deepEqual(copiasABorrar(nombres.slice(0, 5), 30), []);
});

test('prefijoCarpeta: NNNNNN seguido de separador', () => {
  assert.equal(prefijoCarpeta(7), '000007 · ');
});
