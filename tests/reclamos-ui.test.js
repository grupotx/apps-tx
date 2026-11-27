// Pruebas estáticas sobre reclamos.html (la app no tiene build): comprueban que la pantalla usa la lista de productos,
// el reclamante y los enlaces seguros. El comportamiento en el navegador se verifica a mano con datos simulados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'reclamos.html'), 'utf8');

// Cuerpo de una función de primer nivel (desde "function nombre(" hasta la siguiente función de primer nivel).
function cuerpo(nombre) {
  const re = new RegExp('(?:async )?function ' + nombre + '\\([\\s\\S]*?(?=\\n(?:async )?function |\\n/\\* =====)');
  const m = html.match(re);
  assert.ok(m, 'reclamos.html debe definir function ' + nombre);
  return m[0];
}

test('COLS incluye productos y las 5 columnas del reclamante', () => {
  const m = html.match(/const COLS = '([^']*)'/);
  assert.ok(m, 'falta COLS');
  const cols = m[1].split(',');
  for (const c of ['productos', 'reclamante_tipo', 'reclamante_id', 'reclamante_nombre', 'reclamante_correo', 'reclamante_telefono']) {
    assert.ok(cols.includes(c), 'COLS debe incluir ' + c);
  }
  for (const c of ['producto', 'producto_nombre', 'planta']) assert.ok(cols.includes(c), 'COLS conserva ' + c);
});

test('existen los componentes y la carga de vendedores', () => {
  assert.match(html, /function montarListaProductos\(el, inicial, alCambiar\)/);
  assert.match(html, /function montarReclamante\(el, inicial, alCambiar/);
  assert.match(html, /rpc\('rec_vendedores'\)/);
  assert.doesNotMatch(html, /montarBuscadorProducto/, 'el buscador de un solo producto se reemplazó por la lista');
});

test('los campos del reclamante tienen límites y tipo de teclado', () => {
  const c = cuerpo('montarReclamante');
  assert.match(c, /maxlength="200"/);
  assert.match(c, /maxlength="30"[^>]*inputmode="tel"|inputmode="tel"[^>]*maxlength="30"/);
});

test('rec_crear se llama con p_productos y p_reclamante (sin p_producto)', () => {
  const c = cuerpo('enviarNuevo');
  assert.match(c, /rec_crear/);
  assert.match(c, /p_productos/);
  assert.match(c, /p_reclamante/);
  assert.doesNotMatch(c, /p_producto\b/);
  assert.match(c, /productos:\s*NEW\.productos\.map\(p => p\.code\)/);
  assert.match(c, /\.filter\(Boolean\)|filter\(c => c\)/, 'se filtran los códigos vacíos');
  assert.match(c, /RC\.validarCrear/);
});

test('el estado del ingreso lleva productos y reclamante', () => {
  assert.match(html, /NEW = \{ cliente: null, productos: \[\], conProducto: false, reclamante:/);
});

test('rec_actualizar se llama con p_productos y p_reclamante solo si cambiaron', () => {
  const c = cuerpo('dlgDatos');
  assert.match(c, /rec_actualizar/);
  assert.match(c, /p_productos/);
  assert.match(c, /p_reclamante/);
  assert.doesNotMatch(c, /p_producto\b/);
  assert.match(c, /No hay cambios que guardar\./);
  assert.match(c, /const ini = RC\.productosDe\(r\)[\s\S]*montarListaProductos\(\$\('#dd-prod'\), ini/);
  assert.match(c, /RC\.validarReclamante/);
});

test('dlgDerivar avisa si los productos son de varias plantas y no bloquea', () => {
  const c = cuerpo('dlgDerivar');
  assert.match(c, /RC\.plantasDe\(r\)/);
  assert.ok(c.includes('Los productos de este reclamo son de varias plantas ('), 'falta el aviso');
  assert.ok(c.includes('elige la planta que lo atenderá.'));
  assert.match(c, /r\.planta_destino \|\| RC\.plantasDe\(r\)\[0\] \|\| ''/);
  assert.match(c, /!r\.producto/, 'la comprobación de falta de producto sigue con r.producto');
});

test('dlgComunicar muestra el contacto del reclamante y no cambia el mensaje', () => {
  const c = cuerpo('dlgComunicar');
  assert.match(c, /contactoReclamante\(r\)/);
  assert.match(c, /RC\.mensajeCliente\(r, \{ name: r\.cliente_nombre \}\)/);
});

test('el detalle usa RC.textoProductos y tiene las tarjetas Productos y Reclamante', () => {
  const c = cuerpo('pintarDetalle');
  assert.match(c, /RC\.textoProductos\(r\)/);
  assert.match(c, /bloque\('Productos'/);
  assert.match(c, /bloque\('Reclamante'/);
  assert.match(c, /Sin datos del reclamante/);
  assert.match(c, /Completar datos/);
  assert.match(c, /RC\.productosDe\(r\)/);
});

test('los enlaces mailto: y tel: pasan por funciones que solo dejan caracteres permitidos', () => {
  const tel = new Function(html.match(/const hrefTel = [^\n]*/)[0] + '; return hrefTel;')();
  assert.equal(tel('+56 9 1234-5678'), 'tel:+56912345678');
  assert.equal(tel('javascript:alert(1)'), 'tel:1');
  assert.equal(tel('abc'), '');
  assert.equal(tel(null), '');

  const src = html.match(/const RE_CORREO = [^\n]*/)[0] + '\n' + html.match(/const hrefMail = [^\n]*/)[0] + '; return hrefMail;';
  const mail = new Function(src)();
  assert.equal(mail('  a@b.cl '), 'mailto:a@b.cl');
  assert.equal(mail('no es correo'), '');
  assert.equal(mail('javascript:alert(1)'), '');
  assert.equal(mail('a@b.cl?bcc=x@y.cl'), '', 'dos arrobas: no es un correo');
  assert.equal(mail('a@b.cl?cc=1'), 'mailto:a@b.cl%3Fcc%3D1');
  assert.equal(mail(''), '');

  const det = cuerpo('pintarDetalle');
  assert.match(det, /hrefMail\(/);
  assert.match(det, /hrefTel\(/);
  assert.doesNotMatch(html, /href="mailto:\$\{(?!esc)/);
});

test('la regex de correo es la compartida con reclamos-core', () => {
  const m = html.match(/const RE_CORREO = (\/[^\n;]*\/);/);
  assert.ok(m);
  assert.equal(m[1], '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/');
});
