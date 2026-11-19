import { test } from 'node:test';
import assert from 'node:assert/strict';
import { puedeVer } from '../supabase/functions/_shared/permiso.ts';

function deps(o: { archivo?: any; visible?: boolean } = {}) {
  const llamadas: Array<[string, string]> = [];
  return {
    llamadas,
    d: {
      archivo: async () => (o.archivo === undefined ? { tabla: 'registros', registro_id: 'r1', drive_file_id: 'D1' } : o.archivo),
      leerComoUsuario: async (tabla: string, id: string) => { llamadas.push([tabla, id]); return o.visible ?? true; },
    },
  };
}

test('puedeVer: archivo desconocido → 404', async () => {
  const { d } = deps({ archivo: null });
  assert.deepEqual(await puedeVer(d, 'registro-terreno', 'x/a.jpg'), { ok: false, status: 404 });
});

test('puedeVer: archivo sin drive_file_id → 404', async () => {
  const { d } = deps({ archivo: { tabla: 'registros', registro_id: 'r1', drive_file_id: null } });
  assert.deepEqual(await puedeVer(d, 'registro-terreno', 'x/a.jpg'), { ok: false, status: 404 });
});

test('puedeVer: registro no visible para el usuario → 403, consultando la tabla e id correctos', async () => {
  const { d, llamadas } = deps({ visible: false });
  assert.deepEqual(await puedeVer(d, 'registro-terreno', 'x/a.jpg'), { ok: false, status: 403 });
  assert.deepEqual(llamadas, [['registros', 'r1']]);
});

test('puedeVer: Mantención consulta mtto_docs con coleccion:id', async () => {
  const { d, llamadas } = deps({ archivo: { tabla: 'mtto_docs', registro_id: 'chk:k9', drive_file_id: 'D2' } });
  assert.deepEqual(await puedeVer(d, 'mantencion', 'k9/0-1.jpg'), { ok: true, fileId: 'D2' });
  assert.deepEqual(llamadas, [['mtto_docs', 'chk:k9']]);
});

test('puedeVer: visible → ok con fileId', async () => {
  const { d } = deps();
  assert.deepEqual(await puedeVer(d, 'registro-terreno', 'x/a.jpg'), { ok: true, fileId: 'D1' });
});

test('puedeVer: bucket o ruta vacíos → 404 sin consultar', async () => {
  const { d, llamadas } = deps();
  assert.deepEqual(await puedeVer(d, '', 'x'), { ok: false, status: 404 });
  assert.deepEqual(await puedeVer(d, 'fotos', ''), { ok: false, status: 404 });
  assert.equal(llamadas.length, 0);
});
