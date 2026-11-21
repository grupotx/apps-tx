// Registro de Terreno: lógica pura (MPa, conclusión, correos, participantes, validación del QR).
// Script clásico: en navegador expone window.TC; en Node, module.exports.
(function (g) {
  'use strict';

  // ── Textos fijos del informe de adherencia ──
  // Viven solo aquí: la visita y el informe de adherencia los importan de este módulo.
  const CONCLUSION_BASE = 'Los resultados obtenidos fueron realizados según requerimientos de la Norma NCh 2471, Método de tracción directa. Los requisitos de adherencia para revestimientos continuos según Norma NCh 2256/1 se expresan en 0,20 MPa (>2 Kg/cm2) como mínimo, a 28 días.';
  const DESARROLLO_DEFECTO = 'Se realizan extracciones para verificar Adherencia en faena Piso Autonivelante, para lo cual se realizan cortes de 50*50 mm que abarca desde el Nivelador hasta la losa de hormigón.';
  const NOTA_LEGAL = 'Nota: Grupo TX respalda la calidad de sus productos mediante rigurosos ensayos de laboratorio y controles de calidad, cumpliendo altos estándares. La información técnica y recomendaciones proporcionadas se basan en nuestra experiencia y conocimiento actual, bajo condiciones estándar de uso (almacenamiento, manipulación y aplicación). Reconocemos que las condiciones reales de obra varían, afectando el desempeño de los materiales. Por consiguiente, y dada la diversidad de sustratos y entornos, Grupo TX no ofrece garantías explícitas ni implícitas de comercialización o idoneidad para un propósito particular, ni se derivan obligaciones legales de la información o recomendaciones proporcionadas, ya sean éstas escritas u orales. Instamos a los usuarios a realizar pruebas de campo para validar la idoneidad de nuestros productos en cada proyecto. Nuestro equipo técnico está siempre disponible para brindar soporte especializado ante dudas y/o consultas. Grupo TX se reserva el derecho de modificar sus productos para su mejora continua. Se recomienda a los usuarios consultar siempre la versión más reciente de la ficha técnica del producto, disponible bajo petición o en www.grupotx.cl';
  // Una línea por elemento (el PDF las pone una bajo otra).
  const PIE = ['CENTRO DE INVESTIGACION Y DESARROLLO GRUPO TX', 'Camino el Rodeo 01805 – Puente Alto– Santiago - Chile', 'Fono: +56 2392 6000 · www.grupotx.cl'];
  const DOC_META = { titulo: 'Informe Prueba Adherencia', codigo: 'DOC-PM-LAB-05', creacion: '02-01-2025', version: '0.0' };

  // ── Ensayo de adherencia ──
  const UMBRAL_MPA = 0.2; // mínimo NCh 2256/1 a 28 días
  const num = (x) => (x === '' || x == null ? NaN : Number(x));
  const r2 = (x) => Math.round(x * 100) / 100;

  // kN → N sobre el área en mm² da MPa directo. Sin dato positivo no hay resultado.
  function mpa(cargaKn, anchoMm, altoMm) {
    const c = num(cargaKn), a = num(anchoMm), h = num(altoMm);
    if (!(c > 0) || !(a > 0) || !(h > 0)) return null;
    return r2((c * 1000) / (a * h));
  }

  // El MPa escrito a mano manda sobre el calculado (el laboratorio a veces corrige el valor).
  const mpaFila = (f) => {
    const m = num(f.mpa);
    return Number.isFinite(m) ? m : mpa(f.cargaKn, f.anchoMm, f.altoMm);
  };

  function resumenEnsayo(filas) {
    const vals = [];
    const bajoUmbral = [];
    for (const f of filas || []) {
      const m = mpaFila(f);
      if (m == null) continue;
      vals.push(m);
      if (m < UMBRAL_MPA) bajoUmbral.push(f.n);
    }
    if (!vals.length) return { min: null, max: null, prom: null, bajoUmbral };
    return { min: Math.min(...vals), max: Math.max(...vals), prom: r2(vals.reduce((s, v) => s + v, 0) / vals.length), bajoUmbral };
  }

  // Solo informa los tipos de falla: no dictamina cumplimiento (lo decide el profesional).
  function conclusionBase(filas) {
    const tipos = [];
    for (const f of filas || []) {
      const t = (f.falla || '').trim();
      if (t && !tipos.includes(t)) tipos.push(t);
    }
    if (!tipos.length) return CONCLUSION_BASE;
    return CONCLUSION_BASE + ' Las fallas identificadas corresponden a: ' + tipos.join(', ') + '.';
  }

  // ── Correos al cliente ──
  const fechaCL = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
  };
  const linea = (etiqueta, valor) => (valor && String(valor).trim() ? etiqueta + ': ' + String(valor).trim() + '\n' : '');
  const saludo = (reg) => 'Estimado(a)' + (reg.cliente ? ' ' + reg.cliente : '') + ':\n\n';
  const despedida = '\nQuedamos atentos a cualquier consulta.\nSaludos cordiales,\nGrupo TX';

  function correoVisita(reg) {
    const d = reg.datos || {};
    const cuerpo = saludo(reg)
      + 'Junto con saludar, adjuntamos el informe de la visita técnica realizada el ' + fechaCL(reg.fecha) + (reg.obra ? ' en la obra ' + reg.obra : '') + '.\n\n'
      + linea('Producto', d.producto) + linea('Motivo de la visita', d.motivo) + linea('Verificación en terreno', d.verificacion)
      + linea('Causa probable', d.causa) + linea('Solución propuesta', d.solucion) + linea('Contacto en obra', d.contacto)
      + despedida;
    return { asunto: 'Visita técnica ' + (reg.obra || '') + ' – ' + fechaCL(reg.fecha), cuerpo };
  }

  function correoEnsayo(reg) {
    const d = reg.datos || {};
    const r = resumenEnsayo(d.filas);
    const n = (d.filas || []).length;
    const cuerpo = saludo(reg)
      + 'Junto con saludar, adjuntamos el informe de la prueba de adherencia realizada el ' + fechaCL(reg.fecha) + (reg.obra ? ' en la obra ' + reg.obra : '') + '.\n\n'
      + linea('Motivo de la visita', d.motivo_visita)
      + (n ? 'Se ensayaron ' + n + ' probeta' + (n === 1 ? '' : 's') + (r.min != null ? ', con resultados entre ' + String(r.min).replace('.', ',') + ' y ' + String(r.max).replace('.', ',') + ' MPa.\n' : '.\n') : '')
      + 'El detalle de los resultados y las conclusiones se encuentra en el documento adjunto.\n'
      + despedida;
    return { asunto: 'Informe prueba de adherencia ' + (reg.obra || '') + ' – ' + fechaCL(reg.fecha), cuerpo };
  }

  // ── Participantes (asistencia por QR + registros viejos) ──
  const CAMPOS_P = ['nombre', 'rut', 'cargo', 'email', 'fono'];

  function participantesVista(filas, datosViejos) {
    if (filas && filas.length) {
      return filas.map((f) => ({ id: f.id, ...Object.fromEntries(CAMPOS_P.map((k) => [k, f[k] || ''])), firma: f.firma || '', firmo: f.firmo != null ? !!f.firmo : !!f.firma, origen: f.origen || 'qr' }));
    }
    // Registro viejo: la firma era un booleano; ahora es el trazo (vacío) más la marca de que firmó.
    return (datosViejos || []).map((p, i) => ({
      id: p.id || 'v' + i, ...Object.fromEntries(CAMPOS_P.map((k) => [k, p[k] || ''])),
      firma: typeof p.firma === 'string' ? p.firma : '', firmo: !!p.firma || !!p.firmo, origen: p.origen || 'manual',
    }));
  }

  // Las filas nuevas del QR entran al final; una fila "sucia" (el PM la está escribiendo) no se toca.
  function mezclarParticipantes(actuales, llegadas) {
    const res = (actuales || []).map((p) => ({ ...p }));
    for (const l of llegadas || []) {
      const i = res.findIndex((p) => p.id === l.id);
      if (i < 0) res.push({ ...l });
      else if (!res[i]._sucia) res[i] = { ...res[i], ...l };
    }
    return res;
  }

  // ── Validación del envío por QR (la RPC de la base refleja estas reglas) ──
  const MAX_NOMBRE = 120, MAX_FIRMA = 60 * 1024, MAX_ACTIVIDAD = 80;
  const normNombre = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const normRut = (s) => String(s || '').replace(/[.\s]/g, '').toLowerCase();

  function validarAsistencia(datos, estado) {
    const d = datos || {}, e = estado || {};
    const no = (motivo) => ({ ok: false, motivo });
    if (e.enlaceValido === false) return no('enlace');
    const nombre = String(d.nombre || '').trim();
    if (!nombre || nombre.length > MAX_NOMBRE) return no('nombre');
    if (d.firma && String(d.firma).length > MAX_FIRMA) return no('firma');
    if ((e.total || 0) >= MAX_ACTIVIDAD) return no('cupo');
    const rut = normRut(d.rut);
    const repetido = rut
      ? (e.rutsUsados || []).some((r) => normRut(r) === rut)
      : (e.nombresUsados || []).some((n) => normNombre(n) === normNombre(nombre));
    return repetido ? no('duplicado') : { ok: true };
  }

  // ── Firma manuscrita ──
  // Los trazos son listas de puntos [[{x,y},…],…] en cualquier espacio de coordenadas (la ventana de firma
  // los guarda sin pixeles fijos para poder redibujarlos al girar la pantalla). Se recorta al contenido,
  // se escala para que quepa en `ancho` px de ancho (y a lo más la mitad de alto) y se devuelve un PNG en data URL.
  // Sin trazos devuelve ''. En Node el lienzo es inyectable con TC._canvas = (ancho, alto) => lienzo.
  const MARGEN_FIRMA = 6;
  function lienzoNuevo(w, h) {
    if (typeof API._canvas === 'function') return API._canvas(w, h);
    if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    throw new Error('trazoAPng necesita un lienzo (document o TC._canvas)');
  }

  function trazoAPng(trazos, ancho) {
    const puntos = [];
    for (const t of trazos || []) for (const p of t || []) puntos.push(p);
    if (!puntos.length) return '';
    const W = Math.max(40, Math.round(Number(ancho) || 0));
    const xs = puntos.map((p) => p.x), ys = puntos.map((p) => p.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const bw = (Math.max(...xs) - x0) || 1, bh = (Math.max(...ys) - y0) || 1; // sin extensión (punto, línea recta) no se divide por 0
    const m = MARGEN_FIRMA;
    const k = Math.min((W - 2 * m) / bw, (W / 2 - 2 * m) / bh);
    const w = Math.max(2 * m + 1, Math.ceil(bw * k + 2 * m)), h = Math.max(2 * m + 1, Math.ceil(bh * k + 2 * m));
    const c = lienzoNuevo(w, h);
    const ctx = c.getContext('2d');
    const gx = (p) => (p.x - x0) * k + m, gy = (p) => (p.y - y0) * k + m;
    ctx.lineWidth = Math.max(2, W / 150);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    for (const t of trazos) {
      if (!t || !t.length) continue;
      ctx.beginPath();
      ctx.moveTo(gx(t[0]), gy(t[0]));
      if (t.length === 1) ctx.lineTo(gx(t[0]) + 0.01, gy(t[0])); // punto suelto: con trazo redondo deja una marca
      for (let i = 1; i < t.length; i++) ctx.lineTo(gx(t[i]), gy(t[i]));
      ctx.stroke();
    }
    return c.toDataURL('image/png');
  }

  const API = { CONCLUSION_BASE, DESARROLLO_DEFECTO, NOTA_LEGAL, PIE, DOC_META, mpa, resumenEnsayo, conclusionBase, correoVisita, correoEnsayo, participantesVista, mezclarParticipantes, validarAsistencia, trazoAPng };
  if (typeof window !== 'undefined') g.TC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
