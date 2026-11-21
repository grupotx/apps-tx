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

  // ── Corrección de registros propios ──
  // Solo el autor o un administrador corrige un registro (la base lo exige igual con un trigger).
  const puedeEditar = (r, me) => !!(me && r && (me.admin || (r.autor != null && r.autor === me.id)));

  // Huella de la corrección: quién y cuándo. No muta los datos originales.
  const marcarEdicion = (datos, por, ts) => ({ ...(datos || {}), editado: { ts, por } });

  // Fotos de una visita al corregirla: las que ya tenía más las nuevas, sin repetir.
  const fotosEditadas = (existentes, nuevas) => [...new Set([...(existentes || []), ...(nuevas || [])])];

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

  // ── QR de asistencia ──
  const ASISTENCIA_URL = 'https://apps.grouptx.app/terreno-asistencia.html';
  const enlaceAsistencia = (token) => ASISTENCIA_URL + '?t=' + encodeURIComponent(token);
  // La base genera el token como 32 caracteres hexadecimales; cualquier otra cosa no merece ni una consulta.
  const tokenValido = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/i.test(t);
  const esPngFirma = (f) => typeof f === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(f);

  // Una actividad con la asistencia abierta es un borrador "en curso": no cuenta en las cifras del panel.
  const esBorrador = (r) => !!(r && r.asistencia_abierta);
  const sinBorradores = (registros) => (registros || []).filter((r) => !esBorrador(r));
  const ordenarRegistros = (registros) => [...(registros || []).filter(esBorrador), ...sinBorradores(registros)];
  // Las filas de la tabla mandan; sin ellas, los participantes que traía el registro viejo.
  const totalParticipantes = (r) => (r && r.nAsistencias > 0 ? r.nAsistencias : ((r && r.participantes) || []).length);

  // Conteo embebido de PostgREST (rt_asistencias(count)): se lee de forma tolerante; si no viene, 0. Un conteo en 0 o
  // desconocido nunca debe ocultar la lista de participantes (la fuente de verdad son las filas).
  function conteoAsistencias(x) {
    const v = Array.isArray(x) ? (x[0] && typeof x[0] === 'object' ? x[0].count : x[0]) : (x && typeof x === 'object' ? x.count : x);
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  // Qué hacer en la base con la lista que el PM tiene en pantalla.
  // filas: { id, origenFila: 'tabla' | 'viejo' | 'nuevo', sucia, rut, nombre, cargo, email, fono, firma }
  // 'viejo' = viene de datos.participantes de un registro anterior. Si el PM no toca esa lista se deja como está (así
  // no se pierde el "firmó" sin imagen); si la toca, pasa entera a la tabla y datos.participantes deja de leerse.
  function planParticipantes(filas, { quitados = [], viejo = false } = {}) {
    const llena = (f) => !!(String(f.rut || '').trim() || String(f.nombre || '').trim());
    const lista = filas || [];
    if (viejo) {
      const cambio = quitados.length > 0 || lista.some((f) => (f.origenFila === 'viejo' ? f.sucia : llena(f)));
      return cambio ? { insertar: lista.filter(llena), actualizar: [], borrar: [], migrar: true }
        : { insertar: [], actualizar: [], borrar: [], migrar: false };
    }
    return {
      insertar: lista.filter((f) => f.origenFila === 'nuevo' && llena(f)),
      actualizar: lista.filter((f) => f.origenFila === 'tabla' && f.sucia && llena(f)),
      borrar: [...new Set([...quitados, ...lista.filter((f) => f.origenFila === 'tabla' && !llena(f)).map((f) => f.id)])],
      migrar: false,
    };
  }

  // Ids que llegaron en un refresco y todavía no están en pantalla (ni los quitó el PM).
  const llegadasNuevas = (ids, enPantalla, quitados) => {
    const ya = new Set([...(enPantalla || []), ...(quitados || [])]);
    return (ids || []).filter((id) => !ya.has(id));
  };

  // Traduce la respuesta de rt_asistencia_agregar a algo que lea un participante. La base solo da dos textos
  // (ya registrado / enlace no válido o cerrado) a propósito; todo lo demás es una falla de red o del servicio.
  function mensajeAsistencia(error) {
    const m = String((error && error.message) || '');
    if (/ya estás registrado/i.test(m)) return { tipo: 'duplicado', texto: 'Ya estás registrado en esta actividad. No necesitas ingresar de nuevo.' };
    if (/enlace no válido/i.test(m)) return { tipo: 'cerrado', texto: 'Este enlace ya no recibe registros: la actividad terminó, el enlace no es válido o se completó el cupo. Consulta con quien dirige la actividad.' };
    return { tipo: 'red', texto: 'No pudimos enviar tus datos. Revisa tu conexión e inténtalo de nuevo; lo que escribiste sigue aquí.' };
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

  // ── Cierre con el cliente e informe de la visita ──
  // El informe reusa el marco institucional (logo, banda, nota legal) pero NO la identidad del documento controlado
  // de adherencia: no lleva código, versión ni fecha de creación.
  const MAX_FOTOS = 8;
  const LIMITE_ENVIO_BYTES = 8 * 1024 * 1024;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Cuántas fotos nuevas caben contando las que la visita ya tiene.
  function cupoFotos(existentes, elegidas) {
    const hay = Math.max(0, Number(existentes) || 0), n = Math.max(0, Number(elegidas) || 0);
    const admitidas = Math.min(n, Math.max(0, MAX_FOTOS - hay));
    return { admitidas, sobran: n - admitidas };
  }

  // Datos de quien recibe al cierre. Sin nada escrito ni firmado devuelve null (no se guarda `cierre`).
  function cierreVisita(c) {
    const x = c || {};
    const t = (v) => String(v == null ? '' : v).trim();
    const png = (v) => (esPngFirma(v) ? v : '');
    const r = { nombre: t(x.nombre), cargo: t(x.cargo), email: t(x.email), fono: t(x.fono), firma: png(x.firma), firmaPm: png(x.firmaPm) };
    return Object.values(r).some(Boolean) ? r : null;
  }

  // El correo adjunta el PDF con un tope de 8 MB: el PM debe ver cuánto pesa antes de enviarlo.
  function tamanoInforme(bytes) {
    const n = Number(bytes) || 0;
    const texto = n >= 1024 * 1024 ? (Math.round((n / 1048576) * 10) / 10).toString().replace('.', ',') + ' MB' : Math.round(n / 1024) + ' KB';
    return { texto, excede: n > LIMITE_ENVIO_BYTES };
  }

  function nombreInforme(reg) {
    const r = reg || {};
    const quien = String(r.obra || r.cliente || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    const f = fechaCL(r.fecha);
    return ['Informe visita técnica', quien, f].filter(Boolean).join(' - ') + '.pdf';
  }

  const INF_CSS = '.inf{font-family:Arial,Helvetica,sans-serif;color:#1b1b1b;font-size:12.5px;line-height:1.5;background:#fff;width:100%;padding:0 0 4px}'
    + '.inf *{box-sizing:border-box}'
    + '.inf-banda{display:flex;align-items:center;gap:18px;background:#fff;border-bottom:4px solid #e4032e;padding:6px 0 12px;margin-bottom:16px}'
    + '.inf-logo{width:92px;flex:none;color:#121212}.inf-logo svg{display:block;width:100%;height:auto}'
    + '.inf-tit{flex:1}.inf-tit small{display:block;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#e4032e;font-weight:700}'
    + '.inf-tit h1{margin:2px 0 0;font-size:22px;line-height:1.2;font-weight:800}'
    + '.inf-fecha{text-align:right;font-size:11px;color:#555}.inf-fecha b{display:block;font-size:14px;color:#1b1b1b}'
    + '.inf h2{margin:16px 0 5px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#e4032e;font-weight:800;border-bottom:1px solid #ddd;padding-bottom:3px}'
    + '.inf p{margin:0 0 4px;white-space:pre-wrap}'
    + '.inf-datos{width:100%;border-collapse:collapse}.inf-datos td{padding:4px 8px;border:1px solid #ddd;vertical-align:top}.inf-datos td:nth-child(odd){width:17%;background:#f4f4f2;font-weight:700;font-size:11px;color:#444}.inf-datos td:nth-child(even){width:33%}'
    + '.inf-bloque{break-inside:avoid;page-break-inside:avoid}'
    + '.inf-fila{display:flex;gap:12px;margin-bottom:12px;break-inside:avoid;page-break-inside:avoid}.inf-foto{width:calc(50% - 6px);margin:0}'
    + '.inf-foto img{display:block;width:100%;height:250px;object-fit:contain;border:1px solid #ccc;background:#f4f4f2}.inf-foto figcaption{font-size:11px;color:#555;margin-top:3px}'
    + '.inf-firmas{display:flex;gap:28px;margin-top:10px}.inf-firma{flex:1;break-inside:avoid;page-break-inside:avoid}'
    + '.inf-firma-esp{height:78px;border-bottom:1px solid #1b1b1b;display:flex;align-items:flex-end;justify-content:center}.inf-firma-img{max-width:100%;max-height:74px;object-fit:contain}'
    + '.inf-firma b{display:block;margin-top:4px}.inf-firma span{display:block;font-size:11px;color:#555}'
    + '.inf-legal{margin-top:18px;font-size:9.5px;line-height:1.4;color:#555;text-align:justify;border-top:1px solid #ddd;padding-top:8px}';

  // Tipo real de una imagen según sus primeros bytes (no se confía en el tipo que declare el servidor). null si no es JPEG, PNG ni WebP.
  function tipoImagen(bytes) {
    const b = bytes || [];
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    return null;
  }

  // Las fotos van de a dos por fila; cada fila no se parte entre hojas.
  const filasDeFotos = (fotos) => { const filas = []; fotos.forEach((src, i) => { if (i % 2 === 0) filas.push([]); filas[filas.length - 1].push({ src, n: i + 1 }); }); return filas; };

  // HTML del informe (sin pie de página: el número "Página X de Y" y la dirección los pone el PDF en cada hoja).
  // reg: { cliente, obra, fecha, datos:{…, cierre} }; opciones: { fotos: [data URL], logo: '<svg…>', pm: nombre del PM }.
  function informeVisitaHtml(reg, opciones) {
    const r = reg || {}, d = r.datos || {}, o = opciones || {};
    const cierre = cierreVisita(d.cierre) || {};
    const fotos = (o.fotos || []).filter((f) => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f));
    // Una foto que no calza no se omite en silencio (el cliente notaría el hueco y el PM no): se corta la generación.
    const mala = (o.fotos || []).findIndex((f) => !fotos.includes(f));
    if (mala >= 0) throw new Error('La fotografía ' + (mala + 1) + ' de la visita no se pudo incluir en el informe (formato no válido). Quítala y vuelve a elegirla.');
    const celda = (k, v) => '<td>' + k + '</td><td>' + (v ? esc(v) : '&nbsp;') + '</td>';
    const seccion = (titulo, texto) => (texto && String(texto).trim() ? '<div class="inf-bloque"><h2>' + titulo + '</h2><p>' + esc(String(texto).trim()) + '</p></div>' : '');
    const firma = (png, rol, nombre, detalle) => '<div class="inf-firma"><div class="inf-firma-esp">' + (png ? '<img class="inf-firma-img" alt="Firma" src="' + png + '">' : '') + '</div>'
      + '<b>' + (nombre ? esc(nombre) : '&nbsp;') + '</b><span>' + rol + (detalle ? ' · ' + esc(detalle) : '') + '</span></div>';
    const contacto = [cierre.email, cierre.fono].filter(Boolean).join(' · ');
    return '<div class="inf"><style>' + INF_CSS + '</style>'
      + '<div class="inf-banda"><div class="inf-logo">' + (o.logo || '') + '</div><div class="inf-tit"><small>Grupo TX</small><h1>Informe de Visita Técnica</h1></div>'
      + '<div class="inf-fecha">Fecha de visita<b>' + esc(fechaCL(r.fecha)) + '</b></div></div>'
      + '<div class="inf-bloque"><table class="inf-datos"><tr>' + celda('Cliente', r.cliente) + celda('Obra', r.obra) + '</tr>'
      + '<tr>' + celda('Dirección', d.direccion) + celda('Producto', d.producto) + '</tr>'
      + '<tr>' + celda('Contacto en obra', d.contacto) + celda('Visita realizada por', o.pm) + '</tr></table></div>'
      + seccion('Motivo del reclamo', d.motivo)
      + seccion('Verificación en terreno', d.verificacion)
      + seccion('Causa probable', d.causa)
      + seccion('Solución propuesta', d.solucion)
      + (d.lab === 'Sí' ? seccion('Ensayo de laboratorio', 'Se requiere ensayo en laboratorio.') : '')
      + seccion('Observaciones', d.observaciones)
      + (fotos.length ? '<h2>Registro fotográfico</h2>' + filasDeFotos(fotos).map((fila) => '<div class="inf-fila">' + fila.map((f) => '<figure class="inf-foto"><img alt="Fotografía ' + (f.n) + '" src="' + f.src + '"><figcaption>Fotografía ' + f.n + ' de ' + fotos.length + '</figcaption></figure>').join('') + '</div>').join('') : '')
      + '<div class="inf-bloque"><h2>Cierre de la visita</h2><div class="inf-firmas">'
      + firma(cierre.firmaPm, 'Grupo TX', o.pm, 'Product Manager')
      + firma(cierre.firma, 'Recibe', cierre.nombre, cierre.cargo || contacto ? [cierre.cargo, contacto].filter(Boolean).join(' · ') : '')
      + '</div></div>'
      + '<div class="inf-legal inf-bloque">' + esc(NOTA_LEGAL) + '</div></div>';
  }

  // ── Envío de la copia al cliente ──
  // Misma regla que valida el Apps Script: una sola dirección, sin espacios, comas, saltos de línea ni segundo @.
  const correoValido = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/.test(s);

  // ¿Este informe puede salir hacia esta visita? Exige la identidad (registroId) Y la huella del contenido: "Ver informe"
  // de la lista deja en memoria el informe de OTRA visita, y el de una visita editada después queda desactualizado.
  // ref: { id, huella } de la visita que se va a enviar. Un id nulo (visita sin guardar) nunca vale como identidad.
  function puedeEnviar(informe, ref) {
    const i = informe || {}, r = ref || {};
    if (!i.base64 || typeof i.base64 !== 'string' || !/\.pdf$/i.test(i.nombre || '')) return { ok: false, motivo: 'sin_informe' };
    if (!r.id || i.registroId == null) return { ok: false, motivo: 'sin_guardar' };
    if (i.registroId !== r.id) return { ok: false, motivo: 'otra_visita' };
    if (i.huella !== r.huella) return { ok: false, motivo: 'desactualizado' };
    return { ok: true };
  }

  const TEXTOS_ENVIO = {
    pendiente_publicar: 'el envío de correos todavía no está publicado',
    sin_informe: 'no hay un informe PDF válido para adjuntar',
    sin_guardar: 'la visita aún no está guardada',
    otra_visita: 'el informe generado corresponde a otra visita',
    desactualizado: 'el informe no corresponde a lo que hay ahora en la visita',
    demasiado_grande: 'el informe supera los 8 MB que admite el envío por correo: reduce las fotos',
    solicitud_invalida: 'el pedido de envío está incompleto',
    archivo_invalido: 'el adjunto no es un PDF válido',
    correo_invalido: 'el correo del cliente no es válido',
    correo_no_coincide: 'el correo del cliente guardado en la visita es otro: guarda la visita de nuevo',
    sin_acceso: 'tu cuenta no tiene acceso a Registro de Terreno',
    no_es_autor: 'solo el autor de la visita o un administrador puede enviarla',
    registro_no_existe: 'la visita no está guardada',
    no_autorizado: 'tu sesión expiró: vuelve a ingresar',
    red: 'no hubo conexión con el servicio de correo (si no estás seguro, revisa tu bandeja: recibirás una copia si salió)',
  };
  function textoErrorEnvio(codigo, detalle) {
    if (codigo === 'apps_script') return 'el servicio de correo respondió un error' + (detalle ? ': ' + detalle : '');
    return TEXTOS_ENVIO[codigo] || 'error inesperado' + (codigo ? ' (' + codigo + ')' : '');
  }

  // Historial de envíos en datos.envios: [{ ts, para, asunto, por }]. Devuelve datos nuevos; no toca el original.
  const registrarEnvio = (datos, envio) => ({ ...(datos || {}), envios: [...((datos && datos.envios) || []), { ts: envio.ts, para: envio.para, asunto: envio.asunto, por: envio.por }] });

  // "20-11-2026 12:30" en hora de Chile (no la del equipo).
  function fechaHoraCL(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = Object.fromEntries(new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return p.day + '-' + p.month + '-' + p.year + ' ' + p.hour + ':' + p.minute;
  }

  // Línea visible en la ficha: a quién y cuándo salió el último envío. Si la visita se corrigió después, lo dice.
  function lineaEnvio(datos) {
    const envios = (datos && datos.envios) || [];
    if (!envios.length) return '';
    const e = envios[envios.length - 1];
    const corregida = datos.editado && datos.editado.ts && new Date(datos.editado.ts) > new Date(e.ts);
    return 'Copia enviada a ' + e.para + ' el ' + fechaHoraCL(e.ts) + (corregida ? ' · la visita se corrigió después del envío' : '');
  }

  // Texto del botón de envío en la ficha, o null si la visita no tiene un correo de cliente válido.
  function botonEnvio(datos) {
    const d = datos || {};
    if (!correoValido(d.cierre && d.cierre.email)) return null;
    return (d.envios || []).length ? 'Reenviar copia' : 'Reintentar envío';
  }

  const API = { CONCLUSION_BASE, DESARROLLO_DEFECTO, NOTA_LEGAL, PIE, DOC_META, mpa, resumenEnsayo, conclusionBase, correoVisita, correoEnsayo, participantesVista, mezclarParticipantes, puedeEditar, marcarEdicion, fotosEditadas, validarAsistencia, trazoAPng, ASISTENCIA_URL, enlaceAsistencia, tokenValido, esPngFirma, esBorrador, sinBorradores, ordenarRegistros, totalParticipantes, planParticipantes, llegadasNuevas, mensajeAsistencia, conteoAsistencias, MAX_FOTOS, LIMITE_ENVIO_BYTES, cupoFotos, tipoImagen, cierreVisita, tamanoInforme, nombreInforme, informeVisitaHtml, correoValido, puedeEnviar, textoErrorEnvio, registrarEnvio, fechaHoraCL, lineaEnvio, botonEnvio };
  if (typeof window !== 'undefined') g.TC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
