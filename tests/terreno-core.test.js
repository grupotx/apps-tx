const { test } = require('node:test');
const assert = require('node:assert/strict');
const TC = require('../terreno-core.js');

test('mpa: 2,772 kN sobre 50x50 mm son 1,11 MPa', () => {
  assert.equal(TC.mpa(2.772, 50, 50), 1.11);
  assert.equal(TC.mpa(0, 50, 50), null);
  assert.equal(TC.mpa(2.772, 0, 50), null);
});

test('resumenEnsayo: mínimo, máximo, promedio y filas bajo 0,20 MPa', () => {
  const r = TC.resumenEnsayo([
    { n: 1, cargaKn: 2.772, anchoMm: 50, altoMm: 50, falla: 'Cohesión Nivelador' },
    { n: 2, cargaKn: 0.4,   anchoMm: 50, altoMm: 50, falla: 'Cohesión Sustrato' },
  ]);
  assert.deepEqual(r.bajoUmbral, [2]);
  assert.equal(r.max, 1.11);
  assert.equal(r.min, 0.16);
});

test('resumenEnsayo: respeta el MPa escrito a mano', () => {
  const r = TC.resumenEnsayo([{ n: 1, cargaKn: 2.772, anchoMm: 50, altoMm: 50, mpa: 1.12, falla: 'Cohesión Nivelador' }]);
  assert.equal(r.max, 1.12);
});

test('resumenEnsayo: promedio, y lista vacía deja todo en null', () => {
  const r = TC.resumenEnsayo([{ n: 1, mpa: 1 }, { n: 2, mpa: 0.5 }]);
  assert.equal(r.prom, 0.75);
  assert.deepEqual(TC.resumenEnsayo([]), { min: null, max: null, prom: null, bajoUmbral: [] });
});

test('conclusionBase: nombra los tipos de falla sin repetir y no dictamina', () => {
  const t = TC.conclusionBase([{ falla: 'Cohesión Nivelador' }, { falla: 'Cohesión Nivelador' }, { falla: 'Cohesión Sustrato' }]);
  assert.match(t, /NCh 2471/);
  assert.match(t, /0,20 MPa/);
  assert.match(t, /Cohesión Nivelador, Cohesión Sustrato\.$/);
  assert.doesNotMatch(t, /cumple/i);
});

test('conclusionBase: sin filas queda el texto base sin la frase de fallas', () => {
  assert.equal(TC.conclusionBase([]), TC.CONCLUSION_BASE);
  assert.doesNotMatch(TC.CONCLUSION_BASE, /fallas identificadas/);
});

test('textos fijos: no se pierden ni se alteran', () => {
  assert.match(TC.NOTA_LEGAL, /^Nota: Grupo TX respalda/);
  assert.match(TC.NOTA_LEGAL, /www\.grupotx\.cl$/);
  assert.match(TC.DESARROLLO_DEFECTO, /cortes de 50\*50 mm/);
  assert.equal(TC.DOC_META.codigo, 'DOC-PM-LAB-05');
  assert.equal(TC.PIE.length, 3);
});

test('correoVisita: asunto con obra y fecha dd-mm-aaaa, cuerpo en texto plano', () => {
  const c = TC.correoVisita({ kind: 'visita', fecha: '2026-11-20', cliente: 'Ingevec', obra: 'Edificio Sur', datos: { producto: 'TX-100', motivo: 'Revisión', verificacion: 'Se midió', causa: 'Humedad', solucion: 'Secar', lab: 'Sí', contacto: 'Ana' } });
  assert.equal(c.asunto, 'Visita técnica Edificio Sur – 20-11-2026');
  assert.match(c.cuerpo, /Ingevec/);
  assert.doesNotMatch(c.cuerpo, /<[a-z]/i);
  assert.doesNotMatch(c.cuerpo, /cumpl/i);
});

test('correoEnsayo: asunto con obra y fecha dd-mm-aaaa', () => {
  const c = TC.correoEnsayo({ kind: 'ensayo', fecha: '2026-01-05', cliente: 'Ingevec', obra: 'Torre Norte', datos: { filas: [], motivo_visita: 'Control' } });
  assert.equal(c.asunto, 'Informe prueba de adherencia Torre Norte – 05-01-2026');
  assert.doesNotMatch(c.cuerpo, /cumpl/i);
});

test('participantesVista: registro viejo con firma booleana', () => {
  const v = TC.participantesVista([], [{ nombre: 'Juan', rut: '1-9', firma: true }]);
  assert.equal(v[0].firma, '');
  assert.equal(v[0].firmo, true);
});

test('participantesVista: si hay filas de asistencia, mandan sobre los datos viejos', () => {
  const v = TC.participantesVista([{ id: 'x', nombre: 'Ana', firma: 'data:image/png;base64,AA' }], [{ nombre: 'Juan' }]);
  assert.equal(v.length, 1);
  assert.equal(v[0].nombre, 'Ana');
  assert.equal(v[0].firmo, true);
});

test('mezclarParticipantes: no pisa la fila que el PM está editando', () => {
  const act = [{ id: 'a', nombre: 'Juan', _sucia: true }];
  const r = TC.mezclarParticipantes(act, [{ id: 'a', nombre: 'Juan Pérez' }, { id: 'b', nombre: 'Ana' }]);
  assert.equal(r[0].nombre, 'Juan');
  assert.equal(r[1].id, 'b');
});

test('validarAsistencia: nombre obligatorio, correo opcional, cupo y duplicado', () => {
  const est = { total: 0, rutsUsados: [], nombresUsados: [] };
  assert.deepEqual(TC.validarAsistencia({ nombre: 'Ana' }, est), { ok: true });
  assert.equal(TC.validarAsistencia({ nombre: '' }, est).motivo, 'nombre');
  assert.equal(TC.validarAsistencia({ nombre: 'Ana' }, { ...est, total: 80 }).motivo, 'cupo');
  assert.equal(TC.validarAsistencia({ nombre: 'Ana', rut: '1-9' }, { ...est, rutsUsados: ['1-9'] }).motivo, 'duplicado');
});

test('validarAsistencia: enlace, firma pesada, nombre largo y duplicado por nombre', () => {
  const est = { total: 0, rutsUsados: [], nombresUsados: ['ana perez'] };
  assert.equal(TC.validarAsistencia({ nombre: 'Ana' }, { ...est, enlaceValido: false }).motivo, 'enlace');
  assert.equal(TC.validarAsistencia({ nombre: 'x'.repeat(121) }, est).motivo, 'nombre');
  assert.equal(TC.validarAsistencia({ nombre: 'Ana', firma: 'A'.repeat(60 * 1024 + 1) }, est).motivo, 'firma');
  assert.equal(TC.validarAsistencia({ nombre: 'Ana', firma: 'A'.repeat(60 * 1024) }, est).ok, true);
  assert.equal(TC.validarAsistencia({ nombre: ' ANA  Pérez ' }, est).motivo, 'duplicado');
});

// Lienzo falso: registra el tamaño y los trazos dibujados, y devuelve un PNG simulado.
function lienzoFalso() {
  const reg = { lienzos: [] };
  TC._canvas = (w, h) => {
    const c = { width: w, height: h, lineas: [], puntos: 0 };
    c.getContext = () => ({
      fillRect() {}, beginPath() {}, stroke() {}, arc() { c.puntos++; },
      moveTo() { c.puntos++; }, lineTo(x, y) { c.lineas.push([x, y]); },
      set lineWidth(v) { c.grosor = v; }, set strokeStyle(v) {}, set fillStyle(v) {}, set lineCap(v) {}, set lineJoin(v) {},
    });
    c.toDataURL = (tipo) => { c.tipo = tipo; return 'data:image/png;base64,' + 'A'.repeat(200); };
    reg.lienzos.push(c);
    return c;
  };
  return reg;
}

test('trazoAPng: el trazo sobrevive a un cambio de tamaño del lienzo', () => {
  const reg = lienzoFalso();
  const trazos = [[{ x: 10, y: 10 }, { x: 90, y: 50 }]];
  const a = TC.trazoAPng(trazos, 600);
  const b = TC.trazoAPng(trazos, 300);
  assert.ok(a.startsWith('data:image/png;base64,'));
  assert.ok(b.length > 100);
  // Recorta al contenido y el tamaño de salida sigue al ancho pedido.
  const [ca, cb] = reg.lienzos;
  assert.equal(ca.tipo, 'image/png');
  assert.ok(ca.width > cb.width && cb.width <= 300 && ca.width <= 600);
  // Todo el trazo cae dentro del lienzo recortado, en ambos tamaños.
  for (const c of [ca, cb]) for (const [x, y] of c.lineas) assert.ok(x >= 0 && x <= c.width && y >= 0 && y <= c.height);
});

test('trazoAPng: sin trazos devuelve vacío y un punto suelto también deja marca', () => {
  const reg = lienzoFalso();
  assert.equal(TC.trazoAPng([], 400), '');
  assert.equal(TC.trazoAPng([[]], 400), '');
  assert.equal(reg.lienzos.length, 0);
  assert.ok(TC.trazoAPng([[{ x: 5, y: 5 }]], 400).startsWith('data:image/png'));
  assert.ok(reg.lienzos[0].puntos > 0);
});

test('trazoAPng: el tamaño de salida no depende de las unidades de los puntos', () => {
  const reg = lienzoFalso();
  TC.trazoAPng([[{ x: 0.2, y: 0.1 }, { x: 0.6, y: 0.2 }]], 400);   // puntos normalizados (ventana de firma)
  TC.trazoAPng([[{ x: 200, y: 100 }, { x: 600, y: 200 }]], 400);   // los mismos puntos en pixeles
  const [a, b] = reg.lienzos;
  assert.ok(a.width > 300, 'la firma pequeña en unidades normalizadas se escala al ancho pedido');
  assert.equal(a.width, b.width);
  assert.ok(Math.abs(a.height - b.height) <= 1);   // el redondeo de coma flotante puede mover 1 px
});

test('puedeEditar: el autor y el admin sí; otro PM o sin sesión no', () => {
  const r = { autor: 'u1' };
  assert.equal(TC.puedeEditar(r, { id: 'u1', admin: false }), true);
  assert.equal(TC.puedeEditar(r, { id: 'u2', admin: true }), true);
  assert.equal(TC.puedeEditar(r, { id: 'u2', admin: false }), false);
  assert.equal(TC.puedeEditar(r, null), false);
  assert.equal(TC.puedeEditar({ autor: null }, { id: null, admin: false }), false);
});

test('marcarEdicion: deja huella de quién y cuándo, sin perder los demás datos ni mutar el original', () => {
  const orig = { nombre: 'Charla', observaciones: 'x', otro: 1 };
  const d = TC.marcarEdicion(orig, 'Ana PM', '2026-11-20T10:00:00.000Z');
  assert.deepEqual(d.editado, { ts: '2026-11-20T10:00:00.000Z', por: 'Ana PM' });
  assert.equal(d.otro, 1);
  assert.equal(orig.editado, undefined);
  assert.deepEqual(TC.marcarEdicion(null, 'A', 't'), { editado: { ts: 't', por: 'A' } });
});

test('fotosEditadas: conserva las existentes, agrega las nuevas y no duplica', () => {
  assert.deepEqual(TC.fotosEditadas(['a/1.jpg', 'a/2.jpg'], ['a/3.jpg']), ['a/1.jpg', 'a/2.jpg', 'a/3.jpg']);
  assert.deepEqual(TC.fotosEditadas(['a/1.jpg'], ['a/1.jpg', 'a/2.jpg']), ['a/1.jpg', 'a/2.jpg']);
  assert.deepEqual(TC.fotosEditadas(null, undefined), []);
});

// ── QR de asistencia: enlace, borradores y participantes en la tabla ──
test('enlaceAsistencia: apunta a la página pública con el token en ?t=', () => {
  assert.equal(TC.enlaceAsistencia('abc123'), 'https://apps.grouptx.app/terreno-asistencia.html?t=abc123');
  assert.equal(TC.enlaceAsistencia('a b&c'), 'https://apps.grouptx.app/terreno-asistencia.html?t=a%20b%26c');
});

test('tokenValido: solo 32 caracteres hexadecimales (lo que genera la base)', () => {
  assert.equal(TC.tokenValido('0123456789abcdef0123456789ABCDEF'), true);
  for (const mal of ['', null, undefined, 'abc', 'g'.repeat(32), '0123456789abcdef0123456789abcdef0', '../../etc/passwd']) assert.equal(TC.tokenValido(mal), false);
});

test('esPngFirma: solo un PNG en data URL base64', () => {
  assert.equal(TC.esPngFirma('data:image/png;base64,iVBORw0KGgo='), true);
  for (const mal of [true, '', null, 'data:image/jpeg;base64,AA', 'data:image/png;base64,<script>', 'javascript:alert(1)']) assert.equal(TC.esPngFirma(mal), false);
});

test('borradores: se reconocen por la asistencia abierta, quedan fuera de las cifras y van primero en la lista', () => {
  const a = { id: 'a', asistencia_abierta: false }, b = { id: 'b', asistencia_abierta: true }, c = { id: 'c' }, d = { id: 'd', asistencia_abierta: true };
  assert.equal(TC.esBorrador(b), true);
  assert.equal(TC.esBorrador(c), false);
  assert.equal(TC.esBorrador(null), false);
  assert.deepEqual(TC.sinBorradores([a, b, c, d]).map((r) => r.id), ['a', 'c']);
  assert.deepEqual(TC.ordenarRegistros([a, b, c, d]).map((r) => r.id), ['b', 'd', 'a', 'c']);
  const orig = [a, b];
  TC.ordenarRegistros(orig);
  assert.deepEqual(orig.map((r) => r.id), ['a', 'b'], 'no muta la lista original');
});

test('totalParticipantes: cuenta la tabla y, si no hay filas, los datos viejos', () => {
  assert.equal(TC.totalParticipantes({ nAsistencias: 3, participantes: [{}, {}] }), 3);
  assert.equal(TC.totalParticipantes({ nAsistencias: 0, participantes: [{}, {}] }), 2);
  assert.equal(TC.totalParticipantes({}), 0);
});

const fila = (o) => ({ id: 'x', origenFila: 'nuevo', sucia: false, rut: '', nombre: '', cargo: '', email: '', fono: '', firma: '', ...o });

test('planParticipantes: inserta las nuevas, actualiza solo las tocadas, borra las quitadas y las que quedaron vacías', () => {
  const filas = [
    fila({ id: 'n1', nombre: 'Ana' }),                                       // nueva con datos
    fila({ id: 'n2' }),                                                      // nueva en blanco: se ignora
    fila({ id: 't1', origenFila: 'tabla', nombre: 'Luis' }),                 // de la tabla, intacta
    fila({ id: 't2', origenFila: 'tabla', nombre: 'Eva', sucia: true }),     // de la tabla, corregida
    fila({ id: 't3', origenFila: 'tabla', sucia: true }),                    // de la tabla, la dejaron vacía
  ];
  const p = TC.planParticipantes(filas, { quitados: ['q1'], viejo: false });
  assert.deepEqual(p.insertar.map((f) => f.id), ['n1']);
  assert.deepEqual(p.actualizar.map((f) => f.id), ['t2']);
  assert.deepEqual(p.borrar.sort(), ['q1', 't3']);
  assert.equal(p.migrar, false);
});

test('planParticipantes: una fila con solo RUT cuenta como fila; en blanco no', () => {
  const p = TC.planParticipantes([fila({ id: 'n1', rut: '1-9' }), fila({ id: 'n2', nombre: '   ' })], { quitados: [], viejo: false });
  assert.deepEqual(p.insertar.map((f) => f.id), ['n1']);
});

test('planParticipantes: lista de un registro viejo sin tocar no se migra (conserva "firmó")', () => {
  const filas = [fila({ id: 'v0', origenFila: 'viejo', nombre: 'Juan' }), fila({ id: 'n1' })];
  assert.deepEqual(TC.planParticipantes(filas, { quitados: [], viejo: true }), { insertar: [], actualizar: [], borrar: [], migrar: false });
});

test('planParticipantes: si el PM cambia la lista de un registro viejo, pasa entera a la tabla', () => {
  const base = () => [fila({ id: 'v0', origenFila: 'viejo', nombre: 'Juan' }), fila({ id: 'v1', origenFila: 'viejo', nombre: 'Ana' })];
  const editada = base(); editada[1].sucia = true;
  let p = TC.planParticipantes(editada, { quitados: [], viejo: true });
  assert.deepEqual(p.insertar.map((f) => f.nombre), ['Juan', 'Ana']);
  assert.deepEqual([p.actualizar, p.borrar, p.migrar], [[], [], true]);
  p = TC.planParticipantes([base()[0]], { quitados: ['v1'], viejo: true });   // quitó una
  assert.deepEqual(p.insertar.map((f) => f.nombre), ['Juan']);
  assert.deepEqual([p.borrar, p.migrar], [[], true], 'no intenta borrar en la base un id que nunca estuvo allí');
  p = TC.planParticipantes([], { quitados: ['v0', 'v1'], viejo: true });      // quitó todas
  assert.deepEqual([p.insertar, p.migrar], [[], true]);
  p = TC.planParticipantes([...base(), fila({ id: 'n1', nombre: 'Nueva' })], { quitados: [], viejo: true });   // agregó una
  assert.equal(p.insertar.length, 3);
});

test('mensajeAsistencia: duplicado, enlace cerrado y falla de red se distinguen', () => {
  assert.equal(TC.mensajeAsistencia({ code: 'P0001', message: 'ya estás registrado en esta actividad' }).tipo, 'duplicado');
  const c = TC.mensajeAsistencia({ code: 'P0001', message: 'enlace no válido o actividad cerrada' });
  assert.equal(c.tipo, 'cerrado');
  assert.match(c.texto, /cupo/);
  for (const e of [{ message: 'Failed to fetch' }, { message: 'TypeError: NetworkError' }, null, undefined, { code: '57014', message: 'canceling statement' }]) {
    const m = TC.mensajeAsistencia(e);
    assert.equal(m.tipo, 'red');
    assert.match(m.texto, /conexión/);
  }
});

test('llegadasNuevas: descarta las que ya están en pantalla y las que el PM quitó', () => {
  const r = TC.llegadasNuevas(['a', 'b', 'c', 'd'], ['a'], ['c']);
  assert.deepEqual(r, ['b', 'd']);
  assert.deepEqual(TC.llegadasNuevas(null, null, null), []);
});

test('conteoAsistencias: tolera array con objeto, objeto suelto, número o texto, y da 0 si no viene', () => {
  assert.equal(TC.conteoAsistencias([{ count: 3 }]), 3);
  assert.equal(TC.conteoAsistencias({ count: 4 }), 4);
  assert.equal(TC.conteoAsistencias(5), 5);
  assert.equal(TC.conteoAsistencias([{ count: '7' }]), 7);
  for (const raro of [undefined, null, [], {}, [{}], 'x', [{ count: -1 }], [{ count: 'abc' }]]) assert.equal(TC.conteoAsistencias(raro), 0);
});

// ── Cierre de la visita e informe en PDF ──
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = (n) => 'data:image/jpeg;base64,/9j/' + n;
const regVisita = (extra = {}) => ({
  cliente: 'Constructora Los Andes', obra: 'Edificio Alameda', fecha: '2026-11-18',
  datos: { direccion: 'Av. Siempre Viva 123', contacto: 'Ana Soto', producto: 'Piso Autonivelante', motivo: 'Fisuras en el piso', verificacion: 'Se revisó la aplicación', causa: 'Aplicación', solucion: 'Reparar con mortero', lab: 'Sí', observaciones: '',
    cierre: { nombre: 'Pedro Rojas', cargo: 'Jefe de obra', email: 'pedro@andes.cl', fono: '+56 9 1111 2222', firma: PNG, firmaPm: PNG }, ...(extra.datos || {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'datos')),
});
const contar = (html, clase) => html.split('class="' + clase + '"').length - 1;

test('informeVisitaHtml: lleva título propio, cliente, quien recibe y la nota legal verbatim, y no inventa código de documento', () => {
  const h = TC.informeVisitaHtml(regVisita(), { fotos: [], logo: '<svg id="logo"></svg>', pm: 'María PM' });
  assert.match(h, /Informe de Visita Técnica/);
  assert.match(h, /Constructora Los Andes/);
  assert.match(h, /Pedro Rojas/);
  assert.match(h, /María PM/);
  assert.match(h, /18-11-2026/);
  assert.ok(h.includes('<svg id="logo"></svg>'));
  assert.ok(h.includes(TC.NOTA_LEGAL), 'la nota legal va completa');
  for (const ajeno of [TC.DOC_META.codigo, TC.DOC_META.titulo, TC.DOC_META.creacion, 'Versión']) assert.ok(!h.includes(ajeno), 'no usa la identidad del informe de adherencia: ' + ajeno);
});

test('informeVisitaHtml: un bloque por foto, con su pie numerado; sin fotos no hay sección', () => {
  const con = TC.informeVisitaHtml(regVisita(), { fotos: [JPG('a'), JPG('b')] });
  assert.equal(contar(con, 'inf-foto'), 2);
  assert.match(con, /Fotografía 1 de 2/);
  assert.match(con, /Fotografía 2 de 2/);
  const sin = TC.informeVisitaHtml(regVisita(), { fotos: [] });
  assert.equal(contar(sin, 'inf-foto'), 0);
  assert.ok(!/Registro fotográfico/.test(sin));
});

test('informeVisitaHtml: las dos firmas aparecen como imagen; sin firma del cliente queda la línea en blanco', () => {
  const h = TC.informeVisitaHtml(regVisita(), {});
  assert.equal(contar(h, 'inf-firma-img'), 2);
  const sinCliente = TC.informeVisitaHtml(regVisita({ datos: { cierre: null } }), { pm: 'María PM' });
  assert.equal(contar(sinCliente, 'inf-firma-img'), 0);
  assert.equal(contar(sinCliente, 'inf-firma'), 2);
});

test('informeVisitaHtml: escapa el texto del usuario y no deja pasar imágenes que no sean data URL de imagen', () => {
  const h = TC.informeVisitaHtml(regVisita({ cliente: '<img src=x onerror=alert(1)>', datos: { motivo: 'a <b>b</b> & c' } }), { fotos: [JPG('ok')] });
  assert.ok(!h.includes('<img src=x'));
  assert.ok(h.includes('a &lt;b&gt;b&lt;/b&gt; &amp; c'));
  assert.equal(contar(h, 'inf-foto'), 1);
});

test('informeVisitaHtml: una foto con data URL inválido no se omite en silencio, falla con mensaje claro', () => {
  for (const mala of ['javascript:alert(1)', 'data:application/octet-stream;base64,AAAA', 'data:;base64,AAAA', '']) {
    assert.throws(() => TC.informeVisitaHtml(regVisita(), { fotos: [JPG('a'), mala] }), /fotografía 2 de la visita no se pudo incluir/i);
  }
});

test('informeVisitaHtml: la foto se muestra completa (contain), sin recorte', () => {
  const h = TC.informeVisitaHtml(regVisita(), { fotos: [JPG('a')] });
  assert.ok(h.includes('object-fit:contain'));
  assert.ok(!h.includes('object-fit:cover'));
});

test('informeVisitaHtml: omite las secciones opcionales vacías y no inventa texto', () => {
  const h = TC.informeVisitaHtml(regVisita({ datos: { verificacion: '', solucion: '', observaciones: '', direccion: '' } }), {});
  assert.ok(!/Verificación en terreno/.test(h));
  assert.ok(!/Solución propuesta/.test(h));
  assert.ok(!/Observaciones/.test(h));
  assert.match(h, /Fisuras en el piso/);
});

test('cierreVisita: recorta los datos, descarta firmas que no son PNG y devuelve null si el cliente no dejó nada', () => {
  assert.equal(TC.cierreVisita({}), null);
  assert.equal(TC.cierreVisita({ nombre: '  ', firma: 'javascript:x' }), null);
  assert.deepEqual(TC.cierreVisita({ nombre: ' Pedro ', email: ' p@a.cl ', firma: PNG, firmaPm: 'x' }),
    { nombre: 'Pedro', cargo: '', email: 'p@a.cl', fono: '', firma: PNG, firmaPm: '' });
  assert.deepEqual(TC.cierreVisita({ firmaPm: PNG }), { nombre: '', cargo: '', email: '', fono: '', firma: '', firmaPm: PNG });
});

test('cupoFotos: tope de 8 por visita contando las que ya tenía', () => {
  assert.equal(TC.MAX_FOTOS, 8);
  assert.deepEqual(TC.cupoFotos(0, 8), { admitidas: 8, sobran: 0 });
  assert.deepEqual(TC.cupoFotos(0, 9), { admitidas: 8, sobran: 1 });
  assert.deepEqual(TC.cupoFotos(6, 4), { admitidas: 2, sobran: 2 });
  assert.deepEqual(TC.cupoFotos(8, 1), { admitidas: 0, sobran: 1 });
  assert.deepEqual(TC.cupoFotos(undefined, 0), { admitidas: 0, sobran: 0 });
});

test('tamanoInforme: texto legible y aviso sobre el límite de envío de 8 MB', () => {
  assert.deepEqual(TC.tamanoInforme(1572864), { texto: '1,5 MB', excede: false });
  assert.deepEqual(TC.tamanoInforme(512000), { texto: '500 KB', excede: false });
  assert.equal(TC.tamanoInforme(8 * 1024 * 1024).excede, false);
  assert.equal(TC.tamanoInforme(8 * 1024 * 1024 + 1).excede, true);
  assert.equal(TC.LIMITE_ENVIO_BYTES, 8 * 1024 * 1024);
});

test('nombreInforme: archivo seguro con obra y fecha', () => {
  assert.equal(TC.nombreInforme({ obra: 'Edificio Alameda / Torre 2', fecha: '2026-11-18' }), 'Informe visita técnica - Edificio Alameda Torre 2 - 18-11-2026.pdf');
  assert.equal(TC.nombreInforme({ cliente: 'Cliente X', fecha: '2026-11-18' }), 'Informe visita técnica - Cliente X - 18-11-2026.pdf');
  assert.equal(TC.nombreInforme({}), 'Informe visita técnica.pdf');
});

test('tipoImagen: reconoce JPEG, PNG y WebP por sus bytes y rechaza HTML, texto o vacío', () => {
  assert.equal(TC.tipoImagen([0xFF, 0xD8, 0xFF, 0xE0]), 'image/jpeg');
  assert.equal(TC.tipoImagen([0x89, 0x50, 0x4E, 0x47, 0x0D]), 'image/png');
  assert.equal(TC.tipoImagen([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]), 'image/webp');
  const html = [...Buffer.from('<!DOCTYPE html><html>')];
  const json = [...Buffer.from('{"error":"not found"}')];
  const wav = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45];
  for (const mal of [html, json, wav, [0xFF, 0xD8], [], null, undefined]) assert.equal(TC.tipoImagen(mal), null);
});

// ---- Envío de la copia al cliente ----
test('correoValido: una sola dirección; rechaza listas, espacios, saltos de línea y vacíos', () => {
  for (const ok of ['ana@obra.cl', 'a.b+c@sub.empresa.com']) assert.equal(TC.correoValido(ok), true, ok);
  for (const mal of ['', null, undefined, 'ana', 'ana@obra', 'a@b.cl, c@d.cl', 'a@b.cl;c@d.cl', 'a@b.cl\nBcc: x@y.cl', 'a b@c.cl', 'a@@b.cl', '<a@b.cl>']) assert.equal(TC.correoValido(mal), false, String(mal));
});

const informe = (extra) => ({ blob: { size: 1000 }, base64: 'JVBERi0=', nombre: 'Informe.pdf', huella: 'abc-10', registroId: 'v1', ...extra });

test('puedeEnviar: solo si el informe es de ESTA visita y de este contenido', () => {
  assert.deepEqual(TC.puedeEnviar(informe(), { id: 'v1', huella: 'abc-10' }), { ok: true });
  assert.equal(TC.puedeEnviar(informe({ registroId: 'v2' }), { id: 'v1', huella: 'abc-10' }).motivo, 'otra_visita');   // el informe del cliente A no sale al B
  assert.equal(TC.puedeEnviar(informe({ huella: 'zzz-10' }), { id: 'v1', huella: 'abc-10' }).motivo, 'desactualizado');
  assert.equal(TC.puedeEnviar(informe({ registroId: null }), { id: 'v1', huella: 'abc-10' }).motivo, 'sin_guardar');
  assert.equal(TC.puedeEnviar(informe(), { id: null, huella: 'abc-10' }).motivo, 'sin_guardar');
  assert.equal(TC.puedeEnviar(informe({ registroId: null }), { id: null, huella: 'abc-10' }).ok, false);   // null === null no vale como identidad
  assert.equal(TC.puedeEnviar(null, { id: 'v1', huella: 'abc-10' }).motivo, 'sin_informe');
  assert.equal(TC.puedeEnviar(informe({ base64: '' }), { id: 'v1', huella: 'abc-10' }).motivo, 'sin_informe');
  assert.equal(TC.puedeEnviar(informe({ nombre: 'informe.html' }), { id: 'v1', huella: 'abc-10' }).motivo, 'sin_informe');
});

test('textoErrorEnvio: pendiente_publicar y el resto, en lenguaje del PM', () => {
  assert.match(TC.textoErrorEnvio('pendiente_publicar'), /el envío de correos todavía no está publicado/);
  assert.match(TC.textoErrorEnvio('otra_visita'), /otra visita/);
  assert.match(TC.textoErrorEnvio('apps_script', 'Límite de correos excedido'), /Límite de correos excedido/);
  assert.match(TC.textoErrorEnvio('algo_raro'), /inesperado/);
});

test('registrarEnvio: agrega al historial sin tocar el original ni borrar envíos anteriores', () => {
  const antes = { motivo: 'x', envios: [{ ts: '2026-11-19T10:00:00Z', para: 'a@b.cl', asunto: 'A', por: 'Ana' }] };
  const nuevo = TC.registrarEnvio(antes, { ts: '2026-11-20T15:30:00Z', para: 'c@d.cl', asunto: 'B', por: 'Luis' });
  assert.equal(nuevo.envios.length, 2);
  assert.deepEqual(nuevo.envios[1], { ts: '2026-11-20T15:30:00Z', para: 'c@d.cl', asunto: 'B', por: 'Luis' });
  assert.equal(antes.envios.length, 1);
  assert.equal(nuevo.motivo, 'x');
  assert.equal(TC.registrarEnvio({}, { ts: 't', para: 'p', asunto: 'a', por: 'q' }).envios.length, 1);
});

test('lineaEnvio: "Copia enviada a … el …" en hora de Chile; avisa si la visita se corrigió después', () => {
  assert.equal(TC.lineaEnvio({}), '');
  assert.equal(TC.lineaEnvio({ envios: [] }), '');
  const e = { ts: '2026-11-20T15:30:00Z', para: 'ana@obra.cl', asunto: 'A', por: 'Luis' };
  assert.equal(TC.lineaEnvio({ envios: [e] }), 'Copia enviada a ana@obra.cl el 20-11-2026 12:30');
  const dos = TC.lineaEnvio({ envios: [{ ...e, ts: '2026-11-19T15:30:00Z', para: 'viejo@obra.cl' }, e] });
  assert.match(dos, /ana@obra\.cl/); assert.doesNotMatch(dos, /viejo/);
  assert.match(TC.lineaEnvio({ envios: [e], editado: { ts: '2026-11-21T10:00:00Z', por: 'Luis' } }), /se corrigió después del envío/);
  assert.doesNotMatch(TC.lineaEnvio({ envios: [e], editado: { ts: '2026-11-20T10:00:00Z', por: 'Luis' } }), /corrigió/);
});

test('botonEnvio: solo con un correo de cliente válido; "Reintentar" si no hay envío, "Reenviar" si ya salió uno', () => {
  assert.equal(TC.botonEnvio({}), null);
  assert.equal(TC.botonEnvio({ cierre: { email: 'mal' } }), null);
  assert.equal(TC.botonEnvio({ cierre: { email: 'ana@obra.cl' } }), 'Reintentar envío');
  assert.equal(TC.botonEnvio({ cierre: { email: 'ana@obra.cl' }, envios: [{ ts: 't', para: 'ana@obra.cl' }] }), 'Reenviar copia');
});

test('correoVisita repite los datos clave en el cuerpo (el PDF es imagen: no se puede copiar texto de él)', () => {
  const c = TC.correoVisita({ fecha: '2026-11-20', cliente: 'Ingevec', obra: 'Edificio Sur', datos: { producto: 'TX-100', motivo: 'Grieta en piso', verificacion: 'Se midió humedad', causa: 'Humedad del sustrato', solucion: 'Secar y reaplicar' } });
  for (const t of ['Ingevec', 'Edificio Sur', '20-11-2026', 'TX-100', 'Grieta en piso', 'Se midió humedad', 'Humedad del sustrato', 'Secar y reaplicar']) assert.ok(c.cuerpo.includes(t), t);
});

// ---- Estado del envío (intento anotado ANTES de llamar a la función) ----
const ENV = { ts: '2026-11-20T15:30:00Z', para: 'ana@obra.cl', asunto: 'A', por: 'Luis' };

test('registrarEnvio con estado y resolverEnvio: cambia el estado de ESE intento o lo quita', () => {
  const a = TC.registrarEnvio({}, { ...ENV, estado: 'enviando' });
  assert.equal(a.envios[0].estado, 'enviando');
  assert.equal(TC.registrarEnvio({}, ENV).envios[0].estado, undefined);   // sin estado = enviada (registros ya guardados)
  const b = TC.resolverEnvio(a, ENV.ts, 'enviada');
  assert.equal(b.envios[0].estado, 'enviada'); assert.equal(a.envios[0].estado, 'enviando');
  assert.equal(TC.resolverEnvio(a, ENV.ts, null).envios.length, 0);
  const dos = TC.registrarEnvio(b, { ...ENV, ts: '2026-11-21T10:00:00Z', estado: 'enviando' });
  assert.equal(TC.resolverEnvio(dos, '2026-11-21T10:00:00Z', null).envios.length, 1);
});

test('envioNoSalio: solo los errores en que el correo seguro NO salió; red y apps_script son dudosos', () => {
  for (const c of ['pendiente_publicar', 'otra_visita', 'desactualizado', 'sin_guardar', 'sin_informe', 'demasiado_grande', 'correo_no_coincide', 'mensaje_no_corresponde', 'sin_acceso', 'no_es_autor', 'no_autorizado']) assert.equal(TC.envioNoSalio(c), true, c);
  for (const c of ['red', 'apps_script', 'algo_raro', undefined]) assert.equal(TC.envioNoSalio(c), false, String(c));
});

test('lineaEnvio y botonEnvio ante un intento dudoso: dice que PUEDE haber salido y advierte que reenviar duplica', () => {
  const dudoso = { cierre: { email: 'ana@obra.cl' }, envios: [{ ...ENV, estado: 'dudoso' }] };
  const enviando = { cierre: { email: 'ana@obra.cl' }, envios: [{ ...ENV, estado: 'enviando' }] };
  for (const d of [dudoso, enviando]) {
    assert.match(TC.lineaEnvio(d), /puede haber salido/);
    assert.match(TC.lineaEnvio(d), /ana@obra\.cl/);
    assert.match(TC.botonEnvio(d), /duplicar/);
    assert.equal(TC.envioDudoso(d), true);
  }
  const ok = { cierre: { email: 'ana@obra.cl' }, envios: [{ ...ENV, estado: 'enviada' }] };
  assert.equal(TC.envioDudoso(ok), false); assert.equal(TC.botonEnvio(ok), 'Reenviar copia');
  assert.match(TC.lineaEnvio(ok), /^Copia enviada a ana@obra\.cl/);
  assert.equal(TC.envioDudoso({}), false);
});

test('textoErrorEnvio: mensaje_no_corresponde', () => {
  assert.match(TC.textoErrorEnvio('mensaje_no_corresponde'), /el mensaje no corresponde a esta visita/);
});
