import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarSolicitud, traducirRespuestaAppsScript, bytesDeBase64, LIMITE_BYTES } from '../supabase/functions/_shared/correo.ts';

const PDF = Buffer.from('%PDF-1.4\nprueba').toString('base64');
const ok = (extra: object = {}) => ({
  registro_id: 'v1', para: 'Ana@Obra.cl', asunto: 'Visita técnica', cuerpo: 'Estimada Ana', nombre: 'Informe visita.pdf', base64: PDF, ...extra,
});

test('validarSolicitud: pedido correcto (el destino coincide con el correo guardado, sin importar mayúsculas)', () => {
  const r = validarSolicitud(ok(), 'ana@obra.cl');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.solicitud.registro_id, 'v1');
});

test('validarSolicitud: destino inválido o distinto del guardado en la visita', () => {
  for (const para of ['', 'sin-arroba', 'a@b.cl, c@d.cl', 'a@b.cl\nBcc: x@y.cl']) {
    assert.deepEqual(validarSolicitud(ok({ para }), 'ana@obra.cl'), { ok: false, error: 'correo_invalido' }, para);
  }
  assert.deepEqual(validarSolicitud(ok({ para: 'otro@obra.cl' }), 'ana@obra.cl'), { ok: false, error: 'correo_no_coincide' });
  assert.deepEqual(validarSolicitud(ok(), null), { ok: false, error: 'correo_no_coincide' });
  assert.deepEqual(validarSolicitud(null, 'ana@obra.cl'), { ok: false, error: 'correo_invalido' });
});

test('validarSolicitud: el adjunto debe llamarse .pdf y empezar como un PDF', () => {
  for (const nombre of ['informe.exe', '../informe.pdf', 'a/b.pdf', '']) {
    assert.deepEqual(validarSolicitud(ok({ nombre }), 'ana@obra.cl'), { ok: false, error: 'archivo_invalido' }, nombre);
  }
  assert.deepEqual(validarSolicitud(ok({ base64: Buffer.from('MZ no es pdf').toString('base64') }), 'ana@obra.cl'), { ok: false, error: 'archivo_invalido' });
  assert.deepEqual(validarSolicitud(ok({ base64: '' }), 'ana@obra.cl'), { ok: false, error: 'archivo_invalido' });
});

test('validarSolicitud: tope de 8 MB (justo en el límite pasa; un byte más no)', () => {
  const con = (bytes: number) => Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(bytes - 5, 1)]).toString('base64');
  assert.equal(bytesDeBase64(con(LIMITE_BYTES)), LIMITE_BYTES);
  assert.equal(validarSolicitud(ok({ base64: con(LIMITE_BYTES) }), 'ana@obra.cl').ok, true);
  assert.deepEqual(validarSolicitud(ok({ base64: con(LIMITE_BYTES + 1) }), 'ana@obra.cl'), { ok: false, error: 'demasiado_grande' });
});

test('validarSolicitud: asunto con salto de línea o cuerpo vacío se rechazan', () => {
  assert.deepEqual(validarSolicitud(ok({ asunto: 'a\nBcc: x@y.cl' }), 'ana@obra.cl'), { ok: false, error: 'solicitud_invalida' });
  assert.deepEqual(validarSolicitud(ok({ cuerpo: '  ' }), 'ana@obra.cl'), { ok: false, error: 'solicitud_invalida' });
});

test('traducirRespuestaAppsScript: ok, acción desconocida (script sin publicar) y otros errores', () => {
  assert.deepEqual(traducirRespuestaAppsScript({ ok: true }), { ok: true });
  assert.deepEqual(traducirRespuestaAppsScript({ ok: false, error: 'acción desconocida' }), { ok: false, error: 'pendiente_publicar' });
  assert.deepEqual(traducirRespuestaAppsScript({ ok: false, error: 'no autorizado' }), { ok: false, error: 'apps_script', detalle: 'no autorizado' });
  assert.deepEqual(traducirRespuestaAppsScript(null), { ok: false, error: 'apps_script', detalle: 'sin respuesta' });
});
