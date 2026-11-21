import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarSolicitud, traducirRespuestaAppsScript, bytesDeBase64, LIMITE_BYTES } from '../supabase/functions/_shared/correo.ts';

const PDF = Buffer.from('%PDF-1.4\nprueba').toString('base64');
const ctx = { cierreEmail: 'ana@obra.cl', cliente: 'Ingevec', obra: 'Edificio Sur' };
const ok = (extra: object = {}) => ({
  registro_id: 'v1', para: 'Ana@Obra.cl', asunto: 'Visita técnica Edificio Sur – 20-11-2026', cuerpo: 'Estimado(a) Ingevec: visita en la obra Edificio Sur.', nombre: 'Informe visita.pdf', base64: PDF, ...extra,
});

test('validarSolicitud: pedido correcto (el destino coincide con el correo guardado, sin importar mayúsculas)', () => {
  const r = validarSolicitud(ok(), ctx);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.solicitud.registro_id, 'v1');
});

test('validarSolicitud: destino inválido o distinto del guardado en la visita', () => {
  for (const para of ['', 'sin-arroba', 'a@b.cl, c@d.cl', 'a@b.cl\nBcc: x@y.cl']) {
    assert.deepEqual(validarSolicitud(ok({ para }), ctx), { ok: false, error: 'correo_invalido' }, para);
  }
  assert.deepEqual(validarSolicitud(ok({ para: 'otro@obra.cl' }), ctx), { ok: false, error: 'correo_no_coincide' });
  assert.deepEqual(validarSolicitud(ok(), { ...ctx, cierreEmail: null }), { ok: false, error: 'correo_no_coincide' });
  assert.deepEqual(validarSolicitud(null, ctx), { ok: false, error: 'correo_invalido' });
});

test('validarSolicitud: el adjunto debe llamarse .pdf y empezar como un PDF', () => {
  for (const nombre of ['informe.exe', '../informe.pdf', 'a/b.pdf', '']) {
    assert.deepEqual(validarSolicitud(ok({ nombre }), ctx), { ok: false, error: 'archivo_invalido' }, nombre);
  }
  assert.deepEqual(validarSolicitud(ok({ base64: Buffer.from('MZ no es pdf').toString('base64') }), ctx), { ok: false, error: 'archivo_invalido' });
  assert.deepEqual(validarSolicitud(ok({ base64: '' }), ctx), { ok: false, error: 'archivo_invalido' });
});

test('validarSolicitud: tope de 8 MB (justo en el límite pasa; un byte más no)', () => {
  const con = (bytes: number) => Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(bytes - 5, 1)]).toString('base64');
  assert.equal(bytesDeBase64(con(LIMITE_BYTES)), LIMITE_BYTES);
  assert.equal(validarSolicitud(ok({ base64: con(LIMITE_BYTES) }), ctx).ok, true);
  assert.deepEqual(validarSolicitud(ok({ base64: con(LIMITE_BYTES + 1) }), ctx), { ok: false, error: 'demasiado_grande' });
});

test('validarSolicitud: asunto con salto de línea o cuerpo vacío se rechazan', () => {
  assert.deepEqual(validarSolicitud(ok({ asunto: 'a\nBcc: x@y.cl' }), ctx), { ok: false, error: 'solicitud_invalida' });
  assert.deepEqual(validarSolicitud(ok({ cuerpo: '  ' }), ctx), { ok: false, error: 'solicitud_invalida' });
});

test('traducirRespuestaAppsScript: ok, acción desconocida (script sin publicar) y otros errores', () => {
  assert.deepEqual(traducirRespuestaAppsScript({ ok: true }), { ok: true });
  assert.deepEqual(traducirRespuestaAppsScript({ ok: false, error: 'acción desconocida' }), { ok: false, error: 'pendiente_publicar' });
  assert.deepEqual(traducirRespuestaAppsScript({ ok: false, error: 'no autorizado' }), { ok: false, error: 'apps_script', detalle: 'no autorizado' });
  assert.deepEqual(traducirRespuestaAppsScript(null), { ok: false, error: 'apps_script', detalle: 'sin respuesta' });
});

test('validarSolicitud: el mensaje debe corresponder a la visita (cliente y obra en el cuerpo, patrón canónico en el asunto)', () => {
  const MAL = { ok: false, error: 'mensaje_no_corresponde' };
  assert.deepEqual(validarSolicitud(ok({ asunto: 'Promoción imperdible' }), ctx), MAL);
  assert.deepEqual(validarSolicitud(ok({ asunto: 'Visita técnica Otra Obra – 20-11-2026' }), ctx), MAL);
  assert.deepEqual(validarSolicitud(ok({ cuerpo: 'Texto cualquiera sin datos' }), ctx), MAL);
  assert.deepEqual(validarSolicitud(ok({ cuerpo: 'Estimado(a) Ingevec: hola' }), ctx), MAL);   // falta la obra
  assert.deepEqual(validarSolicitud(ok({ cuerpo: 'Visita en Edificio Sur' }), ctx), MAL);        // falta el cliente
  assert.equal(validarSolicitud(ok({ cuerpo: 'Ingevec, Edificio Sur: texto editado por el PM' }), ctx).ok, true);   // editar el texto sí se puede
});

test('validarSolicitud: topes de largo del asunto (200) y del cuerpo (20000)', () => {
  assert.equal(validarSolicitud(ok({ asunto: 'Visita técnica Edificio Sur – ' + 'x'.repeat(200) }), ctx).ok, false);
  assert.equal(validarSolicitud(ok({ cuerpo: 'Ingevec Edificio Sur ' + 'x'.repeat(20000) }), ctx).ok, false);
});
