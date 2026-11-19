import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seleccionarParaBorrar, nombreCopia, type ArchivoRetencion } from '../supabase/functions/_shared/noche.ts';

const ahora = new Date('2026-11-19T06:00:00Z');
const hace = (d: number) => new Date(ahora.getTime() - d * 86400000).toISOString();
const a = (x: Partial<ArchivoRetencion>): ArchivoRetencion => ({
  id: 1, bucket: 'registro-terreno', drive_file_id: 'D1', creado_storage: hace(61), borrado_supabase_at: null, ...x,
});

test('seleccionarParaBorrar: 61 días y confirmado en Drive → se borra', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ id: 7 })], ahora), [7]);
});

test('seleccionarParaBorrar: sin drive_file_id no se borra', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ drive_file_id: null })], ahora), []);
});

test('seleccionarParaBorrar: 59 días no se borra', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ creado_storage: hace(59) })], ahora), []);
});

test('seleccionarParaBorrar: ya borrado no se vuelve a borrar', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ borrado_supabase_at: hace(1) })], ahora), []);
});

test('seleccionarParaBorrar: base64 de Mantención antigua (mtto_docs) nunca se toca', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ bucket: 'mtto_docs' })], ahora), []);
});

test('seleccionarParaBorrar: sin fecha de storage (archivo ya no existe) no se borra', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ creado_storage: null })], ahora), []);
});

test('seleccionarParaBorrar: respeta días configurables', () => {
  assert.deepEqual(seleccionarParaBorrar([a({ id: 3, creado_storage: hace(11) })], ahora, 10), [3]);
});

test('nombreCopia: base-AAAA-MM-DD.json.gz en hora de Chile', () => {
  assert.equal(nombreCopia(new Date('2026-11-19T06:00:00Z')), 'base-2026-11-19.json.gz');
  assert.equal(nombreCopia(new Date('2026-11-20T02:00:00Z')), 'base-2026-11-19.json.gz');
});
