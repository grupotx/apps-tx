const { test } = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../silos-core.js');

test('rutaFoto: la ruta solo depende de la entrada y el indice', () => {
  assert.equal(SC.rutaFoto('e1', 0), 'e1/1.jpg');
});

test('aplicarFilaSilos: una correccion reemplaza a la solicitud en su sitio, sin duplicar', () => {
  const solicitudes = [{ id: 's1', codigo: 'SOL-0001', estado: 'Solicitada' }];
  const ent = { id: 'e1', estado: 'pendiente', error: null, tipo: 'silos.solicitud',
    datos: { id: 'e1', registroId: 's1', fila: { estado: 'Aprobada' }, datos: {}, fotosGuardadas: [] } };
  const out = SC.aplicarFilaSilos(solicitudes, [ent]);
  assert.equal(out.length, 1);
  assert.equal(out[0].estado, 'Aprobada');
  assert.equal(out[0]._fila.estado, 'pendiente');
});

test('esConflicto y noExiste distinguen los rechazos del servidor', () => {
  assert.equal(SC.esConflicto({ message: 'CONFLICTO: la solicitud cambió en el servidor' }), true);
  assert.equal(SC.noExiste({ message: 'NO_EXISTE: la solicitud ya no está' }), true);
});

test('esSinPermiso distingue el rechazo de permiso (Tarea 6, Important de la revisión)', () => {
  assert.equal(SC.esSinPermiso({ message: 'SIN_PERMISO: no tienes permiso para editar esta solicitud' }), true);
  assert.equal(SC.esSinPermiso({ message: 'CONFLICTO: la solicitud cambió en el servidor' }), false);
});

test('entradaSolicitud guarda la hora real y la version base', () => {
  const e = SC.entradaSolicitud({ id: 'e1', fila: { codigo: 'SOL-0001' }, datos: {}, fotos: 1,
    base: '2026-11-24T10:00:00Z', baseFresca: false, registroId: null, clienteNuevo: null, hechoEn: '2026-11-24T12:00:00Z' });
  assert.equal(e.tipo, 'silos.solicitud');
  assert.equal(e.datos.base, '2026-11-24T10:00:00Z');
  assert.equal(e.datos.hechoEn, '2026-11-24T12:00:00Z');
});

// Tarea 6 (Critical de la revisión): `manual` distingue una corrección de EDICIÓN MANUAL (formSolicitud)
// de una corrección de cambio de estado (Instalar/Evaluar/Retirar) — solo la primera puede reabrir con
// seguridad el formulario completo vía "Ver mi versión" (bandaFilaSol en silos-tx/index.html).
test('entradaSolicitud: manual por defecto es false; se puede marcar true', () => {
  const base = { id: 'e1', fila: {}, datos: {}, fotos: 0, base: null, baseFresca: false, registroId: 's1', clienteNuevo: null, hechoEn: 'h' };
  assert.equal(SC.entradaSolicitud(base).datos.manual, false);
  assert.equal(SC.entradaSolicitud({ ...base, manual: true }).datos.manual, true);
});

test('aplicarFilaSilos: propaga `manual` a _fila para que la UI sepa si puede reabrir el formulario completo', () => {
  const solicitudes = [{ id: 's1', codigo: 'SOL-0001', estado: 'Solicitada' }];
  const entManual = { id: 'e1', estado: 'problema', error: 'CONFLICTO: x', tipo: 'silos.solicitud',
    datos: { id: 'e1', registroId: 's1', fila: {}, datos: {}, fotosGuardadas: [], manual: true } };
  const outManual = SC.aplicarFilaSilos(solicitudes, [entManual]);
  assert.equal(outManual[0]._fila.manual, true);

  const entInstalar = { id: 'e2', estado: 'problema', error: 'CONFLICTO: x', tipo: 'silos.solicitud',
    datos: { id: 'e2', registroId: 's1', fila: { estado: 'Instalada' }, datos: {}, fotosGuardadas: [], manual: false } };
  const outInstalar = SC.aplicarFilaSilos(solicitudes, [entInstalar]);
  assert.equal(outInstalar[0]._fila.manual, false);

  // Sin el campo `manual` en absoluto (entradas viejas, o cualquier corrección que no sea de formSolicitud):
  // tampoco debe tratarse como editable con el formulario completo.
  const entSinManual = { id: 'e3', estado: 'problema', error: 'CONFLICTO: x', tipo: 'silos.solicitud',
    datos: { id: 'e3', registroId: 's1', fila: {}, datos: {}, fotosGuardadas: [] } };
  const outSinManual = SC.aplicarFilaSilos(solicitudes, [entSinManual]);
  assert.equal(outSinManual[0]._fila.manual, false);
});

test('entradaEvento nunca lleva base ni registroId: los eventos solo se crean, no se corrigen', () => {
  const e = SC.entradaEvento({ id: 'e1', tipo: 'Instalación', fila: { silo_id: 's1' }, datos: {}, fotos: 2, hechoEn: '2026-11-24T12:00:00Z' });
  assert.equal(e.tipo, 'silos.evento');
  assert.equal(e.datos.base, undefined);
});

// Tarea 6: idempotencia de sil_guardar_solicitud (mismo criterio que TC.igualProfundo/mismoContenido de
// Registro de Terreno, aplicado del lado del cliente): un reintento de la MISMA corrección cuya respuesta
// se perdió no debe tratarse como un conflicto real contra uno mismo.
test('igualProfundo: objetos iguales con llaves en otro orden (como los deja jsonb)', () => {
  assert.equal(SC.igualProfundo({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
});
test('igualProfundo: arreglos iguales en el mismo orden; distinto orden no es igual', () => {
  assert.equal(SC.igualProfundo([1, 2], [1, 2]), true);
  assert.equal(SC.igualProfundo([1, 2], [2, 1]), false);
});
test('igualProfundo: anidado (objeto dentro de arreglo dentro de objeto)', () => {
  assert.equal(SC.igualProfundo({ x: [{ a: 1 }] }, { x: [{ a: 1 }] }), true);
  assert.equal(SC.igualProfundo({ x: [{ a: 1 }] }, { x: [{ a: 2 }] }), false);
});
test('igualProfundo: distinta cantidad de llaves o de largo no es igual', () => {
  assert.equal(SC.igualProfundo({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(SC.igualProfundo([1], [1, 2]), false);
});
test('igualProfundo: null/undefined', () => {
  assert.equal(SC.igualProfundo(null, null), true);
  assert.equal(SC.igualProfundo(null, {}), false);
  assert.equal(SC.igualProfundo(undefined, undefined), true);
});

test('mismoContenidoSolicitud: mismo contenido con las llaves de data en otro orden -> true (ya se aplicó, no es conflicto)', () => {
  const actual = { estado: 'Aprobada', silo_id: null, data: { obra: 'Obra', prefact: { resultado: 'Aprobada' }, estado: 'Aprobada' } };
  const cuerpo = { estado: 'Aprobada', silo_id: null, data: { estado: 'Aprobada', obra: 'Obra', prefact: { resultado: 'Aprobada' } } };
  assert.equal(SC.mismoContenidoSolicitud(actual, cuerpo), true);
});
test('mismoContenidoSolicitud: un campo de data distinto -> false (conflicto real, otra persona corrigió)', () => {
  const actual = { estado: 'Aprobada', silo_id: null, data: { obra: 'Obra A' } };
  const cuerpo = { estado: 'Aprobada', silo_id: null, data: { obra: 'Obra B' } };
  assert.equal(SC.mismoContenidoSolicitud(actual, cuerpo), false);
});
test('mismoContenidoSolicitud: estado o silo_id distinto -> false', () => {
  const actual = { estado: 'Aprobada', silo_id: 's1', data: {} };
  assert.equal(SC.mismoContenidoSolicitud(actual, { estado: 'Instalada', silo_id: 's1', data: {} }), false);
  assert.equal(SC.mismoContenidoSolicitud(actual, { estado: 'Aprobada', silo_id: 's2', data: {} }), false);
});
test('mismoContenidoSolicitud: sin actual o sin cuerpo -> false', () => {
  assert.equal(SC.mismoContenidoSolicitud(null, {}), false);
  assert.equal(SC.mismoContenidoSolicitud({}, null), false);
});
