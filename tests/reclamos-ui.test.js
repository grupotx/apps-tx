// Pruebas estáticas sobre reclamos.html (la app no tiene build): comprueban que la pantalla usa la lista de productos,
// el reclamante y los enlaces seguros. El comportamiento en el navegador se verifica a mano con datos simulados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const RC = require('../reclamos-core.js');
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
  const mail = new Function('RC', src)(RC);
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

test('la página usa la regex de correo de reclamos-core (sin copia propia)', () => {
  assert.match(html, /const RE_CORREO = RC\.RE_CORREO;/);
  assert.ok(RC.RE_CORREO instanceof RegExp);
  assert.equal(RC.RE_CORREO.test('a@b.cl'), true);
  assert.equal(RC.RE_CORREO.test('a@b'), false);
  assert.equal(RC.RE_CORREO.test('a b@c.cl'), false);
});

// ── Funciones puras de reclamos.html, extraídas del texto y ejecutadas ──
const linea = (nombre) => { const m = html.match(new RegExp('const ' + nombre + ' = [^\\n]*')); assert.ok(m, 'falta const ' + nombre); return m[0]; };
const funcion = (nombre) => { const m = html.match(new RegExp('function ' + nombre + '\\([\\s\\S]*?\\r?\\n\\}(?=\\r?\\n)')); assert.ok(m, 'falta function ' + nombre); return m[0]; };

test('reclamanteCambio: reclamo antiguo sin reclamante', () => {
  const f = new Function(funcion('reclamanteCambio') + '; return reclamanteCambio;')();
  const viejo = { reclamante_tipo: null };
  assert.equal(f({ tipo: 'vendedor', id: '', nombre: '', correo: '', telefono: '' }, viejo), false, 'el valor por defecto vacío no es un cambio');
  assert.equal(f({ tipo: 'vendedor', id: 'v1', nombre: 'A', correo: 'a@b.cl', telefono: '' }, viejo), true);
  assert.equal(f({ tipo: 'vendedor', id: '', nombre: '', correo: '', telefono: '555' }, viejo), true, 'teléfono suelto: se envía y la validación pide elegir vendedor');
  assert.equal(f({ tipo: 'cliente', id: '', nombre: '  ', correo: '', telefono: '' }, viejo), false);
  assert.equal(f({ tipo: 'cliente', id: '', nombre: 'Juan', correo: '', telefono: '' }, viejo), true);
});

test('reclamanteCambio: vendedor se compara por id y teléfono; cliente por sus tres campos, recortados', () => {
  const f = new Function(funcion('reclamanteCambio') + '; return reclamanteCambio;')();
  const v = { reclamante_tipo: 'vendedor', reclamante_id: 'v1', reclamante_nombre: 'Viejo nombre', reclamante_correo: 'viejo@x.cl', reclamante_telefono: '111' };
  assert.equal(f({ tipo: 'vendedor', id: 'v1', nombre: 'Otro nombre', correo: 'otro@x.cl', telefono: '111' }, v), false, 'nombre y correo salen del perfil: no cuentan');
  assert.equal(f({ tipo: 'vendedor', id: 'v1', nombre: '', correo: '', telefono: ' 111 ' }, v), false, 'el teléfono se recorta');
  assert.equal(f({ tipo: 'vendedor', id: 'v1', nombre: '', correo: '', telefono: '222' }, v), true, 'solo cambió el teléfono');
  assert.equal(f({ tipo: 'vendedor', id: 'v2', nombre: '', correo: '', telefono: '111' }, v), true, 'otro vendedor');
  assert.equal(f({ tipo: 'cliente', id: '', nombre: 'Juan', correo: 'j@x.cl', telefono: '111' }, v), true, 'cambió el tipo');
  const c = { reclamante_tipo: 'cliente', reclamante_id: null, reclamante_nombre: 'Juan', reclamante_correo: 'j@x.cl', reclamante_telefono: '123' };
  assert.equal(f({ tipo: 'cliente', id: '', nombre: ' Juan ', correo: ' j@x.cl', telefono: '123 ' }, c), false, 'valores idénticos con espacios');
  assert.equal(f({ tipo: 'cliente', id: '', nombre: 'Juana', correo: 'j@x.cl', telefono: '123' }, c), true);
  assert.equal(f({ tipo: 'cliente', id: '', nombre: 'Juan', correo: 'k@x.cl', telefono: '123' }, c), true);
  assert.equal(f({ tipo: 'cliente', id: '', nombre: 'Juan', correo: 'j@x.cl', telefono: '' }, c), true, 'se borró el teléfono');
});

test('productosCambiaron: igual, quitar, agregar y reordenar', () => {
  const f = new Function(linea('productosCambiaron') + '; return productosCambiaron;')();
  const antes = [{ code: 'A' }, { code: 'B' }];
  assert.equal(f(antes, ['A', 'B']), false);
  assert.equal(f(antes, ['A']), true, 'quitar');
  assert.equal(f(antes, ['A', 'B', 'C']), true, 'agregar');
  assert.equal(f(antes, ['B', 'A']), true, 'reordenar');
  assert.equal(f([], []), false, 'reclamo sin productos y sin cambios');
  assert.equal(f([], ['A']), true);
  assert.equal(f(antes, []), true, 'vaciar (el diálogo lo rechaza aparte)');
});

test('armarReclamante: id solo para el vendedor y campos recortados', () => {
  const f = new Function(linea('armarReclamante') + '; return armarReclamante;')();
  assert.deepEqual(f({ tipo: 'cliente', id: 'x', nombre: ' Juan ', correo: ' j@x.cl ', telefono: ' 123 ' }), { tipo: 'cliente', id: null, nombre: 'Juan', correo: 'j@x.cl', telefono: '123' });
  assert.deepEqual(f({ tipo: 'vendedor', id: 'v1', nombre: 'A', correo: 'a@b.cl', telefono: null }), { tipo: 'vendedor', id: 'v1', nombre: 'A', correo: 'a@b.cl', telefono: '' });
  assert.equal(f({ tipo: 'vendedor', id: '', nombre: '', correo: '', telefono: '' }).id, null);
});

test('contactoReclamante: une solo lo que existe', () => {
  const f = new Function(linea('contactoReclamante') + '; return contactoReclamante;')();
  assert.equal(f({ reclamante_nombre: 'Ana', reclamante_correo: 'a@b.cl', reclamante_telefono: '123' }), 'Ana · a@b.cl · 123');
  assert.equal(f({ reclamante_nombre: 'Ana', reclamante_correo: null, reclamante_telefono: '123' }), 'Ana · 123');
  assert.equal(f({}), '');
});

// ── Bandeja, panel y CSV: funciones puras extraídas y ejecutadas ──
const nuevoR = { id: 'n', folio: 'R-2', cliente_nombre: 'Cli Dos', motivo: 'calidad', estado: 'comunicado', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-05T15:00:00Z', compensacion: 1001, area_destino: 'planta', planta_destino: 'osorno', planta: null, producto: 'P1', producto_nombre: 'Alfa',
  productos: [{ code: 'P1', nombre: 'Alfa', planta: 'osorno' }, { code: 'P2', nombre: 'Beta', planta: 'osorno' }],
  reclamante_tipo: 'cliente', reclamante_id: null, reclamante_nombre: '=HYPERLINK("x")', reclamante_correo: 'a@b.cl', reclamante_telefono: '+56 9 1234 5678' };
const viejoR = { id: 'v', folio: 'R-1', cliente_nombre: 'Cli Uno', motivo: 'otro', estado: 'ingresado', fecha_recepcion: '2026-10-01', producto: 'P3', producto_nombre: 'Gamma', planta: 'osorno', productos: null, reclamante_tipo: null };
const sinProd = { id: 's', folio: 'R-3', motivo: 'otro', estado: 'ingresado', fecha_recepcion: '2026-10-02' };

test('textoBusqueda: incluye todos los productos y el reclamante, y no falla con reclamos antiguos', () => {
  const f = new Function('RC', 'labelMotivo', funcion('textoBusqueda') + '; return textoBusqueda;')(RC, id => id || '');
  assert.match(f(nuevoR), /beta/, 'el segundo producto se busca');
  assert.match(f(nuevoR), /hyperlink/, 'el nombre del reclamante se busca');
  assert.match(f(viejoR), /gamma/, 'reclamo antiguo: producto de las columnas antiguas');
  assert.equal(typeof f(sinProd), 'string');
  assert.match(f(sinProd), /r-3/);
});

test('productosPanel: código a nombre desde todos los productos de todos los reclamos, ordenado por nombre', () => {
  const f = new Function('RC', funcion('productosPanel') + '; return productosPanel;')(RC);
  const otro = { productos: [{ code: 'P9', nombre: 'Zeta', planta: 'osorno' }, { code: 'P0', nombre: 'Ámbar', planta: 'osorno' }] };
  const l = f([nuevoR, viejoR, sinProd, otro]);
  assert.deepEqual(l.map(p => p[0]), ['P1', 'P0', 'P2', 'P3', 'P9']);
  assert.deepEqual(l.map(p => p[1]), ['Alfa', 'Ámbar', 'Beta', 'Gamma', 'Zeta']);
  assert.equal(l.find(p => p[0] === 'P2')[1], 'Beta', 'un código que no es el primero del reclamo se resuelve a su nombre');
});

test('filtrarPanel filtra por pertenencia a la lista de productos', () => {
  const c = cuerpo('filtrarPanel');
  assert.match(c, /RC\.productosDe\(r\)\.some\(p => p\.code === f\.producto\)/);
  const f = new Function('RC', 'PAN', 'RECS', funcion('filtrarPanel') + '; return filtrarPanel;');
  const run = (prod) => f(RC, { f: { producto: prod } }, [nuevoR, viejoR, sinProd])().map(r => r.id);
  assert.deepEqual(run('P2'), ['n'], 'segundo producto');
  assert.deepEqual(run('P3'), ['v'], 'reclamo antiguo por su producto antiguo');
  assert.deepEqual(run(''), ['n', 'v', 's']);
});

test('pintarPanel resuelve nombres con productosPanel (no con producto_nombre)', () => {
  const c = cuerpo('pintarPanel');
  assert.match(c, /productosPanel\(RECS\)/);
  assert.doesNotMatch(c, /r\.producto_nombre/);
});

test('la tarjeta de la bandeja muestra el resumen de productos', () => {
  const c = cuerpo('filaRec');
  assert.match(c, /RC\.resumenProductos\(r\)/);
  assert.doesNotMatch(c, /producto_nombre/);
});

test('textoCsv: 11 columnas actuales en orden y 4 del reclamante al final', () => {
  const f = new Function('RC', 'labelMotivo', funcion('textoCsv') + '; return textoCsv;')(RC, id => id || '');
  const txt = f([nuevoR, viejoR]);
  assert.equal(txt.charCodeAt(0), 0xFEFF, 'BOM');
  const lineas = txt.slice(1).split('\r\n');
  assert.equal(lineas.length, 3, 'cabecera y 2 filas, separadas por CRLF');
  const cab = lineas[0].split(';').map(s => s.replace(/^"|"$/g, ''));
  assert.deepEqual(cab, ['Folio', 'Cliente', 'Producto', 'Planta', 'Motivo', 'Área', 'Estado', 'Recepción', 'Comunicado', 'Días de respuesta', 'Compensación', 'Reclamante (tipo)', 'Reclamante (nombre)', 'Reclamante (correo)', 'Reclamante (teléfono)']);
});

test('textoCsv: producto con todos, reclamante, neutralización y reclamo antiguo', () => {
  const f = new Function('RC', 'labelMotivo', funcion('textoCsv') + '; return textoCsv;')(RC, id => id || '');
  const [, n, v] = f([nuevoR, viejoR]).slice(1).split('\r\n').map(l => l.split(';'));
  assert.equal(n[2], '"Alfa / Beta"', 'Producto con todos separados por " / "');
  assert.equal(n[10], '"1001"');
  assert.equal(n[11], '"Cliente"');
  assert.equal(n[12], '"\'=HYPERLINK(""x"")"', 'nombre que empieza con = se neutraliza y se escapan comillas');
  assert.equal(n[13], '"a@b.cl"');
  assert.equal(n[14], '"\'+56 9 1234 5678"', 'teléfono con + inicial se neutraliza');
  assert.equal(v[2], '"Gamma"', 'reclamo antiguo: producto de las columnas antiguas');
  assert.deepEqual(v.slice(11), ['""', '""', '""', '""'], 'reclamo antiguo: reclamante vacío');
});

test('exportarCsv descarga el texto de textoCsv', () => {
  assert.match(cuerpo('exportarCsv'), /textoCsv\(rs\)/);
});
