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

// ── montarReclamante (la función real) sobre un DOM de mentira con solo lo que ella usa ──
// querySelector('#id') solo encuentra un id escrito en el innerHTML del elemento (así se comprueba que la función busca
// los mismos ids que escribe); querySelectorAll da los radios de un name (siempre los mismos objetos) y los inputs.
function falso() {
  let h = '', hijos = new Map(), listas = new Map();
  return {
    isConnected: true,
    get innerHTML() { return h; },
    set innerHTML(v) { h = String(v); hijos = new Map(); listas = new Map(); },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      assert.ok(m, 'selector no previsto: ' + sel);
      if (!h.includes('id="' + m[1] + '"')) return null;
      if (!hijos.has(sel)) hijos.set(sel, falso());
      return hijos.get(sel);
    },
    querySelectorAll(sel) {
      const n = /^input\[name="?([\w-]+)"?\]$/.exec(sel);
      const clave = n ? 'radio:' + n[1] : sel;
      if (!listas.has(clave)) {
        if (n) listas.set(clave, [...h.matchAll(/<input type="radio" name="([^"]*)" value="([^"]*)"/g)].filter((x) => x[1] === n[1]).map((x) => ({ value: x[2], checked: false, onchange: null })));
        else if (sel === 'input') listas.set(clave, [...h.matchAll(/<input/g)].map(() => ({})));
        else assert.fail('selector no previsto: ' + sel);
      }
      return listas.get(clave);
    },
  };
}
const escHtml = new Function(linea('esc') + '; return esc;')();
// Cada carga de vendedores queda pendiente hasta que la prueba la resuelve o la rechaza (cargas[i], en orden de montaje).
function arnesReclamante() {
  const cargas = [], toasts = [];
  const montar = new Function('RC', 'esc', 'noEnter', 'toast', 'me', 'cargarVendedores',
    'let nReclamante = 0;\n' + funcion('montarReclamante') + '; return montarReclamante;')(
    RC, escHtml, () => {}, (m) => toasts.push(m), { id: 'yo' },
    () => new Promise((resolve, reject) => cargas.push({ resolve, reject })));
  return { montar, cargas, toasts };
}
const tick = () => new Promise((r) => setImmediate(r));
const camposDe = (el) => el.querySelector('#' + /<div id="([^"]+)"><\/div>$/.exec(el.innerHTML)[1]);

test('montarReclamante: la lista de vendedores que llega cuando el editor ya salió de la página no cambia el reclamante ni avisa', async () => {
  const { montar, cargas, toasts } = arnesReclamante();
  const yo = { id: 'yo', nombre: 'Yo Mismo', correo: 'yo@tx.cl', telefono: '+56 9 1234 5678' };
  // Ingreso: al llegar la lista se preselecciona al usuario. Si la persona salió de #nuevo y volvió, renderNuevo ya creó
  // otro editor y este quedó fuera de la página: no debe escribir NEW.reclamante (que ahora es el del formulario nuevo).
  const viejo = falso(), cambiosViejo = [];
  montar(viejo, null, (x) => cambiosViejo.push(x), true);
  viejo.isConnected = false;
  cargas[0].resolve([yo]);
  await tick();
  assert.deepEqual(cambiosViejo, [], 'el editor viejo no avisa cambios');
  assert.match(camposDe(viejo).innerHTML, /Cargando vendedores/, 'ni se vuelve a pintar');
  // Si la carga falla con el editor ya fuera de la página (diálogo cerrado), no hay aviso.
  const cerrado = falso();
  montar(cerrado, null, () => {});
  cerrado.isConnected = false;
  cargas[1].reject(new Error('sin red'));
  await tick();
  assert.deepEqual(toasts, [], 'sin aviso de un editor que ya no está');
  // Control: con el editor en la página sí preselecciona al usuario y sí avisa del fallo.
  const vivo = falso(), cambiosVivo = [];
  montar(vivo, null, (x) => cambiosVivo.push(x), true);
  cargas[2].resolve([yo]);
  await tick();
  assert.deepEqual(cambiosVivo, [{ tipo: 'vendedor', id: 'yo', nombre: 'Yo Mismo', correo: 'yo@tx.cl', telefono: '+56 9 1234 5678' }]);
  assert.match(camposDe(vivo).innerHTML, /<select/);
  const abierto = falso();
  montar(abierto, null, () => {});
  cargas[3].reject(new Error('sin red'));
  await tick();
  assert.equal(toasts.length, 1);
  assert.match(camposDe(abierto).innerHTML, /No se pudo cargar la lista de vendedores/);
});

test('montarReclamante: cada editor tiene sus propios ids, etiquetas y grupo de radios (el ingreso oculto no choca con «Completar datos»)', async () => {
  const { montar, cargas } = arnesReclamante();
  const vera = { id: 'v1', nombre: 'Vera Vend', correo: 'vera@tx.cl', telefono: '' };
  const ingreso = falso(), dialogo = falso(), cambios = [];
  montar(ingreso, null, () => {}, true);
  montar(dialogo, null, (x) => cambios.push(x));
  cargas.forEach((c) => c.resolve([vera]));
  await tick();
  const ids = (el) => [...(el.innerHTML + camposDe(el).innerHTML).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const fors = (el) => [...camposDe(el).innerHTML.matchAll(/ for="([^"]+)"/g)].map((m) => m[1]);
  const grupo = (el) => [...new Set([...el.innerHTML.matchAll(/type="radio" name="([^"]+)"/g)].map((m) => m[1]))];
  const etiquetasPropias = (el) => {
    assert.ok(fors(el).length >= 3, 'nombre, correo y teléfono llevan etiqueta');
    for (const f of fors(el)) assert.ok(ids(el).includes(f), 'la etiqueta ' + f + ' apunta a un campo del mismo editor');
  };
  for (const el of [ingreso, dialogo]) { etiquetasPropias(el); assert.equal(grupo(el).length, 1, 'un solo grupo de radios'); }
  assert.deepEqual(ids(ingreso).filter((i) => ids(dialogo).includes(i)), [], 'sin ids repetidos entre editores');
  assert.notEqual(grupo(ingreso)[0], grupo(dialogo)[0], 'cada editor con su propio grupo de radios');

  // El editor funciona igual que antes: elegir vendedor, pasar a Cliente y escribir.
  const c = () => camposDe(dialogo);
  c().querySelector('#' + / id="([^"]+)"/.exec(c().innerHTML.match(/<select[^>]*>/)[0])[1]).onchange({ target: { value: 'v1' } });
  assert.deepEqual(cambios.at(-1), { tipo: 'vendedor', id: 'v1', nombre: 'Vera Vend', correo: 'vera@tx.cl', telefono: '' });
  assert.match(c().innerHTML, /readonly[^>]*value="Vera Vend"/);
  const radio = dialogo.querySelectorAll('input[name="' + grupo(dialogo)[0] + '"]').find((r) => r.value === 'cliente');
  radio.checked = true; radio.onchange();
  assert.deepEqual(cambios.at(-1), { tipo: 'cliente', id: '', nombre: '', correo: '', telefono: '' });
  assert.match(c().innerHTML, /Nombre de quien reclama/);
  etiquetasPropias(dialogo);
  const idNombre = /<label for="([^"]+)">Nombre de quien reclama<\/label>/.exec(c().innerHTML)[1];
  c().querySelector('#' + idNombre).oninput({ target: { value: 'Luis' } });
  assert.equal(cambios.at(-1).nombre, 'Luis');
  assert.match(html, /^let nReclamante = 0;/m, 'el contador de editores está declarado en la página');
});

// ── Bandeja, panel y CSV: funciones puras extraídas y ejecutadas ──
const nuevoR = { id: 'n', folio: 'R-2', cliente_nombre: 'Cli Dos', motivo: 'calidad', estado: 'comunicado', fecha_recepcion: '2026-11-01', comunicado_en: '2026-11-05T15:00:00Z', compensacion: 1001, area_destino: 'planta', planta_destino: 'osorno', planta: null, producto: 'P1', producto_nombre: 'Alfa',
  productos: [{ code: 'P1', nombre: 'Alfa', planta: 'osorno' }, { code: 'P2', nombre: 'Beta', planta: 'osorno' }],
  reclamante_tipo: 'cliente', reclamante_id: null, reclamante_nombre: '=HYPERLINK("x")', reclamante_correo: 'a@b.cl', reclamante_telefono: '+56 9 1234 5678' };
const viejoR = { id: 'v', folio: 'R-1', cliente_nombre: 'Cli Uno', motivo: 'otro', estado: 'ingresado', fecha_recepcion: '2026-10-01', producto: 'P3', producto_nombre: 'Gamma', planta: 'osorno', productos: null, reclamante_tipo: null };
const sinProd = { id: 's', folio: 'R-3', motivo: 'otro', estado: 'ingresado', fecha_recepcion: '2026-10-02' };

test('textoBusqueda: incluye todos los productos (nombres y códigos) y el reclamante, y no falla con reclamos antiguos', () => {
  const f = new Function('RC', 'labelMotivo', funcion('textoBusqueda') + '; return textoBusqueda;')(RC, id => id || '');
  assert.match(f(nuevoR), /beta/, 'el segundo producto se busca');
  assert.ok(f(nuevoR).includes('p2'), 'el código del segundo producto se busca');
  const tres = Object.assign({}, nuevoR, { productos: [...nuevoR.productos, { code: 'ZX-300', nombre: 'Delta', planta: 'osorno' }] });
  assert.ok(f(tres).includes('zx-300') && f(tres).includes('delta'), 'el código y el nombre de cualquier posición se buscan');
  assert.ok(f(tres).includes('p1') && f(tres).includes('alfa'), 'el primero se sigue buscando');
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

test('bajo «Por producto» el panel explica que el costo de un reclamo con varios productos se reparte entre ellos', () => {
  const lineas = cuerpo('pintarPanel').split(/\r?\n/);
  const i = lineas.findIndex((l) => l.includes("tabla('Por producto'"));
  assert.ok(i >= 0, 'falta la tabla Por producto');
  const nota = lineas[i + 1];
  assert.match(nota, /^\s*<p class="small">[^<]*<\/p>\s*$/, 'una línea de nota justo debajo de la tabla');
  assert.match(nota, /varios productos/);
  assert.match(nota, /se reparte entre ellos/);
  assert.match(nota, /«Costo de compensaciones»/);
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
