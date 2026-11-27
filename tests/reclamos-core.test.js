const { test } = require('node:test');
const assert = require('node:assert/strict');
const RC = require('../reclamos-core.js');

// ── Catálogos ──
test('catálogos: estados, áreas, plantas, soluciones y roles con {id, label}', () => {
  assert.deepEqual(RC.ESTADOS.map((e) => e.id), ['ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado', 'cerrado', 'anulado']);
  assert.deepEqual(RC.AREAS.map((e) => e.id), ['calidad', 'produccion', 'logistica', 'finanzas', 'comercial']);
  assert.deepEqual(RC.PLANTAS.map((e) => e.id), ['pinturas', 'morteros', 'adhesivos', 'cementos']);
  assert.deepEqual(RC.SOLUCIONES.map((e) => e.id), ['nota_credito', 'reposicion', 'descuento', 'devolucion', 'asesoria', 'explicacion']);
  assert.deepEqual(RC.ROLES.map((e) => e.id), ['servicio_cliente', 'asesor_tecnico', 'encargado_area', 'encargado_calidad', 'gerencia']);
  for (const lista of [RC.ESTADOS, RC.AREAS, RC.PLANTAS, RC.SOLUCIONES, RC.ROLES]) {
    for (const e of lista) assert.ok(typeof e.label === 'string' && e.label.length > 0, 'falta label en ' + e.id);
  }
});

// ── plantaDeFamilia (misma regla que la función SQL rec_planta_de_familia) ──
test('plantaDeFamilia: las reglas de la base', () => {
  assert.equal(RC.plantaDeFamilia('PINTURAS · GALVAPLUS'), 'pinturas');
  assert.equal(RC.plantaDeFamilia('Pinturas'), 'pinturas');
  assert.equal(RC.plantaDeFamilia('CERAMICOS'), 'adhesivos');
  assert.equal(RC.plantaDeFamilia('ACCESORIOS'), 'adhesivos');
  assert.equal(RC.plantaDeFamilia('MORT BAS'), 'morteros');
  assert.equal(RC.plantaDeFamilia('MORT REP'), 'morteros');
  assert.equal(RC.plantaDeFamilia('Especiales'), 'morteros');
  assert.equal(RC.plantaDeFamilia('Estucos'), 'morteros');
  assert.equal(RC.plantaDeFamilia('GRANELES'), 'morteros');
  assert.equal(RC.plantaDeFamilia('Cemento'), 'cementos');
  assert.equal(RC.plantaDeFamilia('FAMILIA RARA'), 'adhesivos');
  assert.equal(RC.plantaDeFamilia('  mort bas '), 'morteros');
  assert.equal(RC.plantaDeFamilia(null), 'adhesivos');
  assert.equal(RC.plantaDeFamilia(undefined), 'adhesivos');
});

// ── validarCrear ──
const MOTIVOS = [
  { id: 'calidad_producto', nombre: 'Calidad del producto', requiere_producto: true, activo: true },
  { id: 'facturacion_cobro', nombre: 'Facturación o cobro', requiere_producto: false, activo: true },
  { id: 'viejo', nombre: 'Motivo retirado', requiere_producto: false, activo: false },
];
const HOY = '2026-11-27';
const valido = { cliente_id: 'c1', productos: [], reclamante: { tipo: 'vendedor', id: 'u1' }, motivo: 'facturacion_cobro', descripcion: 'Me cobraron dos veces', fecha_recepcion: '2026-11-26' };

test('validarCrear: un caso válido sin producto con motivo que no lo exige', () => {
  assert.deepEqual(RC.validarCrear(valido, MOTIVOS, HOY), []);
});

test('validarCrear: motivo que exige producto sin producto', () => {
  const e = RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: [] }, MOTIVOS, HOY);
  assert.equal(e.length, 1);
  assert.match(e[0], /producto/i);
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: ['P-001'] }, MOTIVOS, HOY), []);
});

test('validarCrear: fecha de recepción posterior a hoy, vacía o mal escrita', () => {
  assert.match(RC.validarCrear({ ...valido, fecha_recepcion: '2026-11-28' }, MOTIVOS, HOY).join(' '), /futura/i);
  assert.deepEqual(RC.validarCrear({ ...valido, fecha_recepcion: HOY }, MOTIVOS, HOY), []);
  assert.match(RC.validarCrear({ ...valido, fecha_recepcion: '' }, MOTIVOS, HOY).join(' '), /fecha/i);
  assert.match(RC.validarCrear({ ...valido, fecha_recepcion: '2026-13-45' }, MOTIVOS, HOY).join(' '), /fecha/i);
});

test('validarCrear: descripción vacía o en blanco, cliente y motivo faltantes o inexistentes', () => {
  assert.match(RC.validarCrear({ ...valido, descripcion: '   ' }, MOTIVOS, HOY).join(' '), /descripci/i);
  assert.match(RC.validarCrear({ ...valido, cliente_id: '' }, MOTIVOS, HOY).join(' '), /cliente/i);
  assert.match(RC.validarCrear({ ...valido, motivo: '' }, MOTIVOS, HOY).join(' '), /motivo/i);
  assert.match(RC.validarCrear({ ...valido, motivo: 'no_existe' }, MOTIVOS, HOY).join(' '), /motivo/i);
  assert.match(RC.validarCrear({ ...valido, motivo: 'viejo' }, MOTIVOS, HOY).join(' '), /motivo/i);
});

test('validarCrear: junta todos los errores a la vez', () => {
  const e = RC.validarCrear({ cliente_id: '', productos: [], reclamante: { tipo: 'vendedor', id: 'u1' }, motivo: 'calidad_producto', descripcion: '', fecha_recepcion: '2026-12-01' }, MOTIVOS, HOY);
  assert.equal(e.length, 4);
});

// ── accionesPermitidas ──
const rec = (o) => ({ id: 'r1', estado: 'ingresado', motivo: 'calidad_producto', area_destino: null, planta: 'morteros', planta_destino: null, asesor_id: null, creado_por: 'vend1', ...o });
const SC = [{ rol: 'servicio_cliente', area: null, planta: null }];
const ASESOR = [{ rol: 'asesor_tecnico', area: null, planta: null }];

test('acciones: servicio al cliente deriva un ingresado y no decide', () => {
  const a = RC.accionesPermitidas(rec({ estado: 'ingresado' }), SC, false, 'sc1');
  assert.ok(a.includes('derivar'));
  assert.ok(a.includes('anular'));
  assert.ok(!a.includes('decidir'));
  assert.ok(!a.includes('reabrir'));
});

test('acciones: servicio al cliente por estado (pedir visita, solución, comunicar, cerrar)', () => {
  assert.ok(RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'calidad', planta_destino: 'morteros' }), SC, false, 'sc1').includes('pedir_verificacion'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'logistica' }), SC, false, 'sc1').includes('pedir_verificacion'), 'solo calidad pide visita');
  assert.ok(RC.accionesPermitidas(rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as1' }), SC, false, 'sc1').includes('derivar'), 'se puede re-derivar en verificación');
  assert.ok(RC.accionesPermitidas(rec({ estado: 'aprobado' }), SC, false, 'sc1').includes('definir_solucion'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'rechazado' }), SC, false, 'sc1').includes('definir_solucion'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'solucion_definida' }), SC, false, 'sc1').includes('comunicar'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'comunicado' }), SC, false, 'sc1').includes('cerrar'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'cerrado' }), SC, false, 'sc1').includes('anular'), 'un cerrado no se anula');
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'anulado' }), SC, false, 'sc1').includes('anular'));
});

test('acciones: el asesor técnico decide calidad (derivado o en verificación) y no producción', () => {
  assert.ok(RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'calidad' }), ASESOR, false, 'as1').includes('decidir'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as1' }), ASESOR, false, 'as1').includes('decidir'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'morteros' }), ASESOR, false, 'as1').includes('decidir'));
});

test('acciones: el asesor asignado informa en verificación; otro asesor no decide uno ajeno', () => {
  const r = rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as1' });
  assert.ok(RC.accionesPermitidas(r, ASESOR, false, 'as1').includes('informe'));
  assert.ok(RC.accionesPermitidas(r, ASESOR, false, 'as1').includes('reasignar_asesor'));
  assert.ok(!RC.accionesPermitidas(r, ASESOR, false, 'as2').includes('informe'));
  assert.ok(!RC.accionesPermitidas(r, ASESOR, false, 'as2').includes('decidir'), 'asignado a otro asesor');
  assert.ok(RC.accionesPermitidas(r, SC, false, 'sc1').includes('reasignar_asesor'));
});

test('acciones: el encargado de producción de Morteros decide el de Morteros y no el de Adhesivos', () => {
  const ENC = [{ rol: 'encargado_area', area: 'produccion', planta: 'morteros' }];
  const morteros = rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'morteros' });
  const adhesivos = rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'adhesivos', planta: 'adhesivos' });
  assert.ok(RC.accionesPermitidas(morteros, ENC, false, 'e1').includes('decidir'));
  assert.ok(RC.accionesPermitidas(morteros, ENC, false, 'e1').includes('devolver'), 'puede responder "no es mío"');
  assert.ok(!RC.accionesPermitidas(adhesivos, ENC, false, 'e1').includes('decidir'));
  assert.deepEqual(RC.accionesPermitidas(adhesivos, ENC, false, 'e1'), []);
});

test('acciones: el encargado de un área sin planta (logística) decide los de su área', () => {
  const ENC = [{ rol: 'encargado_area', area: 'logistica', planta: null }];
  assert.ok(RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'logistica', planta: null }), ENC, false, 'e1').includes('decidir'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'finanzas', planta: null }), ENC, false, 'e1').includes('decidir'));
});

test('acciones: varios alcances se suman (servicio al cliente + encargado) sin mezclar permisos', () => {
  const MIX = [...SC, { rol: 'encargado_area', area: 'produccion', planta: 'morteros' }];
  const a = RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'morteros' }), MIX, false, 'x');
  assert.ok(a.includes('decidir') && a.includes('derivar'));
  const b = RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'adhesivos' }), MIX, false, 'x');
  assert.ok(!b.includes('decidir') && b.includes('derivar'));
});

test('acciones: el encargado de calidad (solo informado), la gerencia y el vendedor no tienen acciones', () => {
  const CAL = [{ rol: 'encargado_calidad', area: null, planta: 'morteros' }];
  const GER = [{ rol: 'gerencia', area: null, planta: null }];
  for (const e of RC.ESTADOS.map((x) => x.id)) {
    const r = rec({ estado: e, area_destino: 'calidad', planta_destino: 'morteros', asesor_id: 'as1' });
    assert.deepEqual(RC.accionesPermitidas(r, CAL, false, 'c1'), [], 'encargado de calidad en ' + e);
    assert.deepEqual(RC.accionesPermitidas(r, GER, false, 'g1'), [], 'gerencia en ' + e);
    assert.deepEqual(RC.accionesPermitidas(r, [], false, 'vend1'), [], 'vendedor en ' + e);
  }
});

test('acciones: el administrador reabre cerrados y anulados, corrige la compensación y hace lo de servicio al cliente', () => {
  assert.ok(RC.accionesPermitidas(rec({ estado: 'cerrado' }), [], true, 'adm').includes('reabrir'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'anulado' }), [], true, 'adm').includes('reabrir'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'comunicado' }), [], true, 'adm').includes('reabrir'), 'solo cerrado o anulado');
  assert.ok(RC.accionesPermitidas(rec({ estado: 'cerrado' }), [], true, 'adm').includes('corregir_compensacion'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'ingresado' }), [], true, 'adm').includes('derivar'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'calidad' }), [], true, 'adm').includes('decidir'), 'el admin no decide sin alcance');
});

test('acciones: servicio al cliente corrige la compensación hasta antes de cerrar, no después', () => {
  assert.ok(RC.accionesPermitidas(rec({ estado: 'solucion_definida' }), SC, false, 'sc1').includes('corregir_compensacion'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'comunicado' }), SC, false, 'sc1').includes('corregir_compensacion'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'cerrado' }), SC, false, 'sc1').includes('corregir_compensacion'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'aprobado' }), SC, false, 'sc1').includes('corregir_compensacion'), 'aún no hay compensación');
});

test('acciones: nadie reabre salvo el administrador', () => {
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'cerrado' }), SC, false, 'sc1').includes('reabrir'));
});

// ── mensajeCliente ──
test('mensajeCliente: un aprobado con 45000 muestra "$45.000", la solución y el folio', () => {
  const m = RC.mensajeCliente({ folio: 'REC-2026-0007', fecha_recepcion: '2026-11-20', decision: 'aprobado', razones: 'El lote presentaba desprendimiento.', solucion_tipo: 'reposicion', solucion_detalle: 'Se repone el material en la próxima entrega.', compensacion: 45000 }, { name: 'Constructora Sur' });
  assert.match(m, /Constructora Sur/);
  assert.match(m, /REC-2026-0007/);
  assert.match(m, /20-11-2026/);
  assert.match(m, /aprobad/i);
  assert.match(m, /desprendimiento/);
  assert.match(m, /Reposición de producto/);
  assert.match(m, /próxima entrega/);
  assert.match(m, /\$45\.000/);
});

test('mensajeCliente: un rechazado incluye las razones y "$0"', () => {
  const m = RC.mensajeCliente({ folio: 'REC-2026-0008', fecha_recepcion: '2026-11-21', decision: 'rechazado', razones: 'El producto estaba fuera de su vida útil.', solucion_tipo: 'explicacion', solucion_detalle: '', compensacion: 0 }, { name: 'Ferretería Norte' });
  assert.match(m, /rechazad/i);
  assert.match(m, /fuera de su vida útil/);
  assert.match(m, /\$0(?![\d.])/);
});

test('mensajeCliente: montos grandes con separador de miles y sin monto cae en $0', () => {
  assert.match(RC.mensajeCliente({ decision: 'aprobado', razones: 'x', compensacion: 1234567 }, { name: 'A' }), /\$1\.234\.567/);
  assert.match(RC.mensajeCliente({ decision: 'aprobado', razones: 'x', compensacion: null }, { name: 'A' }), /\$0(?![\d.])/);
  assert.match(RC.mensajeCliente({ decision: 'aprobado', razones: 'x', compensacion: 0 }, null), /Estimado/);
});

// ── metricas ──
const R = (o) => ({ id: 'x', estado: 'cerrado', motivo: 'calidad_producto', area_destino: 'calidad', planta: 'morteros', planta_destino: 'morteros', producto: 'P1', compensacion: 0, fecha_recepcion: '2026-11-01', comunicado_en: null, ...o });

test('metricas: un anulado no cuenta; cerrados de 3 y 5 días dan promedio 4; suma costos por motivo', () => {
  const rs = [
    R({ id: 'a', estado: 'anulado', compensacion: 100, comunicado_en: '2026-11-02T12:00:00Z' }),
    R({ id: 'b', compensacion: 10000, fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-04T15:00:00Z' }),
    R({ id: 'c', motivo: 'dano_transporte', area_destino: 'logistica', planta_destino: null, planta: 'adhesivos', producto: 'P2', compensacion: 5000, fecha_recepcion: '2026-11-02', comunicado_en: '2026-11-07T15:00:00Z' }),
  ];
  const m = RC.metricas(rs, [], { desde: '2026-11-01', hasta: '2026-11-30' });
  assert.equal(m.total, 2);
  assert.equal(m.abiertos, 0);
  assert.equal(m.costoTotal, 15000);
  assert.deepEqual(m.costoPorMotivo, { calidad_producto: 10000, dano_transporte: 5000 });
  assert.deepEqual(m.costoPorArea, { calidad: 10000, logistica: 5000 });
  assert.deepEqual(m.costoPorPlanta, { morteros: 10000, adhesivos: 5000 });
  assert.deepEqual(m.costoPorProducto, { P1: 10000, P2: 5000 });
  assert.deepEqual(m.respuestaDias, { promedio: 4, mediana: 4, n: 2 });
  assert.deepEqual(m.porMotivo, { calidad_producto: 1, dano_transporte: 1 });
  assert.deepEqual(m.porArea, { calidad: 1, logistica: 1 });
  assert.deepEqual(m.porPlanta, { morteros: 1, adhesivos: 1 });
});

test('metricas: filtra por período sobre la fecha de recepción (ambos extremos incluidos)', () => {
  const rs = [
    R({ id: 'a', fecha_recepcion: '2026-10-31', compensacion: 1 }),
    R({ id: 'b', fecha_recepcion: '2026-11-01', compensacion: 2 }),
    R({ id: 'c', fecha_recepcion: '2026-11-30', compensacion: 4 }),
    R({ id: 'd', fecha_recepcion: '2026-12-01', compensacion: 8 }),
  ];
  const m = RC.metricas(rs, [], { desde: '2026-11-01', hasta: '2026-11-30' });
  assert.equal(m.total, 2);
  assert.equal(m.costoTotal, 6);
  assert.equal(RC.metricas(rs, [], {}).total, 4, 'sin período entra todo');
});

test('metricas: los abiertos son los no cerrados; sin planta ni producto no entran en esas vistas', () => {
  const rs = [
    R({ id: 'a', estado: 'derivado', compensacion: null }),
    R({ id: 'b', estado: 'solucion_definida', compensacion: 2000 }),
    R({ id: 'c', estado: 'cerrado', motivo: 'facturacion_cobro', area_destino: 'finanzas', planta: null, planta_destino: null, producto: null, compensacion: 3000 }),
  ];
  const m = RC.metricas(rs, [], {});
  assert.equal(m.total, 3);
  assert.equal(m.abiertos, 2);
  assert.equal(m.costoTotal, 5000);
  assert.deepEqual(m.costoPorPlanta, { morteros: 2000 });
  assert.deepEqual(m.costoPorProducto, { P1: 2000 });
  assert.deepEqual(m.porPlanta, { morteros: 2 });
  assert.deepEqual(m.porMotivo, { calidad_producto: 2, facturacion_cobro: 1 });
  assert.deepEqual(m.porArea, { calidad: 2, finanzas: 1 });
});

test('metricas: sin datos devuelve ceros y nulos, no NaN', () => {
  const m = RC.metricas([], [], {});
  assert.equal(m.total, 0);
  assert.equal(m.abiertos, 0);
  assert.equal(m.costoTotal, 0);
  assert.deepEqual(m.respuestaDias, { promedio: null, mediana: null, n: 0 });
  assert.deepEqual(m.etapasDias, { ingresado_derivado: null, derivado_decision: null, decision_solucion: null, solucion_comunicado: null });
});

test('metricas: etapas por reclamo desde la historia (días corridos, un decimal)', () => {
  const ev = (reclamo_id, a_estado, creado_en, tipo = 'cambio') => ({ reclamo_id, tipo, a_estado, creado_en });
  const rs = [R({ id: 'a', comunicado_en: '2026-11-08T12:00:00Z', fecha_recepcion: '2026-11-01' })];
  const eventos = [
    ev('a', 'ingresado', '2026-11-01T12:00:00Z', 'creado'),
    ev('a', 'derivado', '2026-11-02T12:00:00Z'),
    ev('a', 'aprobado', '2026-11-04T12:00:00Z'),
    ev('a', 'solucion_definida', '2026-11-05T12:00:00Z'),
    ev('a', 'comunicado', '2026-11-08T00:00:00Z'),
  ];
  const m = RC.metricas(rs, eventos, {});
  assert.deepEqual(m.etapasDias, { ingresado_derivado: 1, derivado_decision: 2, decision_solucion: 1, solucion_comunicado: 2.5 });
});

test('metricas: un reabierto usa solo su último ciclo, no genera etapas negativas y cuenta una vez', () => {
  const ev = (a_estado, creado_en, tipo = 'cambio') => ({ reclamo_id: 'r', tipo, a_estado, creado_en });
  const rs = [R({ id: 'r', estado: 'comunicado', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-16T12:00:00Z', compensacion: 7000 })];
  const eventos = [
    // primer ciclo (cerrado)
    ev('ingresado', '2026-11-01T12:00:00Z', 'creado'),
    ev('derivado', '2026-11-01T14:00:00Z'),
    ev('aprobado', '2026-11-02T12:00:00Z'),
    ev('solucion_definida', '2026-11-03T12:00:00Z'),
    ev('comunicado', '2026-11-04T12:00:00Z'),
    ev('cerrado', '2026-11-05T12:00:00Z'),
    // se reabre y arranca otro ciclo
    ev('ingresado', '2026-11-10T12:00:00Z', 'reabierto'),
    ev('derivado', '2026-11-11T12:00:00Z'),
    ev('rechazado', '2026-11-13T12:00:00Z'),
    ev('solucion_definida', '2026-11-14T12:00:00Z'),
    ev('comunicado', '2026-11-16T12:00:00Z'),
  ];
  const m = RC.metricas(rs, eventos, {});
  assert.equal(m.total, 1);
  assert.deepEqual(m.etapasDias, { ingresado_derivado: 1, derivado_decision: 2, decision_solucion: 1, solucion_comunicado: 2 });
  for (const v of Object.values(m.etapasDias)) assert.ok(v === null || v >= 0);
  assert.deepEqual(m.respuestaDias, { promedio: 15, mediana: 15, n: 1 });
});

test('metricas: eventos fuera de orden o un reclamo reabierto sin eventos del ciclo no dan negativos ni NaN', () => {
  const rs = [R({ id: 'r', estado: 'ingresado', comunicado_en: null })];
  const eventos = [
    { reclamo_id: 'r', tipo: 'cambio', a_estado: 'derivado', creado_en: '2026-11-03T12:00:00Z' },
    { reclamo_id: 'r', tipo: 'reabierto', a_estado: 'ingresado', creado_en: '2026-11-10T12:00:00Z' },
    { reclamo_id: 'r', tipo: 'creado', a_estado: 'ingresado', creado_en: '2026-11-01T12:00:00Z' },
  ];
  const m = RC.metricas(rs, eventos, {});
  for (const v of Object.values(m.etapasDias)) assert.ok(v === null || (Number.isFinite(v) && v >= 0));
  assert.deepEqual(m.respuestaDias, { promedio: null, mediana: null, n: 0 });
});

test('metricas: la mediana de un número par de casos y los días nunca son negativos', () => {
  const rs = [
    R({ id: 'a', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-02T15:00:00Z' }),
    R({ id: 'b', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-04T15:00:00Z' }),
    R({ id: 'c', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-10T15:00:00Z' }),
    R({ id: 'd', fecha_recepcion: '2026-11-05', comunicado_en: '2026-11-04T15:00:00Z' }), // comunicado antes de la recepción: se acota a 0
  ];
  const m = RC.metricas(rs, [], {});
  // días: 1, 3, 9, 0 → promedio 3,25 → 3,3 ; mediana (1+3)/2 = 2
  assert.deepEqual(m.respuestaDias, { promedio: 3.3, mediana: 2, n: 4 });
});

// ── pendienteDeMi / esInformado (bandeja) ──
test('pendienteDeMi: servicio al cliente tiene pendiente lo que depende de él, no lo que espera a otros', () => {
  const p = (estado, extra) => RC.pendienteDeMi(rec({ estado, ...extra }), SC, false, 'sc1');
  assert.equal(p('ingresado'), true);
  assert.equal(p('derivado', { area_destino: 'calidad' }), false);
  assert.equal(p('en_verificacion', { area_destino: 'calidad', asesor_id: 'as1' }), false);
  assert.equal(p('aprobado'), true);
  assert.equal(p('rechazado'), true);
  assert.equal(p('solucion_definida'), true);
  assert.equal(p('comunicado'), true);
  assert.equal(p('cerrado'), false);
  assert.equal(p('anulado'), false);
});

test('pendienteDeMi: asesor, encargado de área y el resto', () => {
  assert.equal(RC.pendienteDeMi(rec({ estado: 'derivado', area_destino: 'calidad' }), ASESOR, false, 'as1'), true);
  assert.equal(RC.pendienteDeMi(rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as1' }), ASESOR, false, 'as1'), true);
  assert.equal(RC.pendienteDeMi(rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as2' }), ASESOR, false, 'as1'), false);
  const ENC = [{ rol: 'encargado_area', area: 'produccion', planta: 'morteros' }];
  assert.equal(RC.pendienteDeMi(rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'morteros' }), ENC, false, 'e1'), true);
  assert.equal(RC.pendienteDeMi(rec({ estado: 'derivado', area_destino: 'produccion', planta_destino: 'adhesivos' }), ENC, false, 'e1'), false);
  assert.equal(RC.pendienteDeMi(rec({ estado: 'aprobado', area_destino: 'produccion', planta_destino: 'morteros' }), ENC, false, 'e1'), false, 'ya decidió');
  const CAL = [{ rol: 'encargado_calidad', area: null, planta: 'morteros' }];
  const GER = [{ rol: 'gerencia', area: null, planta: null }];
  for (const e of RC.ESTADOS.map((x) => x.id)) {
    const r = rec({ estado: e, area_destino: 'calidad', planta_destino: 'morteros' });
    assert.equal(RC.pendienteDeMi(r, CAL, false, 'c1'), false);
    assert.equal(RC.pendienteDeMi(r, GER, false, 'g1'), false);
    assert.equal(RC.pendienteDeMi(r, [], false, 'vend1'), false);
  }
});

test('pendienteDeMi: el administrador sin alcance de servicio al cliente no acumula pendientes', () => {
  assert.equal(RC.pendienteDeMi(rec({ estado: 'ingresado' }), [], true, 'adm'), false);
  assert.equal(RC.pendienteDeMi(rec({ estado: 'comunicado' }), SC, true, 'adm'), true, 'si además tiene el rol de servicio al cliente, sí');
  assert.equal(RC.pendienteDeMi(rec({ estado: 'comunicado' }), SC, false, 'sc1'), true);
});

test('esInformado: el encargado de calidad de la planta ve los de calidad de su planta', () => {
  const CAL = [{ rol: 'encargado_calidad', area: null, planta: 'morteros' }];
  assert.equal(RC.esInformado(rec({ area_destino: 'calidad', planta_destino: 'morteros' }), CAL), true);
  assert.equal(RC.esInformado(rec({ area_destino: 'calidad', planta_destino: 'pinturas' }), CAL), false);
  assert.equal(RC.esInformado(rec({ area_destino: 'produccion', planta_destino: 'morteros' }), CAL), false);
  assert.equal(RC.esInformado(rec({ area_destino: 'calidad', planta_destino: 'morteros', estado: 'anulado' }), CAL), false);
  assert.equal(RC.esInformado(rec({ area_destino: 'calidad', planta_destino: 'morteros' }), SC), false);
  assert.equal(RC.esInformado(rec({ area_destino: null }), CAL), false);
});

// ── ajustes de la revisión: completar_datos, validarMonto, fecha antigua, desempate de eventos ──
test('acciones: completar_datos lo tienen servicio al cliente/admin (salvo cerrado/anulado) y el asesor asignado en verificación', () => {
  for (const e of ['ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado']) {
    assert.ok(RC.accionesPermitidas(rec({ estado: e }), SC, false, 'sc1').includes('completar_datos'), 'servicio al cliente en ' + e);
  }
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'cerrado' }), SC, false, 'sc1').includes('completar_datos'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'anulado' }), [], true, 'adm').includes('completar_datos'));
  assert.ok(RC.accionesPermitidas(rec({ estado: 'ingresado' }), [], true, 'adm').includes('completar_datos'));
  const r = rec({ estado: 'en_verificacion', area_destino: 'calidad', asesor_id: 'as1' });
  assert.ok(RC.accionesPermitidas(r, ASESOR, false, 'as1').includes('completar_datos'));
  assert.ok(!RC.accionesPermitidas(r, ASESOR, false, 'as2').includes('completar_datos'));
  assert.ok(!RC.accionesPermitidas(rec({ estado: 'derivado', area_destino: 'calidad' }), ASESOR, false, 'as1').includes('completar_datos'), 'el asesor solo durante la verificación');
});

test('validarMonto: entero en pesos, no negativo, acepta puntos de miles', () => {
  assert.deepEqual(RC.validarMonto('45000'), { valor: 45000, error: null });
  assert.deepEqual(RC.validarMonto(' 45.000 '), { valor: 45000, error: null });
  assert.deepEqual(RC.validarMonto('1.234.567'), { valor: 1234567, error: null });
  assert.deepEqual(RC.validarMonto(0), { valor: 0, error: null });
  assert.deepEqual(RC.validarMonto('0'), { valor: 0, error: null });
  for (const malo of ['12,5', '12.5', '12.50', '-1', '-0', 'abc', '1e3', '$ 100']) {
    const r = RC.validarMonto(malo);
    assert.equal(r.valor, null, malo);
    assert.ok(r.error && r.error.length > 0, malo);
  }
  assert.match(RC.validarMonto('').error, /monto/i);
  assert.match(RC.validarMonto(null).error, /monto/i);
  assert.match(RC.validarMonto('12,5').error, /entero/i);
  assert.match(RC.validarMonto('-5').error, /negativ/i);
});

test('validarCrear: una fecha de recepción de más de un año atrás se rechaza', () => {
  assert.match(RC.validarCrear({ ...valido, fecha_recepcion: '2025-11-26' }, MOTIVOS, HOY).join(' '), /año/i);
  assert.deepEqual(RC.validarCrear({ ...valido, fecha_recepcion: '2025-11-27' }, MOTIVOS, HOY), []);
});

test('metricas: eventos con la misma hora se ordenan por id, no por el orden en que llegan', () => {
  const rs = [R({ id: 'r', estado: 'comunicado', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-05T12:00:00Z' })];
  const t = '2026-11-02T12:00:00Z';
  const eventos = [
    { id: 4, reclamo_id: 'r', tipo: 'cambio', a_estado: 'solucion_definida', creado_en: t },
    { id: 3, reclamo_id: 'r', tipo: 'cambio', a_estado: 'aprobado', creado_en: t },
    { id: 2, reclamo_id: 'r', tipo: 'cambio', a_estado: 'derivado', creado_en: t },
    { id: 1, reclamo_id: 'r', tipo: 'creado', a_estado: 'ingresado', creado_en: t },
    { id: 5, reclamo_id: 'r', tipo: 'cambio', a_estado: 'comunicado', creado_en: '2026-11-05T12:00:00Z' },
  ];
  const m = RC.metricas(rs, eventos, {});
  assert.deepEqual(m.etapasDias, { ingresado_derivado: 0, derivado_decision: 0, decision_solucion: 0, solucion_comunicado: 3 });
});

// ── panel: enPeriodo y conteo por producto ──
test('enPeriodo: sobre la fecha de recepción, extremos incluidos; los anulados no entran', () => {
  const r = (f, estado = 'cerrado') => ({ fecha_recepcion: f, estado });
  assert.equal(RC.enPeriodo(r('2026-11-01'), { desde: '2026-11-01', hasta: '2026-11-30' }), true);
  assert.equal(RC.enPeriodo(r('2026-11-30'), { desde: '2026-11-01', hasta: '2026-11-30' }), true);
  assert.equal(RC.enPeriodo(r('2026-10-31'), { desde: '2026-11-01', hasta: '2026-11-30' }), false);
  assert.equal(RC.enPeriodo(r('2026-12-01'), { desde: '2026-11-01', hasta: '2026-11-30' }), false);
  assert.equal(RC.enPeriodo(r('2026-05-05'), {}), true);
  assert.equal(RC.enPeriodo(r('2026-05-05'), null), true);
  assert.equal(RC.enPeriodo(r('2026-11-05', 'anulado'), {}), false);
  assert.equal(RC.enPeriodo(r('2026-11-05T10:00:00Z'), { desde: '2026-11-05', hasta: '2026-11-05' }), true, 'acepta fecha con hora');
});

test('metricas: porProducto cuenta solo los reclamos con producto', () => {
  const m = RC.metricas([R({ id: 'a', producto: 'P1' }), R({ id: 'b', producto: 'P1' }), R({ id: 'c', producto: 'P2' }), R({ id: 'd', producto: null }), R({ id: 'e', producto: 'P9', estado: 'anulado' })], [], {});
  assert.deepEqual(m.porProducto, { P1: 2, P2: 1 });
});

// ── varios productos y reclamante ──
const P = (code, nombre, planta) => ({ code, nombre: nombre || code, planta: planta || null });

test('productosDe: usa la lista productos; un reclamo antiguo se arma con las columnas de siempre; sin nada, vacío', () => {
  const lista = [P('A1', 'PINTURA A', 'pinturas'), P('B2', 'ADHESIVO B', 'adhesivos')];
  assert.deepEqual(RC.productosDe({ productos: lista, producto: 'ZZ' }), lista);
  assert.deepEqual(RC.productosDe({ producto: 'AC001-25', producto_nombre: 'ADHESIVO X', planta: 'adhesivos' }), [P('AC001-25', 'ADHESIVO X', 'adhesivos')]);
  assert.deepEqual(RC.productosDe({ producto: 'AC001-25' }), [P('AC001-25', 'AC001-25', null)]);
  assert.deepEqual(RC.productosDe({ productos: [], producto: 'AC001-25', producto_nombre: 'ADHESIVO X', planta: 'adhesivos' }), [P('AC001-25', 'ADHESIVO X', 'adhesivos')]);
  assert.deepEqual(RC.productosDe({}), []);
  assert.deepEqual(RC.productosDe({ producto: null, productos: null }), []);
  assert.deepEqual(RC.productosDe(null), []);
});

test('resumenProductos y textoProductos: vacío, un producto, varios', () => {
  assert.equal(RC.resumenProductos({}), '');
  assert.equal(RC.resumenProductos({ productos: [P('A', 'ADHESIVO X')] }), 'ADHESIVO X');
  assert.equal(RC.resumenProductos({ productos: [P('A', 'ADHESIVO X'), P('B', 'B'), P('C', 'C')] }), 'ADHESIVO X +2');
  assert.equal(RC.resumenProductos({ producto: 'P1', producto_nombre: 'ANTIGUO' }), 'ANTIGUO');
  assert.equal(RC.textoProductos({}), '');
  assert.equal(RC.textoProductos({ productos: [P('A', 'A'), P('B', 'B')] }), 'A / B');
  assert.equal(RC.textoProductos({ producto: 'P1', producto_nombre: 'ANTIGUO' }), 'ANTIGUO');
});

test('plantasDe: plantas distintas en orden de aparición, sin nulos', () => {
  assert.deepEqual(RC.plantasDe({ productos: [P('A', 'A', 'pinturas'), P('B', 'B', 'adhesivos'), P('C', 'C', 'pinturas')] }), ['pinturas', 'adhesivos']);
  assert.deepEqual(RC.plantasDe({ productos: [P('A', 'A', null), P('B', 'B', 'morteros')] }), ['morteros']);
  assert.deepEqual(RC.plantasDe({ producto: 'P1', planta: 'cementos' }), ['cementos']);
  assert.deepEqual(RC.plantasDe({}), []);
});

test('catálogos: MAX_PRODUCTOS y RECLAMANTES', () => {
  assert.equal(RC.MAX_PRODUCTOS, 10);
  assert.deepEqual(RC.RECLAMANTES, [{ id: 'vendedor', label: 'Vendedor' }, { id: 'cliente', label: 'Cliente' }]);
});

test('validarReclamante: sin tipo, vendedor sin elegir y vendedor válido', () => {
  assert.deepEqual(RC.validarReclamante({}), ['Indica quién reclama: vendedor o cliente.']);
  assert.deepEqual(RC.validarReclamante(undefined), ['Indica quién reclama: vendedor o cliente.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'otro', nombre: 'Ana' }), ['Indica quién reclama: vendedor o cliente.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor' }), ['Elige el vendedor.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor', id: 'u1' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor', id: 'u1', telefono: '' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor', id: 'u1', telefono: '+56 9 1234 5678' }), []);
});

test('validarReclamante: el teléfono del vendedor, si viene, debe tener al menos 7 dígitos', () => {
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor', id: 'u1', telefono: '123' }), ['El teléfono debe tener al menos 7 dígitos.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'vendedor', telefono: '123' }), ['Elige el vendedor.', 'El teléfono debe tener al menos 7 dígitos.']);
});

test('validarReclamante: cliente sin nombre ni medios, con correo malo y válido', () => {
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente' }), ['Escribe el nombre de quien reclama.', 'Indica un correo o un teléfono de contacto.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: '   ', correo: ' ', telefono: ' ' }), ['Escribe el nombre de quien reclama.', 'Indica un correo o un teléfono de contacto.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana' }), ['Indica un correo o un teléfono de contacto.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', correo: 'ana@x' }), ['El correo no tiene un formato válido.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', correo: 'ana @x.cl' }), ['El correo no tiene un formato válido.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', correo: 'ana@x.cl' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', correo: '  ana@x.cl  ' }), []);
});

test('validarReclamante: formato del teléfono (dígitos, separadores permitidos, 7 dígitos, 30 caracteres)', () => {
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '+56 9 1234 5678' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '(02) 2345-6789' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '2.345.678' }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '123456' }), ['El teléfono debe tener al menos 7 dígitos.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '12 34-56' }), ['El teléfono debe tener al menos 7 dígitos.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '1234567 ext 8' }), ['El teléfono debe tener al menos 7 dígitos.']);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '9'.repeat(30) }), []);
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', telefono: '9'.repeat(31) }), ['El teléfono debe tener al menos 7 dígitos.']);
});

test('validarReclamante: cliente con correo y teléfono inválidos informa ambos', () => {
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'Ana', correo: 'ana', telefono: '12' }), ['El correo no tiene un formato válido.', 'El teléfono debe tener al menos 7 dígitos.']);
});

test('validarCrear: máximo 10 productos, sin repetidos y con exigencia de producto según el motivo', () => {
  const diez = Array.from({ length: 10 }, (_, i) => 'P' + i);
  assert.deepEqual(RC.validarCrear({ ...valido, productos: diez }, MOTIVOS, HOY), []);
  assert.deepEqual(RC.validarCrear({ ...valido, productos: [...diez, 'P10'] }, MOTIVOS, HOY), ['Máximo 10 productos por reclamo.']);
  assert.deepEqual(RC.validarCrear({ ...valido, productos: ['A', 'A'] }, MOTIVOS, HOY), ['Hay productos repetidos.']);
  assert.deepEqual(RC.validarCrear({ ...valido, productos: ['A', ' A '] }, MOTIVOS, HOY), ['Hay productos repetidos.']);
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: [] }, MOTIVOS, HOY), ['Este motivo exige indicar el producto.']);
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: ['', '  '] }, MOTIVOS, HOY), ['Este motivo exige indicar el producto.']);
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto' }, MOTIVOS, HOY), ['Este motivo exige indicar el producto.']);
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: ['A', 'B'] }, MOTIVOS, HOY), []);
});

test('validarCrear ya no lee el campo producto (solo productos)', () => {
  assert.deepEqual(RC.validarCrear({ ...valido, motivo: 'calidad_producto', productos: [], producto: 'P-001' }, MOTIVOS, HOY), ['Este motivo exige indicar el producto.']);
});

test('validarCrear: el reclamante inválido agrega sus errores', () => {
  assert.deepEqual(RC.validarCrear({ ...valido, reclamante: undefined }, MOTIVOS, HOY), ['Indica quién reclama: vendedor o cliente.']);
  assert.deepEqual(RC.validarCrear({ ...valido, reclamante: { tipo: 'vendedor' } }, MOTIVOS, HOY), ['Elige el vendedor.']);
  assert.deepEqual(RC.validarCrear({ ...valido, reclamante: { tipo: 'cliente' } }, MOTIVOS, HOY), ['Escribe el nombre de quien reclama.', 'Indica un correo o un teléfono de contacto.']);
  assert.deepEqual(RC.validarCrear({ ...valido, reclamante: { tipo: 'cliente', nombre: 'Ana', correo: 'ana@x.cl' } }, MOTIVOS, HOY), []);
});

test('validarCrear: un ingreso completo con varios productos y reclamante cliente es válido', () => {
  const d = { cliente_id: 'c1', motivo: 'calidad_producto', productos: ['A', 'B', 'C'], reclamante: { tipo: 'cliente', nombre: 'Ana Pérez', telefono: '+56 9 1234 5678' }, descripcion: 'Llegó roto', fecha_recepcion: '2026-11-26' };
  assert.deepEqual(RC.validarCrear(d, MOTIVOS, HOY), []);
});

test('repartir: n enteros que suman el total; el resto, de a uno, a los primeros', () => {
  assert.deepEqual(RC.repartir(100000, 3), [33334, 33333, 33333]);
  assert.deepEqual(RC.repartir(5, 1), [5]);
  assert.deepEqual(RC.repartir(0, 2), [0, 0]);
  assert.deepEqual(RC.repartir(10001, 2), [5001, 5000]);
  assert.deepEqual(RC.repartir(2, 5), [1, 1, 0, 0, 0]);
  for (const [t, n] of [[100000, 3], [7, 4], [1, 10], [123457, 7], [0, 5], [99, 10]]) {
    const r = RC.repartir(t, n);
    assert.equal(r.length, n);
    assert.equal(r.reduce((a, b) => a + b, 0), t);
    assert.ok(r.every((x) => Number.isInteger(x) && x >= 0));
  }
  assert.deepEqual(RC.repartir(10, 0), []);
});

test('metricas: un reclamo con varios productos cuenta en cada uno y reparte el costo', () => {
  const rs = [
    R({ id: 'a', producto: 'A', productos: [P('A', 'PA', 'pinturas'), P('B', 'PB', 'adhesivos')], compensacion: 10001 }),
    R({ id: 'b', producto: 'A', productos: [P('A', 'PA', 'pinturas')], compensacion: 100 }),
  ];
  const m = RC.metricas(rs, [], {});
  assert.deepEqual(m.porProducto, { A: 2, B: 1 });
  assert.deepEqual(m.costoPorProducto, { A: 5101, B: 5000 });
  assert.equal(m.costoTotal, 10101);
  assert.equal(Object.values(m.costoPorProducto).reduce((a, b) => a + b, 0), m.costoTotal);
});

test('metricas: un código repetido dentro del reclamo cuenta una vez y el reparto es sobre los códigos distintos', () => {
  const m = RC.metricas([R({ id: 'a', productos: [P('A'), P('A'), P('B')], compensacion: 3 })], [], {});
  assert.deepEqual(m.porProducto, { A: 1, B: 1 });
  assert.deepEqual(m.costoPorProducto, { A: 2, B: 1 });
});

test('metricas: un reclamo antiguo con solo producto cuenta en ese producto; sin compensación no hay costo', () => {
  const m = RC.metricas([R({ id: 'a', producto: 'OLD', compensacion: 700 }), R({ id: 'b', producto: 'OLD2', compensacion: null })], [], {});
  assert.deepEqual(m.porProducto, { OLD: 1, OLD2: 1 });
  assert.deepEqual(m.costoPorProducto, { OLD: 700 });
});

test('metricas: porPlanta cuenta una vez por planta_destino || planta, aunque haya productos de varias plantas; el anulado no cuenta', () => {
  const rs = [
    R({ id: 'a', planta: 'pinturas', planta_destino: 'adhesivos', productos: [P('A', 'A', 'pinturas'), P('B', 'B', 'adhesivos')], compensacion: 10 }),
    R({ id: 'b', planta: 'pinturas', planta_destino: null, productos: [P('A', 'A', 'pinturas'), P('C', 'C', 'morteros')], compensacion: 20 }),
    R({ id: 'c', estado: 'anulado', planta: 'cementos', planta_destino: 'cementos', productos: [P('Z', 'Z', 'cementos')], compensacion: 99 }),
  ];
  const m = RC.metricas(rs, [], {});
  assert.deepEqual(m.porPlanta, { adhesivos: 1, pinturas: 1 });
  assert.deepEqual(m.costoPorPlanta, { adhesivos: 10, pinturas: 20 });
  assert.deepEqual(m.porProducto, { A: 2, B: 1, C: 1 });
  assert.equal(m.porProducto.Z, undefined);
  assert.equal(m.costoPorProducto.Z, undefined);
});

test('RE_CORREO: la regex que usan validarReclamante y la pantalla', () => {
  assert.ok(RC.RE_CORREO.test('a@b.cl'));
  assert.ok(!RC.RE_CORREO.test('a@b'));
  assert.ok(!RC.RE_CORREO.test('a b@c.cl'));
  assert.deepEqual(RC.validarReclamante({ tipo: 'cliente', nombre: 'X', correo: 'a@b' }), ['El correo no tiene un formato válido.']);
});
