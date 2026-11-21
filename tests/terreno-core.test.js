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
