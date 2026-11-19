import { test } from 'node:test';
import assert from 'node:assert/strict';
import { procesarLote, descargaNoExiste, type Cola, type RespuestaScript } from '../supabase/functions/_shared/proceso.ts';
import { nombreArchivo } from '../supabase/functions/_shared/envios.ts';

const ahora = '2026-11-19T12:00:00Z';
// Las filas llegan ya "reclamadas" por respaldo_pendientes: intentos ya incluye este intento.
const cola = (x: Partial<Cola> = {}): Cola => ({
  id: 1, app: 'terreno', tabla: 'registros', registro_id: 'r1', estado: 'pendiente', intentos: 1,
  ultimo_error: null, numero: null, drive_folder_id: null, drive_url: null, enviado_at: null,
  listo_desde: '2026-11-19T11:55:00Z', ...x,
});
const registro = { id: 'r1', kind: 'visita', cliente: 'ACME', fecha: '2026-11-18', fotos: ['u/a.jpg', 'u/b.jpg'] };
const nA = nombreArchivo('registro-terreno', 'u/a.jpg', 'foto', 'jpg');
const nB = nombreArchivo('registro-terreno', 'u/b.jpg', 'foto', 'jpg');

function falsas(o: { filas?: Cola[]; datos?: any; respuesta?: RespuestaScript; descargar?: (ruta: string) => string | null } = {}) {
  const log = { enviados: [] as any[], marcas: [] as Array<[Cola, Partial<Cola>]>, registrados: [] as any[], numeros: 0 };
  const deps = {
    pendientes: async () => o.filas ?? [cola()],
    cargar: async () => (o.datos === undefined ? registro : o.datos),
    numero: async () => { log.numeros++; return 7; },
    descargar: async (a: any) => (o.descargar ? o.descargar(a.ruta) : 'QkFTRTY0'),
    enviar: async (b: any) => {
      log.enviados.push(b);
      return o.respuesta ?? { ok: true, folderId: 'F1', folderUrl: 'https://drive/F1',
        archivos: (b.envio?.archivos || []).map((a: any) => ({ nombre: a.nombre, fileId: 'D-' + a.nombre })) };
    },
    marcar: async (c: Cola, cambios: Partial<Cola>) => { log.marcas.push([c, cambios]); },
    registrarArchivos: async (id: number, a: any[]) => { log.registrados.push([id, a]); },
    ahora: () => ahora,
  };
  return { deps, log };
}

test('envío normal: marca enviado con carpeta y registra cada archivo con SU fileId', async () => {
  const { deps, log } = falsas();
  assert.deepEqual(await procesarLote(deps), { ok: 1, error: 0 });
  assert.equal(log.enviados[0].accion, 'envio');
  assert.equal(log.enviados[0].envio.numero, 7);
  assert.equal(log.enviados[0].envio.archivos.length, 2);
  const [c, m] = log.marcas[0];
  assert.equal(c.id, 1);
  assert.equal(m.estado, 'enviado');
  assert.equal(m.drive_folder_id, 'F1');
  assert.equal(m.drive_url, 'https://drive/F1');
  assert.equal(m.numero, 7);
  assert.equal(m.enviado_at, ahora);
  assert.deepEqual(log.registrados[0][1].map((a: any) => [a.bucket, a.ruta, a.nombre_drive, a.drive_file_id]), [
    ['registro-terreno', 'u/a.jpg', nA, 'D-' + nA],
    ['registro-terreno', 'u/b.jpg', nB, 'D-' + nB],
  ]);
});

test('marcar recibe la fila leída (con estado y listo_desde) para actualizar solo si nadie la cambió', async () => {
  const fila = cola({ listo_desde: '2026-11-19T11:50:00.123456+00:00' });
  const { deps, log } = falsas({ filas: [fila] });
  await procesarLote(deps);
  assert.equal(log.marcas[0][0].listo_desde, '2026-11-19T11:50:00.123456+00:00');
  assert.equal(log.marcas[0][0].estado, 'pendiente');
});

test('error del script: estado error y último error (los intentos ya se contaron al reclamar la fila)', async () => {
  const { deps, log } = falsas({ respuesta: { ok: false, error: 'cuota' } });
  assert.deepEqual(await procesarLote(deps), { ok: 0, error: 1 });
  assert.deepEqual(log.marcas[0][1], { estado: 'error', ultimo_error: 'cuota' });
  assert.equal(log.registrados.length, 0);
});

test('foto que ya no existe (descargar → null): se omite y la fila dice "falta <nombre>"', async () => {
  const { deps, log } = falsas({ descargar: (r) => (r === 'u/b.jpg' ? null : 'QkFTRTY0') });
  await procesarLote(deps);
  const env = log.enviados[0].envio;
  assert.deepEqual(env.archivos.map((a: any) => a.nombre), [nA]);
  assert.match(env.fila['Observaciones'], new RegExp(`falta ${nB.replace('.', '\\.')}`));
});

test('falla temporal al descargar (lanza error): el envío queda en error para reintentar, no "falta"', async () => {
  const { deps, log } = falsas();
  deps.descargar = async () => { throw new Error('storage 503'); };
  assert.deepEqual(await procesarLote(deps), { ok: 0, error: 1 });
  assert.equal(log.enviados.length, 0);
  assert.deepEqual(log.marcas[0][1], { estado: 'error', ultimo_error: 'storage 503' });
});

test('mismo envío procesado dos veces: pide el número y reenvía el mismo', async () => {
  const { deps, log } = falsas();
  await procesarLote(deps);
  await procesarLote(deps);
  assert.equal(log.numeros, 2);
  assert.equal(log.enviados[0].envio.numero, log.enviados[1].envio.numero);
  assert.equal(log.enviados[0].envio.carpeta, log.enviados[1].envio.carpeta);
});

test('eliminado con número: acción eliminado; sin número: solo marca enviado_at', async () => {
  const a = falsas({ filas: [cola({ estado: 'eliminado', numero: 12 })] });
  await procesarLote(a.deps);
  assert.deepEqual(a.log.enviados[0], { accion: 'eliminado', app: 'terreno', numero: 12 });
  assert.deepEqual(a.log.marcas[0][1], { enviado_at: ahora, intentos: 0, ultimo_error: null });

  const b = falsas({ filas: [cola({ estado: 'eliminado', numero: null })] });
  await procesarLote(b.deps);
  assert.equal(b.log.enviados.length, 0);
  assert.deepEqual(b.log.marcas[0][1], { enviado_at: ahora, intentos: 0, ultimo_error: null });
});

test('eliminado que falla sigue como eliminado (no se confunde con envío)', async () => {
  const { deps, log } = falsas({ filas: [cola({ estado: 'eliminado', numero: 3, intentos: 3 })], respuesta: { ok: false, error: 'x' } });
  await procesarLote(deps);
  assert.deepEqual(log.marcas[0][1], { estado: 'eliminado', ultimo_error: 'x' });
});

test('registro que ya no existe: error "registro no encontrado"', async () => {
  const { deps, log } = falsas({ datos: null });
  await procesarLote(deps);
  assert.deepEqual(log.marcas[0][1], { estado: 'error', ultimo_error: 'registro no encontrado' });
  assert.equal(log.enviados.length, 0);
});

test('Mantención antigua en base64: se registra como mtto_docs/<registro_id>/<nombre>', async () => {
  const { deps, log } = falsas({
    filas: [cola({ app: 'mantencion', tabla: 'mtto_docs', registro_id: 'chk:9' })],
    datos: { id: '9', coleccion: 'chk', data: { eq: 'Grúa', fecha: '2026-11-18', items: [{ item: 'Frenos', r: 'ok', foto: 'data:image/jpeg;base64,QUJD' }] } },
  });
  await procesarLote(deps);
  assert.deepEqual(log.registrados[0][1].map((a: any) => [a.bucket, a.ruta]), [['mtto_docs', 'chk:9/foto_item1.jpg']]);
});

test('límite: pide como máximo "limite" pendientes', async () => {
  let pedido = 0;
  const { deps } = falsas();
  deps.pendientes = async (n: number) => { pedido = n; return []; };
  await procesarLote(deps, 3);
  assert.equal(pedido, 3);
});

test('descargaNoExiste: 400/404 o "not found" = falta; 5xx y otros = error temporal', () => {
  assert.equal(descargaNoExiste({ message: '{}', originalError: { status: 400 } }), true);
  assert.equal(descargaNoExiste({ statusCode: '404', message: 'x' }), true);
  assert.equal(descargaNoExiste({ message: 'Object not found' }), true);
  assert.equal(descargaNoExiste({ message: '{}', originalError: { status: 503 } }), false);
  assert.equal(descargaNoExiste({ message: 'fetch failed' }), false);
});
