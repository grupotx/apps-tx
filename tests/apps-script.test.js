const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claveValida, buscarFilaPorNumero, nombresPendientes, copiasABorrar, prefijoCarpeta } = require('../apps-script/lib.js');

test('claveValida: igual, distinta y vacía', () => {
  assert.equal(claveValida('abc123', 'abc123'), true);
  assert.equal(claveValida('abc124', 'abc123'), false);
  assert.equal(claveValida('abc', 'abc123'), false);
  assert.equal(claveValida('', ''), false);
  assert.equal(claveValida(undefined, 'x'), false);
});

test('buscarFilaPorNumero: índice de la fila o -1', () => {
  const v = [['Número', 'Fecha'], ['000001', 'a'], ['000002', 'b']];
  assert.equal(buscarFilaPorNumero(v, 2), 2);
  assert.equal(buscarFilaPorNumero(v, 1), 1);
  assert.equal(buscarFilaPorNumero(v, 3), -1);
  assert.equal(buscarFilaPorNumero([['Número'], [2]], 2), 1);
});

test('nombresPendientes: solo los que no existen en la carpeta', () => {
  assert.deepEqual(nombresPendientes(['foto_1.jpg'], [{ nombre: 'foto_1.jpg' }, { nombre: 'foto_2.jpg' }]), ['foto_2.jpg']);
  assert.deepEqual(nombresPendientes([], []), []);
});

test('copiasABorrar: deja las 30 más recientes', () => {
  const nombres = Array.from({ length: 32 }, (_, i) => `base-2026-10-${String(i + 1).padStart(2, '0')}.json.gz`);
  assert.deepEqual(copiasABorrar([...nombres].reverse(), 30), ['base-2026-10-01.json.gz', 'base-2026-10-02.json.gz']);
  assert.deepEqual(copiasABorrar(nombres.slice(0, 5), 30), []);
});

test('prefijoCarpeta: NNNNNN seguido de separador', () => {
  assert.equal(prefijoCarpeta(7), '000007 · ');
});

// ---- Acción 'correo': se carga lib.js + Codigo.gs en un contexto con fakes de los servicios de Google ----
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLAVE = 'clave-secreta';
const PDF_B64 = Buffer.from('%PDF-1.4\nprueba').toString('base64');

function cargarScript(opc) {
  const enviados = [];
  const ctx = {
    console,
    Buffer,
    MailApp: { sendEmail(o) { if (opc && opc.fallaEnvio) throw new Error(opc.fallaEnvio); enviados.push(o); } },
    Utilities: {
      base64Decode: (b64) => [...Buffer.from(b64, 'base64')].map((x) => (x > 127 ? x - 256 : x)),
      newBlob: (bytes, mime, nombre) => ({ bytes, mime, nombre }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => ({ RESPALDO_CLAVE: CLAVE, ROOT_FOLDER_ID: 'raiz' }[k]) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
    DriveApp: { getFolderById() { throw new Error('el correo no debe tocar Drive'); } },
    LockService: { getScriptLock() { throw new Error('el correo no necesita el candado'); } },
  };
  vm.createContext(ctx);
  for (const f of ['lib.js', 'Codigo.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', f), 'utf8'), ctx, { filename: f });
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).t);
  return { post, enviados };
}

const pedido = (extra) => ({
  clave: CLAVE, accion: 'correo', para: 'cliente@obra.cl', copia: 'pm@grupotx.cl', responderA: 'pm@grupotx.cl',
  asunto: 'Visita técnica Edificio Sur – 20-11-2026', cuerpo: 'Estimado(a) Ingevec:\n\nMotivo: grieta',
  nombre: 'Informe visita técnica - Edificio Sur - 20-11-2026.pdf', base64: PDF_B64, ...extra,
});

test('correo: clave inválida no envía nada', () => {
  const { post, enviados } = cargarScript();
  assert.deepEqual(post(pedido({ clave: 'otra' })), { ok: false, error: 'no autorizado' });
  assert.equal(enviados.length, 0);
});

test('correo: destino inválido no envía (vacío, con coma, con salto de línea, con dos @)', () => {
  const { post, enviados } = cargarScript();
  for (const para of ['', 'sin-arroba', 'a@b.cl, otro@b.cl', 'a@b.cl\nBcc: x@y.cl', 'a@@b.cl', 'a b@c.cl']) {
    const r = post(pedido({ para }));
    assert.equal(r.ok, false, para);
    assert.match(r.error, /destino/, para);
  }
  assert.equal(enviados.length, 0);
});

test('correo: sin copia al PM no se envía (nunca sale un correo sin copia)', () => {
  const { post, enviados } = cargarScript();
  assert.match(post(pedido({ copia: '' })).error, /copia/);
  assert.equal(enviados.length, 0);
});

test('correo: el adjunto debe llamarse .pdf y ser realmente un PDF', () => {
  const { post, enviados } = cargarScript();
  assert.match(post(pedido({ nombre: 'informe.exe' })).error, /pdf/i);
  assert.match(post(pedido({ nombre: '../informe.pdf' })).error, /pdf/i);
  assert.match(post(pedido({ base64: Buffer.from('MZ no es pdf').toString('base64') })).error, /pdf/i);
  assert.match(post(pedido({ base64: '' })).error, /pdf/i);
  assert.equal(enviados.length, 0);
});

test('correo: caso bueno envía un solo correo con asunto, cuerpo, adjunto PDF y copia al PM', () => {
  const { post, enviados } = cargarScript();
  assert.deepEqual(post(pedido()), { ok: true });
  assert.equal(enviados.length, 1);
  const m = enviados[0];
  assert.equal(m.to, 'cliente@obra.cl');
  assert.equal(m.cc, 'pm@grupotx.cl');
  assert.equal(m.replyTo, 'pm@grupotx.cl');
  assert.equal(m.subject, 'Visita técnica Edificio Sur – 20-11-2026');
  assert.equal(m.body, 'Estimado(a) Ingevec:\n\nMotivo: grieta');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].mime, 'application/pdf');
  assert.equal(m.attachments[0].nombre, 'Informe visita técnica - Edificio Sur - 20-11-2026.pdf');
  assert.equal(Buffer.from(m.attachments[0].bytes.map((x) => x & 255)).toString('latin1').slice(0, 5), '%PDF-');
});

test('correo: si MailApp falla (cuota, etc.) responde el error y no lo da por enviado', () => {
  const { post } = cargarScript({ fallaEnvio: 'Límite de correos excedido' });
  assert.deepEqual(post(pedido()), { ok: false, error: 'Límite de correos excedido' });
});
