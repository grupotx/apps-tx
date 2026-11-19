import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nombreCarpeta, rutaDesdeUrlPublica, armarEnvio, nombreArchivo } from '../supabase/functions/_shared/envios.ts';

test('nombreCarpeta: formato NNNNNN · identificador · fecha', () => {
  assert.equal(nombreCarpeta(123, 'Folio 4567', '2026-11-19'), '000123 · Folio 4567 · 2026-11-19');
});

test('nombreCarpeta: sanea barras y conserva tildes y ñ', () => {
  const n = nombreCarpeta(1, 'Constructora A/B Ltda.', '2026-11-19');
  assert.ok(!n.includes('/'));
  assert.ok(n.includes('Ltda.'));
  assert.equal(nombreCarpeta(2, 'Ñuñoa Pérez', '2026-11-19'), '000002 · Ñuñoa Pérez · 2026-11-19');
  assert.ok(!nombreCarpeta(3, 'a\\b', '2026-11-19').includes('\\'));
});

test('nombreCarpeta: identificador se recorta a 80 caracteres', () => {
  const n = nombreCarpeta(1, 'x'.repeat(200), '2026-11-19');
  assert.equal(n, '000001 · ' + 'x'.repeat(80) + ' · 2026-11-19');
});

test('rutaDesdeUrlPublica: extrae ruta y descarta query', () => {
  assert.equal(
    rutaDesdeUrlPublica('https://x.supabase.co/storage/v1/object/public/fotos/u1/2026-11-19/a.jpg?t=1', 'fotos'),
    'u1/2026-11-19/a.jpg');
  assert.equal(rutaDesdeUrlPublica('https://x.supabase.co/storage/v1/object/public/otro/a.jpg', 'fotos'), null);
  assert.equal(rutaDesdeUrlPublica('no es url', 'fotos'), null);
});

test('armarEnvio entregas: fotos del bucket entregas y firma', () => {
  const e = armarEnvio('entregas', 'ent_entregas', {
    entrega: { id: 'e1', guia_id: 'g1', fotos: ['g1/a.jpg', 'g1/b.jpg'], firma_path: 'g1/firma.png', resultado: 'entregada', cierre_at: '2026-11-19T15:00:00Z', receptor_nombre: 'Ana', receptor_rut: '1-9', chofer_nombre: 'Luis', patente: 'AB1234' },
    guia: { folio: '4567', fecha: '2026-11-19', cliente: 'Cliente X', obra: 'Obra Y', direccion: 'Calle 1', comuna: 'Maipú' },
    devoluciones: [{ producto_descripcion: 'Saco 25kg', cantidad: 2, unidad: 'un', motivo: 'roto' }],
  }, 7);
  assert.equal(e.carpeta, '000007 · Folio 4567 · 2026-11-19');
  assert.deepEqual(e.archivos, [
    { bucket: 'entregas', ruta: 'g1/a.jpg', nombre: nombreArchivo('entregas', 'g1/a.jpg', 'foto', 'jpg') },
    { bucket: 'entregas', ruta: 'g1/b.jpg', nombre: nombreArchivo('entregas', 'g1/b.jpg', 'foto', 'jpg') },
    { bucket: 'entregas', ruta: 'g1/firma.png', nombre: nombreArchivo('entregas', 'g1/firma.png', 'firma', 'png') },
  ]);
  assert.equal(e.fila['Número'], '000007');
  assert.equal(e.fila['Fecha'], '2026-11-19');
  assert.equal(e.fila['Identificador'], 'Folio 4567');
  assert.ok(e.campos.some(([k, v]) => k === 'Receptor' && v.includes('Ana')));
  assert.ok(e.campos.some(([k, v]) => k === 'Devoluciones' && v.includes('Saco 25kg')));
});

test('armarEnvio terreno: fotos del bucket registro-terreno', () => {
  const e = armarEnvio('terreno', 'registros', { id: 'r1', kind: 'visita', fecha: '2026-11-18', cliente: 'Cliente Z', obra: 'Torre', autor_nombre: 'Pedro', datos: { motivo: 'reclamo' }, fotos: ['r1/1.jpg'] }, 1);
  assert.equal(e.identificador, 'Visita · Cliente Z');
  assert.equal(e.fecha, '2026-11-18');
  assert.deepEqual(e.archivos, [{ bucket: 'registro-terreno', ruta: 'r1/1.jpg', nombre: nombreArchivo('registro-terreno', 'r1/1.jpg', 'foto', 'jpg') }]);
  assert.ok(e.campos.some(([k, v]) => k === 'motivo' && v === 'reclamo'));
});

test('armarEnvio silos evento: fotos desde data.fotos[].id del bucket fotos', () => {
  const e = armarEnvio('silos', 'eventos', { id: 'ev1', tipo: 'Falla', fecha: '2026-11-17', silo_codigo: 'S-012', data: { fotos: [{ id: 'u/2026/a.jpg', url: 'https://x/storage/v1/object/public/fotos/u/2026/a.jpg' }], detalle: 'fuga' } }, 3);
  assert.equal(e.identificador, 'Falla · S-012');
  assert.deepEqual(e.archivos, [{ bucket: 'fotos', ruta: 'u/2026/a.jpg', nombre: nombreArchivo('fotos', 'u/2026/a.jpg', 'foto', 'jpg') }]);
});

test('armarEnvio silos solicitud: identificador por obra', () => {
  const e = armarEnvio('silos', 'solicitudes', { id: 's1', estado: 'Solicitada', created_at: '2026-11-16T10:00:00Z', data: { obra: 'Edificio Sol', cliente: 'CX' } }, 4);
  assert.equal(e.identificador, 'Solicitud · Edificio Sol');
  assert.equal(e.fecha, '2026-11-16');
});

test('armarEnvio mantención: base64 antiguo y path nuevo', () => {
  const e = armarEnvio('mantencion', 'mtto_docs', { coleccion: 'chk', id: 'c1', data: { id: 'c1', eq: 'MZ-01', fecha: '2026-11-15', items: [
    { item: 'Correa', r: 'falla', foto: 'data:image/jpeg;base64,QUJD', com: 'gastada' },
    { item: 'Aceite', r: 'ok', foto: { path: 'c1/1-123.jpg' } },
    { item: 'Ruido', r: 'ok', foto: null },
  ] } }, 9);
  assert.equal(e.identificador, 'Checklist · MZ-01');
  assert.deepEqual(e.archivos, [
    { base64: 'QUJD', nombre: 'foto_item1.jpg' },
    { bucket: 'mantencion', ruta: 'c1/1-123.jpg', nombre: nombreArchivo('mantencion', 'c1/1-123.jpg', 'foto', 'jpg') },
  ]);
});

test('armarEnvio crm: foto de la visita', () => {
  const e = armarEnvio('crm', 'crm_visits', { id: 'v1', date: '2026-11-14T12:00:00', cliente_nombre: 'Ferretería Norte', vendedor_nombre: 'Rosa', reason: 'Seguimiento', result: 'Positivo', photo: 'v1/p.jpg', lat: -33.4, lng: -70.6 }, 2);
  assert.equal(e.identificador, 'Ferretería Norte');
  assert.equal(e.fecha, '2026-11-14');
  assert.deepEqual(e.archivos, [{ bucket: 'crm-visitas', ruta: 'v1/p.jpg', nombre: nombreArchivo('crm-visitas', 'v1/p.jpg', 'foto', 'jpg') }]);
});

test('nombreArchivo: estable por ruta, distinto entre rutas, no depende de la posición', () => {
  const a = nombreArchivo('registro-terreno', 'r1/a.jpg', 'foto', 'jpg');
  assert.match(a, /^foto_[0-9a-f]{8}.jpg$/);
  assert.equal(a, nombreArchivo('registro-terreno', 'r1/a.jpg', 'foto', 'jpg'));
  assert.notEqual(a, nombreArchivo('registro-terreno', 'r1/b.jpg', 'foto', 'jpg'));
  assert.notEqual(a, nombreArchivo('fotos', 'r1/a.jpg', 'foto', 'jpg'));
  const t1 = armarEnvio('terreno', 'registros', { id: 'r1', kind: 'visita', fotos: ['r1/a.jpg', 'r1/b.jpg'] }, 1);
  const t2 = armarEnvio('terreno', 'registros', { id: 'r1', kind: 'visita', fotos: ['r1/b.jpg', 'r1/c.jpg'] }, 1);
  const nb1 = t1.archivos.find((x: any) => x.ruta === 'r1/b.jpg')!.nombre;
  const nb2 = t2.archivos.find((x: any) => x.ruta === 'r1/b.jpg')!.nombre;
  assert.equal(nb1, nb2);
  const nc2 = t2.archivos.find((x: any) => x.ruta === 'r1/c.jpg')!.nombre;
  assert.ok(!t1.archivos.some((x: any) => x.nombre === nc2));
});

test('armarEnvio entregas: descarta fotos y firma fuera de la carpeta de su guía', () => {
  const e = armarEnvio('entregas', 'ent_entregas', {
    entrega: { id: 'e1', guia_id: 'g1', fotos: ['g1/a.jpg', 'g2/ajena.jpg', 'g1/../g2/x.jpg'], firma_path: 'g2/firma.png' }, guia: {}, devoluciones: [],
  }, 1);
  assert.deepEqual(e.archivos.map((a: any) => a.ruta), ['g1/a.jpg']);
});
