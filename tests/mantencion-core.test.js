const { test } = require('node:test');
const assert = require('node:assert/strict');
const MC = require('../mantencion-core.js');

test('claveDoc: junta colección e id con el separador \\u0001', () => {
  assert.equal(MC.claveDoc('repuestos', 'r1'), 'repuestos\u0001r1');
  assert.equal(MC.SEP, '\u0001');
});

test('entradaDoc: arma la entrada con tipo fijo, los datos de la fila, y dependeDe como hermano de tipo/datos', () => {
  const e = MC.entradaDoc({ id: 'e1', coleccion: 'chk', docId: 'c1', data: { nombre: 'Bomba' }, base: '2026-11-20T10:00:00Z', baseFresca: true, hechoEn: '2026-11-25T08:00:00Z', dependeDe: 'e0' });
  assert.deepEqual(e, {
    tipo: 'mantencion.doc',
    datos: { id: 'e1', coleccion: 'chk', docId: 'c1', data: { nombre: 'Bomba' }, base: '2026-11-20T10:00:00Z', baseFresca: true, hechoEn: '2026-11-25T08:00:00Z' },
    dependeDe: 'e0',
  });
  assert.equal(e.datos.dependeDe, undefined, 'dependeDe nunca va anidado dentro de datos: offline-core.js/cadenaCompleta leen e.dependeDe, no e.datos.dependeDe');
});

test('entradaDoc: sin base ni dependeDe quedan en null, baseFresca en false, data en {}', () => {
  const e = MC.entradaDoc({ id: 'e1', coleccion: 'chk', data: null, hechoEn: 't' });
  assert.equal(e.datos.base, null);
  assert.equal(e.datos.baseFresca, false);
  assert.equal(e.dependeDe, null);
  assert.deepEqual(e.datos.data, {});
  assert.equal(e.datos.docId, null);
});

test('entradaDoc: el dependeDe que devuelve es compatible con cadenaCompleta/descendientes/causaCadena (copiadas de terreno-core.js)', () => {
  const madre = { id: 'm1', estado: 'problema', error: 'CONFLICTO: chk cambió en el servidor', dependeDe: null };
  const hija = MC.entradaDoc({ id: 'h1', coleccion: 'ots', docId: 'o1', data: {}, dependeDe: 'm1' });
  const entradaHija = { id: 'h1', estado: 'problema', error: 'Depende de un registro con problema', ...hija };
  assert.equal(MC.causaCadena([madre, entradaHija], entradaHija), madre.error);
  assert.deepEqual(new Set(MC.cadenaCompleta([madre, entradaHija], 'm1')), new Set(['m1', 'h1']));
  assert.deepEqual(MC.descendientes([madre, entradaHija], 'm1'), ['h1']);
});

// ── docsCambiados: equivalente puro de docsDeDb() + la comparación contra `snap` en subirCambios() ──

test('docsCambiados: un campo nuevo queda en cambiados', () => {
  const act = new Map([['chk\u0001c1', { nombre: 'Bomba', estado: 'ok' }]]);
  const snap = new Map([['chk\u0001c1', JSON.stringify({ nombre: 'Bomba' })]]);
  const r = MC.docsCambiados(act, snap);
  assert.deepEqual(r.cambiados, [['chk\u0001c1', { nombre: 'Bomba', estado: 'ok' }]]);
  assert.deepEqual(r.borrados, []);
});

test('docsCambiados: un documento que ya no está en el mapa actual queda en borrados', () => {
  const act = new Map();
  const snap = new Map([['chk\u0001c1', JSON.stringify({ nombre: 'Bomba' })]]);
  const r = MC.docsCambiados(act, snap);
  assert.deepEqual(r.cambiados, []);
  assert.deepEqual(r.borrados, ['chk\u0001c1']);
});

test('docsCambiados: nada cambió deja las dos listas vacías', () => {
  const doc = { nombre: 'Bomba', estado: 'ok' };
  const act = new Map([['chk\u0001c1', doc]]);
  const snap = new Map([['chk\u0001c1', JSON.stringify(doc)]]);
  const r = MC.docsCambiados(act, snap);
  assert.deepEqual(r, { cambiados: [], borrados: [] });
});

test('docsCambiados: un documento nuevo (no estaba en snap) también queda en cambiados', () => {
  const act = new Map([['chk\u0001c2', { nombre: 'Nuevo' }]]);
  const snap = new Map();
  const r = MC.docsCambiados(act, snap);
  assert.deepEqual(r.cambiados, [['chk\u0001c2', { nombre: 'Nuevo' }]]);
  assert.deepEqual(r.borrados, []);
});

test('docsCambiados: acepta objetos planos además de Map', () => {
  const act = { 'chk\u0001c1': { nombre: 'Bomba' } };
  const snap = { 'chk\u0001c1': JSON.stringify({ nombre: 'Vieja' }), 'chk\u0001c9': JSON.stringify({ x: 1 }) };
  const r = MC.docsCambiados(act, snap);
  assert.deepEqual(r.cambiados, [['chk\u0001c1', { nombre: 'Bomba' }]]);
  assert.deepEqual(r.borrados, ['chk\u0001c9']);
});

// ── aplicarFilaDocs ──

test('aplicarFilaDocs: reemplaza un documento existente por su versión pendiente sin duplicar', () => {
  const servidor = [{ coleccion: 'chk', id: 'c1', data: { nombre: 'Bomba', estado: 'ok' } }];
  const entradas = [{ id: 'e1', estado: 'pendiente', error: null, tipo: 'mantencion.doc', datos: { id: 'e1', coleccion: 'chk', docId: 'c1', data: { estado: 'malo' } } }];
  const out = MC.aplicarFilaDocs(servidor, entradas);
  assert.equal(out.length, 1);
  assert.equal(out[0].coleccion, 'chk');
  assert.equal(out[0].id, 'c1');
  assert.deepEqual(out[0].data, { nombre: 'Bomba', estado: 'malo' });
  assert.deepEqual(out[0]._fila, { entradaId: 'e1', estado: 'pendiente', error: null });
});

test('aplicarFilaDocs: dos colecciones distintas con el mismo id no se pisan (la identidad es coleccion+id)', () => {
  const servidor = [{ coleccion: 'chk', id: 'x1', data: { a: 1 } }, { coleccion: 'ots', id: 'x1', data: { b: 2 } }];
  const entradas = [{ id: 'e1', estado: 'pendiente', error: null, tipo: 'mantencion.doc', datos: { id: 'e1', coleccion: 'chk', docId: 'x1', data: { a: 9 } } }];
  const out = MC.aplicarFilaDocs(servidor, entradas);
  assert.equal(out.length, 2);
  const chk = out.find((r) => r.coleccion === 'chk'), ots = out.find((r) => r.coleccion === 'ots');
  assert.deepEqual(chk.data, { a: 9 });
  assert.deepEqual(ots.data, { b: 2 });
  assert.equal(ots._fila, undefined, 'el documento sin entradas pendientes no lleva marca');
});

test('aplicarFilaDocs: un documento nuevo (sin fila en el servidor) se agrega al principio', () => {
  const entradas = [{ id: 'e1', estado: 'pendiente', error: null, tipo: 'mantencion.doc', datos: { id: 'e1', coleccion: 'chk', docId: 'c9', data: { nombre: 'Nuevo' } } }];
  const out = MC.aplicarFilaDocs([{ coleccion: 'chk', id: 'c1', data: {} }], entradas);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'c9');
  assert.equal(out[1].id, 'c1');
});

test('aplicarFilaDocs: con dos entradas del mismo documento, un problema no queda tapado por una pendiente', () => {
  const mk = (id, estado, error) => ({ id, estado, error, tipo: 'mantencion.doc', datos: { id, coleccion: 'chk', docId: 'c1', data: { v: id } } });
  const out = MC.aplicarFilaDocs([{ coleccion: 'chk', id: 'c1', data: { v: 'servidor' } }], [mk('e1', 'problema', 'CONFLICTO: x'), mk('e2', 'pendiente', null)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.v, 'e2', 'lo último sigue viéndose');
  assert.deepEqual(out[0]._fila, { entradaId: 'e1', estado: 'problema', error: 'CONFLICTO: x' });
});

test('aplicarFilaDocs: con dos problemas encadenados del mismo documento, se queda con la causa raíz (la primera), no con la hija más reciente (mismo criterio que filaDeDoc en mantencion.html)', () => {
  const madre = { id: 'e1', estado: 'problema', error: 'CONFLICTO: x', dependeDe: null, tipo: 'mantencion.doc', datos: { id: 'e1', coleccion: 'ots', docId: 'o1', data: { v: 'e1' } } };
  const hija = { id: 'e2', estado: 'problema', error: 'Depende de un registro con problema', dependeDe: 'e1', tipo: 'mantencion.doc', datos: { id: 'e2', coleccion: 'ots', docId: 'o1', data: { v: 'e2' } } };
  const out = MC.aplicarFilaDocs([{ coleccion: 'ots', id: 'o1', data: { v: 'servidor' } }], [madre, hija]);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.v, 'e2', 'el contenido mostrado sigue siendo el de la corrección más reciente');
  assert.deepEqual(out[0]._fila, { entradaId: 'e1', estado: 'problema', error: 'CONFLICTO: x' }, 'la marca usa la entrada causante (la raíz), no la hija que solo heredó el problema');
});

test('aplicarFilaDocs: ignora entradas de otro tipo o sin datos', () => {
  const out = MC.aplicarFilaDocs([{ coleccion: 'chk', id: 'c1', data: {} }], [{ id: 'e1', tipo: 'otra.cosa', datos: {} }, { id: 'e2', tipo: 'mantencion.doc' }, null]);
  assert.equal(out.length, 1);
  assert.equal(out[0]._fila, undefined);
});

// ── esConflicto / noExiste / MSG_CONFLICTO ──

test('esConflicto y noExiste: se distinguen por el prefijo del mensaje de mtto_guardar_doc', () => {
  assert.equal(MC.esConflicto({ message: 'CONFLICTO: chk cambió en el servidor' }), true);
  assert.equal(MC.esConflicto({ message: 'NO_EXISTE: chk ya no existe' }), false);
  assert.equal(MC.noExiste({ message: 'NO_EXISTE: chk ya no existe' }), true);
  assert.equal(MC.noExiste('CONFLICTO: x'), false);
  assert.equal(MC.esConflicto('CONFLICTO: x'), true, 'también acepta el mensaje como texto plano');
  assert.equal(MC.esConflicto(null), false);
  assert.equal(MC.noExiste(undefined), false);
});

test('MSG_CONFLICTO: texto propio de Mantención, distinto del de Terreno/Silos', () => {
  assert.equal(MC.MSG_CONFLICTO, 'Otro técnico cambió esto mientras no tenías señal. Revisa tu versión antes de volver a guardarla.');
});

// ── cadenaCompleta / descendientes / causaCadena (copiadas de terreno-core.js, genéricas) ──

test('cadenaCompleta: une ancestros y descendientes transitivos, en cualquier sentido', () => {
  const entradas = [{ id: 'a' }, { id: 'b', dependeDe: 'a' }, { id: 'c', dependeDe: 'b' }, { id: 'x' }];
  for (const id of ['a', 'b', 'c']) assert.deepEqual(new Set(MC.cadenaCompleta(entradas, id)), new Set(['a', 'b', 'c']));
  assert.deepEqual(MC.cadenaCompleta(entradas, 'x'), ['x']);
});

test('descendientes: solo lo que depende de la entrada, nunca de quién depende ella', () => {
  const entradas = [{ id: 'a' }, { id: 'b', dependeDe: 'a' }, { id: 'c', dependeDe: 'b' }, { id: 'x' }];
  assert.deepEqual(new Set(MC.descendientes(entradas, 'a')), new Set(['b', 'c']));
  assert.deepEqual(new Set(MC.descendientes(entradas, 'b')), new Set(['c']));
  assert.deepEqual(MC.descendientes(entradas, 'c'), []);
  assert.deepEqual(MC.descendientes(entradas, 'x'), []);
});

test('causaCadena: sube hasta la entrada con el error propio', () => {
  const madre = { id: 'c1', estado: 'problema', error: 'CONFLICTO: chk cambió en el servidor', dependeDe: null };
  const hija = { id: 'r1', estado: 'problema', error: 'Depende de un registro con problema', dependeDe: 'c1' };
  assert.equal(MC.causaCadena([madre, hija], hija), madre.error);
});

test('causaCadena: sin el mensaje genérico, devuelve el error propio tal cual', () => {
  const e = { id: 'e1', estado: 'problema', error: 'NO_EXISTE: chk ya no existe', dependeDe: 'otro' };
  assert.equal(MC.causaCadena([e], e), e.error);
});

test('causaCadena: la entrada madre no está en la lista: se queda con el genérico', () => {
  const huerfana = { id: 'e2', estado: 'problema', error: 'Depende de un registro con problema', dependeDe: 'no-existe' };
  assert.equal(MC.causaCadena([huerfana], huerfana), 'Depende de un registro con problema');
});
