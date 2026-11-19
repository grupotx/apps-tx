import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nombreCarpeta, rutaDesdeUrlPublica, armarEnvio } from '../supabase/functions/_shared/envios.ts';

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
    entrega: { id: 'e1', fotos: ['g1/a.jpg', 'g1/b.jpg'], firma_path: 'g1/firma.png', resultado: 'entregada', cierre_at: '2026-11-19T15:00:00Z', receptor_nombre: 'Ana', receptor_rut: '1-9', chofer_nombre: 'Luis', patente: 'AB1234' },
    guia: { folio: '4567', fecha: '2026-11-19', cliente: 'Cliente X', obra: 'Obra Y', direccion: 'Calle 1', comuna: 'Maipú' },
    devoluciones: [{ producto_descripcion: 'Saco 25kg', cantidad: 2, unidad: 'un', motivo: 'roto' }],
  }, 7);
  assert.equal(e.carpeta, '000007 · Folio 4567 · 2026-11-19');
  assert.deepEqual(e.archivos, [
    { bucket: 'entregas', ruta: 'g1/a.jpg', nombre: 'foto_1.jpg' },
    { bucket: 'entregas', ruta: 'g1/b.jpg', nombre: 'foto_2.jpg' },
    { bucket: 'entregas', ruta: 'g1/firma.png', nombre: 'firma.png' },
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
  assert.deepEqual(e.archivos, [{ bucket: 'registro-terreno', ruta: 'r1/1.jpg', nombre: 'foto_1.jpg' }]);
  assert.ok(e.campos.some(([k, v]) => k === 'motivo' && v === 'reclamo'));
});

test('armarEnvio silos evento: fotos desde data.fotos[].id del bucket fotos', () => {
  const e = armarEnvio('silos', 'eventos', { id: 'ev1', tipo: 'Falla', fecha: '2026-11-17', silo_codigo: 'S-012', data: { fotos: [{ id: 'u/2026/a.jpg', url: 'https://x/storage/v1/object/public/fotos/u/2026/a.jpg' }], detalle: 'fuga' } }, 3);
  assert.equal(e.identificador, 'Falla · S-012');
  assert.deepEqual(e.archivos, [{ bucket: 'fotos', ruta: 'u/2026/a.jpg', nombre: 'foto_1.jpg' }]);
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
    { base64: 'QUJD', nombre: 'foto_1.jpg' },
    { bucket: 'mantencion', ruta: 'c1/1-123.jpg', nombre: 'foto_2.jpg' },
  ]);
});

test('armarEnvio crm: foto de la visita', () => {
  const e = armarEnvio('crm', 'crm_visits', { id: 'v1', date: '2026-11-14T12:00:00', cliente_nombre: 'Ferretería Norte', vendedor_nombre: 'Rosa', reason: 'Seguimiento', result: 'Positivo', photo: 'v1/p.jpg', lat: -33.4, lng: -70.6 }, 2);
  assert.equal(e.identificador, 'Ferretería Norte');
  assert.equal(e.fecha, '2026-11-14');
  assert.deepEqual(e.archivos, [{ bucket: 'crm-visitas', ruta: 'v1/p.jpg', nombre: 'foto_1.jpg' }]);
});
