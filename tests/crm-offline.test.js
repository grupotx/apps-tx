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

test('textoCopia modo cargando: no dice "Sin conexión"', () => {
  const g = new Date(2026, 10, 20, 9, 5);
  const t = C.textoCopia(g.toISOString(), new Date(2026, 10, 20, 18, 0), 'cargando');
  assert.equal(t, 'Datos de las 09:05 · cargando datos actualizados…');
  assert.equal(C.textoCopia(new Date(2026, 10, 18, 7, 0).toISOString(), new Date(2026, 10, 20), 'cargando'), 'Datos de las 07:00 del 18 nov · cargando datos actualizados…');
  assert.equal(C.textoCopia('x', new Date(), 'cargando'), 'Datos guardados · cargando datos actualizados…');
});

test('filaRedundante: solo sin pendientes ni problemas y con aviso sin red', () => {
  assert.equal(C.filaRedundante(true, { pendientes: 0, problemas: 0 }), true);
  assert.equal(C.filaRedundante(true, null), true);
  assert.equal(C.filaRedundante(true, { pendientes: 2, problemas: 0 }), false);
  assert.equal(C.filaRedundante(true, { pendientes: 0, problemas: 1 }), false);
  assert.equal(C.filaRedundante(false, { pendientes: 0, problemas: 0 }), false);
});

test('snapshotVigente: vieja si hubo escrituras desde el inicio de la carga', () => {
  assert.equal(C.snapshotVigente(3, 3), true);
  assert.equal(C.snapshotVigente(3, 4), false);
  assert.equal(C.snapshotVigente(0, 0), true);
});

// ── Visitas (Task 5) ──
const S1 = () => ({ clients: [], visits: [], quotes: [], tasks: [], opps: [] });
const visitaDatos = () => ({
  visita: { id: 'v1', clientId: 'c1' },
  prospecto: { id: 'c1', name: 'Obra X' },
  tarea: { id: 't1', clientId: 'c1', title: 'Seguimiento' },
  opp: { modo: 'nueva', obj: { id: 'o1', clientId: 'c1' } },
});

test('aplicarFilaCRM: visita con tarea y oportunidad nueva las agrega marcadas', () => {
  const S = S1();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', visitaDatos())]);
  assert.equal(S.tasks.length, 1);
  assert.equal(S.tasks[0]._fila.id, 'e1');
  assert.equal(S.opps.length, 1);
  assert.equal(S.opps[0]._fila.id, 'e1');
});

test('aplicarFilaCRM: oportunidad a actualizar no se agrega; S sin tasks/opps no rompe', () => {
  const S = S1();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', { visita: { id: 'v1' }, opp: { modo: 'actualizar', obj: { id: 'o9' } } })]);
  assert.equal(S.opps.length, 0);
  const S2 = S0();
  C.aplicarFilaCRM(S2, [ent('e1', 'crm.visita', visitaDatos())]);
  assert.equal(S2.visits.length, 1);
});

test('aplicarFilaCRM: visita enviada quita la marca de visita, prospecto, tarea y oportunidad (los objetos quedan)', () => {
  const S = S1();
  const e = ent('e1', 'crm.visita', visitaDatos());
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [{ ...e, estado: 'enviado' }]);
  for (const k of ['visits', 'clients', 'tasks', 'opps']) {
    assert.equal(S[k].length, 1, k);
    assert.equal(S[k][0]._fila, undefined, k);
  }
});

test('aplicarFilaCRM: la marca se queda mientras la entrada siga activa', () => {
  const S = S1();
  const e = ent('e1', 'crm.visita', visitaDatos());
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [{ ...e, estado: 'problema', error: 'x' }]);
  assert.equal(S.visits[0]._fila.estado, 'problema');
  assert.equal(S.clients[0]._fila.estado, 'problema');
});

test('aplicarFilaCRM: edición sin datos no rompe', () => {
  const S = S0();
  assert.doesNotThrow(() => C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion.editar', undefined)]));
});

test('superponerEntrada: agrega una entrada sin limpiar las marcas de otras', () => {
  const S = S1();
  S.visits.push({ id: 'v0', _fila: { estado: 'pendiente', error: null, id: 'e0' } });
  C.superponerEntrada(S, ent('e1', 'crm.visita', visitaDatos()));
  assert.equal(S.visits.length, 2);
  assert.equal(S.visits[0]._fila.id, 'e0');
  assert.equal(S.visits[1]._fila.id, 'e1');
  assert.equal(S.clients[0]._fila.id, 'e1');
});

test('reasignarCliente: cambia el cliente de visita, tarea y oportunidad sin mutar los datos', () => {
  const d = visitaDatos();
  const r = C.reasignarCliente(d, 'c9');
  assert.equal(r.visita.clientId, 'c9');
  assert.equal(r.tarea.clientId, 'c9');
  assert.equal(r.opp.obj.clientId, 'c9');
  assert.equal(d.visita.clientId, 'c1');
  assert.equal(d.tarea.clientId, 'c1');
  assert.equal(d.opp.obj.clientId, 'c1');
  // sin tarea / opp no rompe; mismo id devuelve lo mismo
  const r2 = C.reasignarCliente({ visita: { id: 'v', clientId: 'c1' }, prospecto: { id: 'c1' }, tarea: null, opp: null }, 'c2');
  assert.equal(r2.visita.clientId, 'c2');
  assert.equal(r2.tarea, null);
});

test('reasignarEnS: quita el prospecto del teléfono y mueve visita, tarea y oportunidad al cliente existente', () => {
  const S = S1();
  const d = visitaDatos();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', d)]);
  S.clients.push({ id: 'c9', name: 'Obra X' });
  S.visits.push({ id: 'otra', clientId: 'c1' });
  C.reasignarEnS(S, d, 'c9');
  assert.deepEqual(S.clients.map((c) => c.id), ['c9']);
  assert.equal(S.visits.find((v) => v.id === 'v1').clientId, 'c9');
  assert.equal(S.visits.find((v) => v.id === 'otra').clientId, 'c1');
  assert.equal(S.tasks[0].clientId, 'c9');
  assert.equal(S.opps[0].clientId, 'c9');
});

test('errorClienteExiste: traduce CLIENTE_EXISTE a un mensaje claro; otros errores no', () => {
  assert.equal(C.errorClienteExiste({ message: 'CLIENTE_EXISTE: 76.123.456-7 ya está registrado con otro vendedor' }),
    'Ese RUT ya pertenece a un cliente de otro vendedor. Habla con tu jefatura.');
  assert.equal(C.errorClienteExiste('CLIENTE_EXISTE: x'), 'Ese RUT ya pertenece a un cliente de otro vendedor. Habla con tu jefatura.');
  assert.equal(C.errorClienteExiste({ message: 'otro' }), null);
  assert.equal(C.errorClienteExiste(null), null);
});

test('textoProspectoExistia', () => {
  assert.equal(C.textoProspectoExistia('Obra X'), 'El prospecto «Obra X» ya existía; la visita quedó en ese cliente.');
});

test('quitarEntrada: saca de S lo agregado por esa entrada (descartada) y nada más', () => {
  const S = S1();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.visita', visitaDatos()), ent('e2', 'crm.visita', { visita: { id: 'v2' } }, 'pendiente', 1)]);
  S.visits.push({ id: 'vs' });
  C.quitarEntrada(S, 'e1');
  assert.deepEqual(S.visits.map((v) => v.id), ['v2', 'vs']);
  assert.equal(S.clients.length, 0);
  assert.equal(S.tasks.length, 0);
  assert.equal(S.opps.length, 0);
});

test('prospectoParaFila: cliente solo del teléfono se reenvía limpio; del servidor, null', () => {
  const c = { id: 'p1', name: 'Obra X', contacts: [{ name: 'A' }], _fila: { estado: 'pendiente', error: null, id: 'e1' } };
  const r = C.prospectoParaFila(c);
  assert.deepEqual(r, { id: 'p1', name: 'Obra X', contacts: [{ name: 'A' }] });
  assert.equal('_fila' in r, false);
  r.contacts[0].name = 'B';
  assert.equal(c.contacts[0].name, 'A');
  assert.equal(C.prospectoParaFila({ id: 'c1', name: 'Server' }), null);
  assert.equal(C.prospectoParaFila(null), null);
});

test('soltarEntrada: quita solo las marcas de esa entrada, sin revertir ediciones de cotización', () => {
  const S = S1();
  S.quotes.push({ id: 'q1', notes: 'nuevo', _fila: { estado: 'pendiente', error: null, id: 'e9' } });
  S.visits.push({ id: 'v0', _fila: { estado: 'pendiente', error: null, id: 'e0' } });
  C.superponerEntrada(S, ent('e1', 'crm.visita', visitaDatos()));
  C.soltarEntrada(S, 'e1');
  assert.equal(S.visits.find((v) => v.id === 'v1')._fila, undefined);
  assert.equal(S.clients[0]._fila, undefined);
  assert.equal(S.visits[0]._fila.id, 'e0');
  assert.equal(S.quotes[0]._fila.id, 'e9');
  assert.equal(S.quotes[0].notes, 'nuevo');
});

// ── Task 6: cotizaciones sin señal ──
const S6 = () => ({ clients: [], visits: [], quotes: [], tasks: [], opps: [] });
const cotDatos = () => ({
  cotizacion: { id: 'q1', num: 'COT-2026-0101', clientId: 'p1', status: 'enviada', history: [] },
  prospecto: { id: 'p1', name: 'Obra X' },
  tarea: { id: 't1', clientId: 'p1', title: 'COT-2026-0101 · Llamar', done: false },
  opp: { modo: 'nueva', obj: { id: 'o1', clientId: 'p1', stage: 'cotizacion' } },
});

test('superponerEntrada cotización: agrega cotización, prospecto, tarea y oportunidad nueva marcados', () => {
  const S = S6();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion', cotDatos())]);
  assert.deepEqual([S.quotes.length, S.clients.length, S.tasks.length, S.opps.length], [1, 1, 1, 1]);
  for (const k of ['quotes', 'clients', 'tasks', 'opps']) assert.equal(S[k][0]._fila.id, 'e1');
  const S2 = S6();
  const d = cotDatos(); d.opp = { modo: 'actualizar', obj: { id: 'o1', stage: 'cotizacion' } }; d.prospecto = null;
  C.aplicarFilaCRM(S2, [ent('e1', 'crm.cotizacion', d)]);
  assert.equal(S2.opps.length, 0);
  assert.equal(S2.clients.length, 0);
});

test('quitarEntrada: cotización creada por la entrada sale; la editada del servidor se queda', () => {
  const S = S6();
  S.quotes.push({ id: 'qs', notes: 'srv' });
  C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion', cotDatos()), ent('e2', 'crm.cotizacion.editar', { id: 'qs', cambios: { notes: 'tel' } }, 'pendiente', 1)]);
  C.quitarEntrada(S, 'e1');
  assert.deepEqual(S.quotes.map((q) => q.id), ['qs']);
  assert.deepEqual([S.clients.length, S.tasks.length, S.opps.length], [0, 0, 0]);
  C.quitarEntrada(S, 'e2');
  assert.deepEqual(S.quotes.map((q) => q.id), ['qs']);
});

test('reasignarCliente y reasignarEnS también mueven la cotización', () => {
  const d = cotDatos();
  const r = C.reasignarCliente(d, 'c9');
  assert.equal(r.cotizacion.clientId, 'c9');
  assert.equal(d.cotizacion.clientId, 'p1');
  const S = S6();
  C.aplicarFilaCRM(S, [ent('e1', 'crm.cotizacion', d)]);
  C.reasignarEnS(S, d, 'c9');
  assert.equal(S.quotes[0].clientId, 'c9');
  assert.equal(S.clients.length, 0);
});

test('textoProspectoExistia: dice qué quedó en el cliente', () => {
  assert.equal(C.textoProspectoExistia('Obra X', 'la cotización'), 'El prospecto «Obra X» ya existía; la cotización quedó en ese cliente.');
});

test('marcaAguaPdf: sujeta, borrador sin número, borrador guardado, rechazada, oficial', () => {
  assert.deepEqual(C.marcaAguaPdf({ status: 'pendiente', num: 'C-1' }), { texto: 'SUJETA A APROBACIÓN', sub: null });
  assert.deepEqual(C.marcaAguaPdf({ status: 'enviada', num: null }), { texto: 'BORRADOR', sub: null });
  assert.deepEqual(C.marcaAguaPdf({ status: 'pendiente', num: null }), { texto: 'BORRADOR', sub: 'SUJETA A APROBACIÓN' });
  assert.deepEqual(C.marcaAguaPdf({ status: 'borrador', num: 'C-1' }), { texto: 'BORRADOR', sub: null });
  assert.deepEqual(C.marcaAguaPdf({ status: 'rechazada', num: 'C-1' }), { texto: 'RECHAZADA', sub: null });
  assert.equal(C.marcaAguaPdf({ status: 'enviada', num: 'C-1' }), null);
  assert.equal(C.marcaAguaPdf({ status: 'ganada', num: 'C-1' }), null);
});

test('pdfEntregado: sentAt o historia Enviada / PDF descargado', () => {
  assert.equal(C.pdfEntregado({ history: [] }), false);
  assert.equal(C.pdfEntregado({ sentAt: '2026-11-20', history: [] }), true);
  assert.equal(C.pdfEntregado({ history: [{ text: 'Enviada por correo a a@b.cl' }] }), true);
  assert.equal(C.pdfEntregado({ history: [{ text: 'PDF descargado' }] }), true);
  assert.equal(C.pdfEntregado({ history: [{ text: 'Cotización creada' }] }), false);
  assert.equal(C.pdfEntregado({}), false);
});

test('alertaRechazo: solo rechazada con PDF entregado y sin duplicar', () => {
  const q = { id: 'q1', num: 'COT-2026-0101', status: 'rechazada', history: [{ text: 'PDF descargado' }] };
  assert.equal(C.alertaRechazo(q, [q]), 'Contacta al cliente: la cotización COT-2026-0101 fue rechazada');
  assert.equal(C.alertaRechazo({ ...q, history: [] }, [q]), null);
  assert.equal(C.alertaRechazo({ ...q, status: 'perdida' }, [q]), null);
  assert.equal(C.alertaRechazo(q, [q, { id: 'q2', num: 'COT-2026-0102', dupFrom: 'COT-2026-0101' }]), null);
});

// ── Task 6, ronda 1: entrega del PDF superpuesta y dependientes ──
test('superponerEntrada entrega: aplica línea, sentAt y borrador→enviada con marca aparte (_filaEntrega)', () => {
  const S = S6();
  S.quotes.push({ id: 'q1', num: 'C-1', status: 'borrador', history: [{ ts: 't0', user: 'u', text: 'Cotización creada' }] });
  const linea = { ts: 't1', user: 'u', text: 'PDF compartido' };
  const e = ent('e1', 'crm.cotizacion.entrega', { id: 'q1', linea, sentAt: '2026-11-20', aEnviada: true });
  C.aplicarFilaCRM(S, [e]);
  C.aplicarFilaCRM(S, [e]);
  const q = S.quotes[0];
  assert.equal(q.history.length, 2);
  assert.equal(q.history[1].text, 'PDF compartido');
  assert.equal(q.sentAt, '2026-11-20');
  assert.equal(q.status, 'enviada');
  assert.deepEqual(q._filaEntrega, { estado: 'pendiente', error: null, id: 'e1' });
  assert.equal('_fila' in q, false);
  // enviada o descartada: la marca se va; quitarEntrada no saca la cotización del servidor
  C.quitarEntrada(S, 'e1');
  assert.equal(S.quotes.length, 1);
  C.aplicarFilaCRM(S, []);
  assert.equal('_filaEntrega' in S.quotes[0], false);
});

test('superponerEntrada entrega: con problema la marca muestra el problema; sin cotización no hace nada', () => {
  const S = S6();
  S.quotes.push({ id: 'q1', num: 'C-1', status: 'enviada', history: [] });
  C.aplicarFilaCRM(S, [
    ent('e1', 'crm.cotizacion.entrega', { id: 'q1', linea: null }, 'problema', 0, 'falló'),
    ent('e2', 'crm.cotizacion.entrega', { id: 'q1', linea: { ts: 't', user: 'u', text: 'PDF descargado' } }, 'pendiente', 1),
    ent('e3', 'crm.cotizacion.entrega', { id: 'qx', linea: null }, 'pendiente', 2),
  ]);
  assert.equal(S.quotes[0]._filaEntrega.estado, 'problema');
  assert.equal(S.quotes[0]._filaEntrega.id, 'e1');
  assert.equal(S.quotes[0].status, 'enviada');
});

test('dependientes: ids de entradas que dependen (en cadena) de una entrada', () => {
  const es = [
    { id: 'a', dependeDe: null }, { id: 'b', dependeDe: 'a' }, { id: 'c', dependeDe: 'b' }, { id: 'd', dependeDe: 'x' },
  ];
  assert.deepEqual(C.dependientes(es, 'a'), ['b', 'c']);
  assert.deepEqual(C.dependientes(es, 'd'), []);
  assert.deepEqual(C.dependientes([], 'a'), []);
});

// ── Task 7: edición sin señal de cotizaciones propias ──
test('quitarEntrada: edición con problema (sin _base) nunca saca la cotización del servidor', () => {
  const S = S0(); S.quotes.push(qServ());
  C.aplicarFilaCRM(S, [edicion('problema', {}, 'CONFLICTO: x')]);
  C.quitarEntrada(S, 'e1', 'crm.cotizacion.editar');
  assert.deepEqual(S.quotes.map((q) => q.id), ['q1']);
});

test('cambiosEdicion: copia solo los campos editables (profunda)', () => {
  const q = { id: 'q1', num: 'C-1', status: 'enviada', items: [{ code: 'A', qty: 1 }], payment: 'Contado', conditions: 'c', notes: 'n', contact: 'Ana', nextAction: 'llamar', nextDate: '2026-11-25', listId: 'L-RM', entrega: { dir: 'x' }, validDays: 30, history: [], clientId: 'c1' };
  const c = C.cambiosEdicion(q);
  assert.deepEqual(Object.keys(c).sort(), ['conditions', 'contact', 'entrega', 'items', 'listId', 'nextAction', 'nextDate', 'notes', 'payment', 'validDays']);
  q.items[0].qty = 9;
  assert.equal(c.items[0].qty, 1);
});

test('cambiosRPC: claves en snake_case, solo las presentes', () => {
  assert.deepEqual(C.cambiosRPC({ items: [1], nextAction: 'a', nextDate: '2026-11-25', listId: 'L', validDays: 15, entrega: {}, notes: 'n', payment: 'p', conditions: 'c', contact: 'k' }),
    { items: [1], next_action: 'a', next_date: '2026-11-25', list_id: 'L', valid_days: 15, entrega: {}, notes: 'n', payment: 'p', conditions: 'c', contact: 'k' });
  assert.deepEqual(C.cambiosRPC({ notes: 'x' }), { notes: 'x' });
  assert.deepEqual(C.cambiosRPC(null), {});
});

test('baseEdicion: updated_at crudo tal cual (sin pasar por Date)', () => {
  assert.equal(C.baseEdicion({ updatedAt: '2026-11-20T10:11:12.345678' }), '2026-11-20T10:11:12.345678');
  assert.equal(C.baseEdicion({ updatedAt: '' }), null);
  assert.equal(C.baseEdicion({}), null);
  assert.equal(C.baseEdicion(null), null);
});

const qPropia = (extra = {}) => ({ id: 'q1', userId: 'u1', status: 'enviada', clientId: 'c1', date: '2026-11-20', updatedAt: '2026-11-20T10:00:00.123456', ...extra });
test('edicionPorFila: propia en borrador/enviada/negociación sí', () => {
  for (const status of ['borrador', 'enviada', 'negociacion']) {
    const a = qPropia({ status });
    assert.deepEqual(C.edicionPorFila(a, { ...a, notes: 'x' }, 'u1'), { ok: true, msg: null });
  }
});
test('edicionPorFila: pendiente/rechazada/ganada/perdida requieren señal', () => {
  for (const status of ['pendiente', 'rechazada', 'ganada', 'perdida']) {
    const a = qPropia({ status });
    const r = C.edicionPorFila(a, a, 'u1');
    assert.equal(r.ok, false);
    assert.match(r.msg, /con señal/);
  }
});
test('edicionPorFila: ajena, sin versión, solo en el teléfono, o cambio de cliente/vendedor/fecha requieren señal', () => {
  const a = qPropia();
  assert.match(C.edicionPorFila(a, a, 'u2').msg, /otro vendedor/);
  assert.equal(C.edicionPorFila(qPropia({ updatedAt: null }), qPropia({ updatedAt: null }), 'u1').ok, false);
  const f = qPropia({ _fila: { id: 'e', estado: 'pendiente' } });
  assert.equal(C.edicionPorFila(f, f, 'u1').ok, false);
  assert.match(C.edicionPorFila(a, { ...a, clientId: 'c2' }, 'u1').msg, /cliente, vendedor o fecha/);
  assert.match(C.edicionPorFila(a, { ...a, userId: 'u2' }, 'u1').msg, /cliente, vendedor o fecha/);
  assert.match(C.edicionPorFila(a, { ...a, date: '2026-11-21' }, 'u1').msg, /cliente, vendedor o fecha/);
});

// yaAplicada(row, d, yo): d = datos de la entrada (cambios camelCase, nota, requiereAprobacion)
const NOTA = 'Cotización editada · total $ 2.380';
const dEd = (extra = {}) => ({ cambios: { items: [{ code: 'A', qty: 2, price: 10 }], notes: '', nextDate: '2026-11-25', validDays: 30, entrega: { dir: 'x', obra: 'o' } }, nota: NOTA, requiereAprobacion: false, ...extra });
const rowEd = (extra = {}) => ({ id: 'q1', items: [{ price: 10, qty: 2, code: 'A' }], notes: null, next_date: '2026-11-25', valid_days: 30, entrega: { obra: 'o', dir: 'x' }, status: 'enviada',
  history: [{ ts: '2026-11-18T09:00', user: 'u1', text: 'Cotización creada' }, { ts: '2026-11-20T12:00', user: 'u1', text: NOTA }], ...extra });

test('yaAplicada: mi línea de historia (usuario + nota exacta) y los campos → sí (orden de claves jsonb y null/"" no importan)', () => {
  assert.equal(C.yaAplicada(rowEd(), dEd(), 'u1'), true);
  assert.equal(C.yaAplicada(null, dEd(), 'u1'), false);
});
test('yaAplicada: sin mi línea en la historia → no (aunque los campos coincidan)', () => {
  const r = rowEd({ history: [{ user: 'u1', text: 'Cotización creada' }] });
  assert.equal(C.yaAplicada(r, dEd(), 'u1'), false);
  assert.equal(C.yaAplicada(rowEd(), dEd(), 'u2'), false); // la línea es de otro usuario
  assert.equal(C.yaAplicada(rowEd(), dEd({ nota: NOTA + ' ' }), 'u1'), false);
});
test('yaAplicada: campos distintos → no', () => {
  assert.equal(C.yaAplicada(rowEd({ valid_days: 15 }), dEd(), 'u1'), false);
  assert.equal(C.yaAplicada(rowEd({ items: [{ code: 'A', qty: 3, price: 10 }] }), dEd(), 'u1'), false);
});
test('yaAplicada (a): sobre el límite, aplicada y luego aprobada por la jefatura (enviada) → sí, no se re-envía', () => {
  assert.equal(C.yaAplicada(rowEd({ status: 'enviada' }), dEd({ requiereAprobacion: true }), 'u1'), true);
  assert.equal(C.yaAplicada(rowEd({ status: 'rechazada' }), dEd({ requiereAprobacion: true }), 'u1'), true);
});
test('yaAplicada (b): edición sin el cambio aplicado mientras la jefatura la dejó rechazada/ganada → no', () => {
  const sinMiLinea = { history: [{ user: 'jefe', text: 'Rechazada por Jorge' }] };
  assert.equal(C.yaAplicada(rowEd({ status: 'rechazada', ...sinMiLinea }), dEd(), 'u1'), false);
  // sin requiereAprobacion el estado además debe seguir editable
  assert.equal(C.yaAplicada(rowEd({ status: 'ganada' }), dEd(), 'u1'), false);
  assert.equal(C.yaAplicada(rowEd({ status: 'negociacion' }), dEd(), 'u1'), true);
});

test('MSG_CONFLICTO en español', () => {
  assert.equal(C.MSG_CONFLICTO, 'Otra persona cambió esta cotización. Revisa tu versión.');
});

// ── Final fix pass: lo enviado entra a la copia local ('crm.datos') ──
const visDatos = () => ({
  visita: { id: 'v1', clientId: 'p1', photo: 'v1/foto.jpg' },
  prospecto: { id: 'p1', name: 'Obra X', _fila: { id: 'e0', estado: 'pendiente' } },
  tarea: { id: 't1', clientId: 'p1', title: 'Seguimiento', done: false },
  opp: { modo: 'actualizar', obj: { id: 'o1', nextAction: 'Llamar', nextDate: '2026-11-25' } },
});
test('enviadoParaCopia visita: visita, prospecto (sin marcas), tarea y campos de la oportunidad', () => {
  const p = C.enviadoParaCopia('crm.visita', visDatos(), {});
  assert.deepEqual(p.upsert.visits, [{ id: 'v1', clientId: 'p1', photo: 'v1/foto.jpg' }]);
  assert.deepEqual(p.upsert.clients, [{ id: 'p1', name: 'Obra X' }]);
  assert.deepEqual(p.upsert.tasks.map((t) => t.id), ['t1']);
  assert.deepEqual(p.merge.opps, [{ id: 'o1', nextAction: 'Llamar', nextDate: '2026-11-25' }]);
  assert.deepEqual(p.quitar.clients, []);
});
test('enviadoParaCopia visita: prospecto que ya existía → todo al id resuelto y el del teléfono fuera', () => {
  const p = C.enviadoParaCopia('crm.visita', visDatos(), { nuevoId: 'c9', sinFoto: true });
  assert.equal(p.upsert.clients, undefined);
  assert.deepEqual(p.quitar.clients, ['p1']);
  assert.equal(p.upsert.visits[0].clientId, 'c9');
  assert.equal(p.upsert.visits[0].photo, null);
  assert.equal(p.upsert.tasks[0].clientId, 'c9');
});
test('enviadoParaCopia cotización: oportunidad nueva completa, tarea con el número asignado', () => {
  const d = cotDatos(); d.cotizacion.num = null; d.tarea.title = '(sin número) · Llamar';
  const p = C.enviadoParaCopia('crm.cotizacion', d, { num: 'COT-2026-0909' });
  assert.deepEqual(p.upsert.opps, [{ id: 'o1', clientId: 'p1', stage: 'cotizacion' }]);
  assert.equal(p.upsert.tasks[0].title, 'COT-2026-0909 · Llamar');
  assert.deepEqual(p.upsert.clients, [{ id: 'p1', name: 'Obra X' }]);
  assert.equal(p.upsert.quotes, undefined);
  const d2 = cotDatos(); d2.prospecto = null; d2.opp = { modo: 'actualizar', obj: { id: 'o2', stage: 'cotizacion', amount: 5, quoteIds: ['q1'], nextAction: 'a', nextDate: 'b' } };
  assert.deepEqual(C.enviadoParaCopia('crm.cotizacion', d2, {}).merge.opps, [{ id: 'o2', stage: 'cotizacion', amount: 5, quoteIds: ['q1'], nextAction: 'a', nextDate: 'b' }]);
});
test('enviadoParaCopia: tipo sin nada que copiar → vacío', () => {
  const p = C.enviadoParaCopia('crm.cotizacion.entrega', { id: 'q1' }, {});
  assert.deepEqual(p, { upsert: {}, merge: {}, quitar: { clients: [] } });
});
test('aplicarACopia: agrega o reemplaza por id, mezcla campos, quita; sin copia no rompe', () => {
  const d = { clients: [{ id: 'p1', name: 'tel' }, { id: 'c1', name: 'srv' }], visits: [{ id: 'v0' }], tasks: [], opps: [{ id: 'o1', stage: 'visita', amount: 0 }] };
  const r = C.aplicarACopia(d, { upsert: { visits: [{ id: 'v1' }, { id: 'v0', x: 1 }], tasks: [{ id: 't1' }] }, merge: { opps: [{ id: 'o1', stage: 'cotizacion' }, { id: 'zz', stage: 'x' }] }, quitar: { clients: ['p1'] } });
  assert.equal(r, d);
  assert.deepEqual(d.visits, [{ id: 'v0', x: 1 }, { id: 'v1' }]);
  assert.deepEqual(d.tasks, [{ id: 't1' }]);
  assert.deepEqual(d.opps, [{ id: 'o1', stage: 'cotizacion', amount: 0 }]);
  assert.deepEqual(d.clients.map((c) => c.id), ['c1']);
  assert.equal(C.aplicarACopia(null, { upsert: {}, merge: {}, quitar: { clients: [] } }), null);
});
test('yaAplicada: entrega null en la edición y {} en el servidor cuentan igual', () => {
  assert.equal(C.yaAplicada(rowEd({ entrega: {} }), dEd({ cambios: { ...dEd().cambios, entrega: null } }), 'u1'), true);
  assert.equal(C.yaAplicada(rowEd({ entrega: null }), dEd({ cambios: { ...dEd().cambios, entrega: {} } }), 'u1'), true);
  assert.equal(C.yaAplicada(rowEd({ entrega: { dir: 'y' } }), dEd({ cambios: { ...dEd().cambios, entrega: null } }), 'u1'), false);
});
