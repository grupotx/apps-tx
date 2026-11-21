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

  // El MPa de una fila: el escrito a mano si lo hay (manual), si no el calculado; null si no alcanza para ninguno.
  const mpaDeFila = mpaFila;
  const esManual = (f) => Number.isFinite(num(f && f.mpa));

  // Número escrito por el PM: acepta coma o punto decimal ("2,772" o "2.772") y "1.234,5". Cualquier otra cosa es null
  // (nunca 0: un texto que no es número no puede pasar por resultado).
  function numero(s) {
    if (s == null) return null;
    let t = String(s).trim().replace(/\s/g, '');
    if (!t) return null;
    if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const fmtNum = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : String(v).replace('.', ','));
  const fmtMpa = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : Number(v).toFixed(2).replace('.', ','));

  // Filas del formulario (texto tal como lo escribió el PM) → filas que se guardan. Una fila sin sustrato, carga, MPa ni
  // falla es una fila en blanco y se descarta; el resto se numera de corrido. El MPa solo se guarda si lo escribió el
  // PM (manual): el calculado se recalcula siempre desde la carga y el área, así no queda un valor viejo.
  const filaEnBlanco = (c) => ![c.sustrato, c.carga, c.mpa, c.falla].some((v) => String(v == null ? '' : v).trim());
  function normalizarFilas(crudas) {
    const t = (v) => String(v == null ? '' : v).trim();
    const filas = [];
    for (const c of crudas || []) {
      if (filaEnBlanco(c)) continue;
      const f = { n: filas.length + 1, sustrato: t(c.sustrato), cargaKn: numero(c.carga), anchoMm: numero(c.ancho), altoMm: numero(c.alto), falla: t(c.falla) };
      const m = numero(c.mpa);
      if (m != null) f.mpa = m;
      filas.push(f);
    }
    return filas;
  }

  // Lo mínimo para poder emitir el informe. Devuelve el texto del problema o '' si está bien.
  function validarEnsayo(d, filas) {
    const x = d || {};
    if (!x.fecha) return 'Falta la fecha de la visita';
    if (!String(x.cliente || '').trim()) return 'Indica la constructora (cliente)';
    if (!(filas || []).length) return 'Agrega al menos una extracción con su resultado';
    const sin = filas.find((f) => mpaFila(f) == null);
    if (sin) return 'La fila ' + sin.n + ' no tiene resultado: escribe la carga y el área del corte, o el MPa que entregó el laboratorio';
    if (!String(x.firm_nombre || '').trim()) return 'Falta el nombre del firmante';
    return '';
  }

  // Lo que se guarda en registros.datos de un ensayo. Se usa igual para guardar que para armar el informe: lo que se ve es lo que se guarda.
  function datosEnsayo(d, filasCrudas, pies) {
    const t = (v) => String(v == null ? '' : v).trim();
    return {
      direccion: t(d.direccion), contacto: t(d.contacto), producto: t(d.producto), motivo_visita: t(d.motivo_visita),
      correo_cliente: t(d.correo_cliente), desarrollo: t(d.desarrollo), filas: normalizarFilas(filasCrudas),
      pies: (pies || []).map(t), conclusion: t(d.conclusion),
      firmante: { nombre: t(d.firm_nombre), cargo: t(d.firm_cargo), movil: t(d.firm_movil), correo: t(d.firm_correo) },
    };
  }

  // Firmante del informe: lo del usuario conectado, y manda lo que el equipo recuerda de la vez anterior.
  const CARGO_FIRMANTE = 'Asesor Técnico';
  function firmanteInicial(yo, guardado) {
    const g = guardado || {}, u = yo || {};
    const v = (k, otro) => (typeof g[k] === 'string' && g[k].trim() ? g[k].trim() : otro);
    return { nombre: v('nombre', u.nombre || ''), cargo: v('cargo', CARGO_FIRMANTE), movil: v('movil', ''), correo: v('correo', u.email || '') };
  }

  // Encabezado que se dibuja en cada hoja del informe de adherencia (documento controlado DOC-PM-LAB-05).
  const encabezadoInforme = (pagina, total) => ({
    titulo: DOC_META.titulo,
    detalle: 'Código ' + DOC_META.codigo + ' · Creación ' + DOC_META.creacion + ' · Versión ' + DOC_META.version,
    pagina: 'Página ' + pagina + ' de ' + total,
  });

  // ── Correos al cliente ──
  // El cuerpo es editable en la confirmación del envío. El servidor (validarSolicitud en correo.ts) exige que siga
  // nombrando al cliente y la obra; esta es la misma regla aplicada antes de enviar, con texto para el PM.
  // Devuelve '' si está bien, o el motivo.
  function validarCuerpoCorreo(cuerpo, ref) {
    const c = typeof cuerpo === 'string' ? cuerpo : '', r = ref || {};
    if (!c.trim()) return 'El mensaje no puede quedar vacío.';
    if (c.length > 20000) return 'El mensaje es demasiado largo: acórtalo.';
    if (r.cliente && !c.includes(r.cliente)) return 'El mensaje debe seguir nombrando al cliente («' + r.cliente + '»).';
    if (r.obra && !c.includes(r.obra)) return 'El mensaje debe seguir nombrando la obra («' + r.obra + '»).';
    return '';
  }
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
      + (n ? 'Se ensayaron ' + n + ' probeta' + (n === 1 ? '' : 's') + (r.min != null ? ', con resultados entre ' + fmtMpa(r.min) + ' y ' + fmtMpa(r.max) + ' MPa.\n' : '.\n') : '')
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
    if (/enlace no válido/i.test(m)) return { tipo: 'cerrado', texto: 'Este enlace ya no recibe registros: la actividad terminó, el enlace no es válido, pasaron más de 48 horas desde que se generó el QR o se completó el cupo. Si la actividad sigue en curso, pide a quien la dirige que genere el QR de nuevo.' };
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
    return [r.kind === 'adherencia' ? 'Informe prueba adherencia' : 'Informe visita técnica', quien, f].filter(Boolean).join(' - ') + '.pdf';
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
    + '.inf-legal{margin-top:18px;font-size:9.5px;line-height:1.4;color:#555;text-align:left;border-top:1px solid #ddd;padding-top:8px;padding-right:6pt}';

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

  // Las fotos del informe: una que no calza no se omite en silencio (el cliente notaría el hueco y el PM no): se corta la generación.
  function fotosDelInforme(lista, de) {
    const fotos = (lista || []).filter((f) => /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f));
    const mala = (lista || []).findIndex((f) => !fotos.includes(f));
    if (mala >= 0) throw new Error('La fotografía ' + (mala + 1) + ' ' + de + ' no se pudo incluir en el informe (formato no válido). Quítala y vuelve a elegirla.');
    return fotos;
  }

  // HTML del informe (sin pie de página: el número "Página X de Y" y la dirección los pone el PDF en cada hoja).
  // reg: { cliente, obra, fecha, datos:{…, cierre} }; opciones: { fotos: [data URL], logo: '<svg…>', pm: nombre del PM }.
  function informeVisitaHtml(reg, opciones) {
    const r = reg || {}, d = r.datos || {}, o = opciones || {};
    const cierre = cierreVisita(d.cierre) || {};
    const fotos = fotosDelInforme(o.fotos, 'de la visita');
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


  // Dibuja el encabezado del documento controlado en la hoja `i` de `n` (pdf: jsPDF; margen: [arriba, derecha, abajo, izquierda]).
  function dibujarEncabezado(pdf, i, n, margen) {
    const W = pdf.internal.pageSize.getWidth(), h = encabezadoInforme(i, n);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(12); pdf.setTextColor(27);
    pdf.text(h.titulo, margen[3], 36);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(90);
    pdf.text(h.detalle, W - margen[1], 30, { align: 'right' });
    pdf.text(h.pagina, W - margen[1], 42, { align: 'right' });
    pdf.setDrawColor(228, 3, 46); pdf.setLineWidth(1.2); pdf.line(margen[3], 50, W - margen[1], 50);
  }

  // ── Informe de adherencia (DOC-PM-LAB-05) ──
  // Las secciones del documento original: I. Descripción, Desarrollo, Resultados, Imágenes, Conclusión, firma del asesor y
  // nota legal. El encabezado con el código y "Página X de Y" y el pie los dibuja el PDF en cada hoja (encabezadoInforme).
  // No dictamina: los indicadores de apoyo (mínimo, máximo, promedio, filas bajo 0,20 MPa) son solo de la pantalla.
  const WEB = 'www.grupotx.cl';
  const INF_CSS_ADH = '.inf-desc{width:100%;border-collapse:collapse}.inf-desc td{padding:4px 8px;border:1px solid #ddd;vertical-align:top}.inf-desc td:first-child{width:24%;background:#f4f4f2;font-weight:700;font-size:11px;color:#444}'
    + '.inf-resultados{width:100%;border-collapse:collapse;font-size:11.5px}.inf-resultados th{background:#f4f4f2;border:1px solid #ddd;padding:4px 6px;text-align:left;font-size:10.5px;color:#444}.inf-resultados td{border:1px solid #ddd;padding:4px 6px;vertical-align:top}'
    + '.inf-resultados .inf-n{width:6%;text-align:center}.inf-resultados .inf-num{text-align:right;white-space:nowrap}.inf-resultados .inf-mpa{text-align:right;white-space:nowrap;font-weight:700}'
    + '.inf-res{break-inside:avoid;page-break-inside:avoid}.inf-nota{margin-top:4px;font-size:10.5px;color:#555}'
    + '.inf-atte{margin-top:22px}.inf-atte p{margin:0}.inf-atte .inf-atte-nombre{margin-top:26px}';

  function informeAdherenciaHtml(reg, opciones) {
    const r = reg || {}, d = r.datos || {}, o = opciones || {};
    const fotos = fotosDelInforme(o.fotos, 'del informe');
    const filas = d.filas || [];
    const f = d.firmante || {};
    const fila = (k, v) => '<tr><td>' + k + '</td><td>' + (v ? esc(v) : '&nbsp;') + '</td></tr>';
    const seccion = (titulo, texto) => (texto && String(texto).trim() ? '<div class="inf-bloque"><h2>' + titulo + '</h2><p>' + esc(String(texto).trim()) + '</p></div>' : '');
    const hayManual = filas.some(esManual);
    const filaRes = (x) => '<tr class="inf-res"><td class="inf-n">' + esc(x.n) + '</td><td>' + esc(x.sustrato || '') + '</td>'
      + '<td class="inf-num">' + esc(fmtNum(x.cargaKn)) + '</td>'
      + '<td class="inf-num">' + (x.anchoMm && x.altoMm ? esc(fmtNum(x.anchoMm)) + ' x ' + esc(fmtNum(x.altoMm)) : '') + '</td>'
      + '<td class="inf-mpa">' + esc(fmtMpa(mpaFila(x))) + (esManual(x) ? ' *' : '') + '</td><td>' + esc(x.falla || '') + '</td></tr>';
    const linea = (k, v) => (v && String(v).trim() ? '<p>' + k + ' : ' + esc(String(v).trim()) + '</p>' : '');
    return '<div class="inf"><style>' + INF_CSS + INF_CSS_ADH + '</style>'
      + '<div class="inf-banda"><div class="inf-logo">' + (o.logo || '') + '</div></div>'
      + '<div class="inf-bloque"><h2>I. Descripción</h2><table class="inf-desc">'
      + fila('Constructora', r.cliente) + fila('Obra', r.obra) + fila('Dirección', d.direccion) + fila('Contacto', d.contacto)
      + fila('Producto', d.producto) + fila('Motivo de visita', d.motivo_visita) + fila('Fecha de visita', fechaCL(r.fecha)) + '</table></div>'
      + seccion('Desarrollo', d.desarrollo)
      + (filas.length ? '<div class="inf-bloque"><h2>Resultados</h2><table class="inf-resultados"><thead><tr><th class="inf-n">N°</th><th>Sustrato o ubicación</th><th>Carga (kN)</th><th>Área del corte (mm)</th><th>Adherencia (MPa)</th><th>Tipo de falla</th></tr></thead><tbody>'
        + filas.map(filaRes).join('') + '</tbody></table>'
        + (hayManual ? '<p class="inf-nota">* Valor de adherencia informado, no calculado a partir de la carga y el área del corte.</p>' : '') + '</div>' : '')
      + (fotos.length ? '<h2>Imágenes</h2>' + filasDeFotos(fotos).map((fi) => '<div class="inf-fila">' + fi.map((x) => {
        const pie = (d.pies || [])[x.n - 1];
        return '<figure class="inf-foto"><img alt="Imagen ' + x.n + '" src="' + x.src + '">' + (pie && String(pie).trim() ? '<figcaption>' + esc(String(pie).trim()) + '</figcaption>' : '') + '</figure>';
      }).join('') + '</div>').join('') : '')
      + seccion('Conclusión', d.conclusion)
      + '<div class="inf-bloque inf-atte"><p>Atentamente</p><p class="inf-atte-nombre"><b>' + (f.nombre ? esc(f.nombre) : '&nbsp;') + '</b></p>'
      + (f.cargo ? '<p>' + esc(f.cargo) + '</p>' : '') + linea('Móvil', f.movil) + linea('Mail', f.correo) + '<p>Web : ' + WEB + '</p></div>'
      + '<div class="inf-legal inf-bloque">' + esc(NOTA_LEGAL) + '</div></div>';
  }

  // ── Envío de la copia al cliente ──
  // Misma regla que valida el Apps Script: una sola dirección, sin espacios, comas, saltos de línea ni segundo @.
  // Reglas del correo que existen en más de un runtime y deben cambiar juntas: la dirección (correoValido aquí,
  // correo.ts de la función terreno-correo y lib.js del Apps Script) y el asunto (tope de 200 caracteres en correo.ts
  // y lib.js; patrón 'Visita técnica <obra> – <fecha>' en correoVisita/correoEnsayo y PREFIJO_ASUNTO de correo.ts).
  // tests/correo-contrato.test.ts ata la salida real de correoVisita/correoEnsayo con validarSolicitud.
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
    mensaje_no_corresponde: 'el mensaje no corresponde a esta visita (debe nombrar al cliente y la obra); si cambió el cliente o la obra desde otra sesión, recarga la página o vuelve a guardar la visita',
    asunto_largo: 'el nombre de la obra es demasiado largo para el asunto del correo: acórtalo',
    correo_invalido: 'el correo del cliente no es válido',
    correo_no_coincide: 'el correo del cliente guardado en la visita es otro: guarda la visita de nuevo',
    sin_acceso: 'tu cuenta no tiene acceso a Registro de Terreno',
    no_es_autor: 'solo el autor de la visita o un administrador puede enviarla',
    registro_no_existe: 'la visita no está guardada',
    no_autorizado: 'tu sesión expiró: vuelve a ingresar',
    red: 'no hubo conexión con el servicio de correo (si no estás seguro, revisa tu bandeja: recibirás una copia si salió)',
  };
  // Lo que cambia cuando el registro es un ensayo de adherencia en vez de una visita.
  const TEXTOS_ENVIO_ENSAYO = {
    sin_guardar: 'el ensayo aún no está guardado',
    otra_visita: 'el informe generado corresponde a otro ensayo',
    desactualizado: 'el informe no corresponde a lo que hay ahora en el ensayo',
    mensaje_no_corresponde: 'el mensaje no corresponde a este ensayo (debe nombrar al cliente y la obra); si cambió el cliente o la obra desde otra sesión, recarga la página o vuelve a guardar el ensayo',
    correo_no_coincide: 'el correo del cliente guardado en el ensayo es otro: guarda el ensayo de nuevo',
    no_es_autor: 'solo el autor del ensayo o un administrador puede enviarlo',
    registro_no_existe: 'el ensayo no está guardado',
  };
  function textoErrorEnvio(codigo, detalle, kind) {
    if (codigo === 'apps_script') return 'el servicio de correo respondió un error' + (detalle ? ': ' + detalle : '');
    if (kind === 'adherencia' && TEXTOS_ENVIO_ENSAYO[codigo]) return TEXTOS_ENVIO_ENSAYO[codigo];
    return TEXTOS_ENVIO[codigo] || 'error inesperado' + (codigo ? ' (' + codigo + ')' : '');
  }

  // Historial de envíos en datos.envios: [{ ts, para, asunto, por }]. Devuelve datos nuevos; no toca el original.
  const registrarEnvio = (datos, envio) => ({ ...(datos || {}), envios: [...((datos && datos.envios) || []), { ts: envio.ts, para: envio.para, asunto: envio.asunto, por: envio.por, ...(envio.estado ? { estado: envio.estado } : {}) }] });

  // Cambia el estado del intento `ts` ('enviando' | 'dudoso' | 'enviada'); con estado null lo quita (el correo seguro no salió).
  // Sin `estado` un envío cuenta como enviado (registros anteriores a esta versión).
  const resolverEnvio = (datos, ts, estado, extra) => ({ ...(datos || {}), envios: ((datos && datos.envios) || []).flatMap((e) => (e.ts !== ts ? [e] : estado ? [{ ...e, estado, ...(extra || {}) }] : [])) });

  // Errores tras los cuales el correo seguro NO salió (se rechazó antes de llegar al Apps Script). 'red' y 'apps_script' son dudosos.
  const NO_SALIO = ['pendiente_publicar', 'sin_informe', 'sin_guardar', 'otra_visita', 'desactualizado', 'demasiado_grande', 'solicitud_invalida', 'archivo_invalido', 'correo_invalido', 'correo_no_coincide', 'mensaje_no_corresponde', 'asunto_largo', 'sin_acceso', 'no_es_autor', 'registro_no_existe', 'no_autorizado'];
  const envioNoSalio = (codigo) => NO_SALIO.includes(codigo);

  // Último intento vigente: los marcados 'no_salio' quedan en el historial pero ya no cuentan para el estado actual.
  const ultimoEnvio = (datos) => { const e = ((datos && datos.envios) || []).filter((x) => x.estado !== 'no_salio'); return e.length ? e[e.length - 1] : null; };
  // ¿El último intento quedó sin confirmar (en curso o dudoso)? Entonces el cliente PUEDE tener ya la copia.
  const envioDudoso = (datos) => { const e = ultimoEnvio(datos); return !!e && (e.estado === 'enviando' || e.estado === 'dudoso'); };

  // "20-11-2026 12:30" en hora de Chile (no la del equipo).
  function fechaHoraCL(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = Object.fromEntries(new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
    return p.day + '-' + p.month + '-' + p.year + ' ' + p.hour + ':' + p.minute;
  }

  // Línea visible en la ficha: a quién y cuándo salió el último envío. Si la visita se corrigió después, lo dice.
  function lineaEnvio(datos) {
    const e = ultimoEnvio(datos);
    if (!e) return '';
    if (envioDudoso(datos)) return 'Envío a ' + e.para + ' el ' + fechaHoraCL(e.ts) + ' sin confirmar: puede haber salido (revisa tu bandeja: recibirías una copia)';
    const conf = e.resueltoPor ? ' · confirmado por ' + e.resueltoPor : '';
    const corregida = datos.editado && datos.editado.ts && new Date(datos.editado.ts) > new Date(e.ts);
    return 'Copia enviada a ' + e.para + ' el ' + fechaHoraCL(e.ts) + conf + (corregida ? ' · la visita se corrigió después del envío' : '');
  }

  // El PM comprueba su bandeja (recibe copia de cada correo) y resuelve el último intento sin confirmar:
  // 'llego' lo deja enviado (conserva su fecha) y 'no_salio' lo marca como no salido; los dos anotan quién y cuándo. Nunca se borra el intento. Solo actúa si el último
  // intento está dudoso o en curso: un envío ya confirmado no se puede "des-enviar".
  function resolverDudoso(datos, resultado, por, ts) {
    if (resultado !== 'llego' && resultado !== 'no_salio') throw new Error('resultado inválido: ' + resultado);
    if (!envioDudoso(datos)) return datos;
    const e = ultimoEnvio(datos);
    return resolverEnvio(datos, e.ts, resultado === 'llego' ? 'enviada' : 'no_salio', { resueltoPor: por, resueltoEn: ts });
  }

  // Intentos marcados como "no salió" por el PM: quedan a la vista en la ficha (el registro de envíos es evidencia).
  const historialNoSalio = (datos) => ((datos && datos.envios) || []).filter((e) => e.estado === 'no_salio')
    .map((e) => 'Intento del ' + fechaHoraCL(e.ts) + ' a ' + e.para + ' marcado como no salido por ' + (e.resueltoPor || '—') + (e.resueltoEn ? ' el ' + fechaHoraCL(e.resueltoEn) : ''));

  // Correo al que va la copia: el de quien recibe la visita (cierre) o el que se escribió en el ensayo de adherencia.
  const correoCliente = (kind, datos) => (kind === 'adherencia' ? (datos && datos.correo_cliente) : (datos && datos.cierre && datos.cierre.email)) || '';

  // Texto del botón de envío en la ficha, o null si el registro no tiene un correo de cliente válido.
  function botonEnvio(datos, kind) {
    const d = datos || {};
    if (!correoValido(correoCliente(kind, d))) return null;
    if (envioDudoso(d)) return 'Reenviar (puede duplicar el correo)';
    return ultimoEnvio(d) ? 'Reenviar copia' : 'Reintentar envío';
  }

  const API = { CONCLUSION_BASE, DESARROLLO_DEFECTO, NOTA_LEGAL, PIE, DOC_META, mpa, mpaDeFila, esManual, numero, fmtNum, fmtMpa, filaEnBlanco, normalizarFilas, validarEnsayo, datosEnsayo, firmanteInicial, encabezadoInforme, dibujarEncabezado, informeAdherenciaHtml, correoCliente, resumenEnsayo, conclusionBase, correoVisita, correoEnsayo, validarCuerpoCorreo, participantesVista, mezclarParticipantes, puedeEditar, marcarEdicion, fotosEditadas, validarAsistencia, trazoAPng, ASISTENCIA_URL, enlaceAsistencia, tokenValido, esPngFirma, esBorrador, sinBorradores, ordenarRegistros, totalParticipantes, planParticipantes, llegadasNuevas, mensajeAsistencia, conteoAsistencias, MAX_FOTOS, LIMITE_ENVIO_BYTES, cupoFotos, tipoImagen, cierreVisita, tamanoInforme, nombreInforme, informeVisitaHtml, correoValido, puedeEnviar, textoErrorEnvio, registrarEnvio, resolverEnvio, resolverDudoso, historialNoSalio, envioNoSalio, envioDudoso, fechaHoraCL, lineaEnvio, botonEnvio };
  if (typeof window !== 'undefined') g.TC = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
