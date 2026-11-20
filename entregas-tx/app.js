/* ================== Entregas TX · núcleo + chofer ================== */
const SUPABASE_URL = 'https://xinnonzltoaoptnvkhhy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_DoSRSj0wmAR_UIX8tENXXQ_X5BS5a1q';
const DOMINIO_CHOFER = 'choferes.grupotx.cl';
const RADIO_ALERTA_M = 300;        // distancia máxima esperada entre "Llegué" y el destino
const TRACK_MIN_MS = 60000;        // guardar posición cada 60 s ...
const TRACK_MIN_M = 30;            // ... si se movió al menos 30 m (o 200 m antes)

// global.fetch busca window.fetch en cada llamada (supabase-js lo fija al crear el cliente);
// así una simulación de "sin red" que reemplace window.fetch también afecta a sb.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: (...a) => window.fetch(...a) } });

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
const fechaCL = (iso) => iso ? new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso.length === 10 ? iso + 'T12:00:00' : iso)) : '';
const fechaLarga = (iso) => new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso.length === 10 ? iso + 'T12:00:00' : iso));
const horaCL = (iso) => iso ? new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';
const fechaHoraCL = (iso) => iso ? `${fechaCL(iso)} ${horaCL(iso)}` : '';
const diaCL = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(iso));
const sumarDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const limpiarRut = (r) => (r || '').replace(/[^0-9kK]/g, '').toLowerCase();
const fmtNum = (n) => (Math.round((+n || 0) * 10) / 10).toLocaleString('es-CL');
const fmtM = (m) => m == null ? '—' : (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');
const minutos = (a, b) => (a && b) ? Math.round((new Date(b) - new Date(a)) / 60000) : null;
const iniciales = (n) => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const ESTADOS = { asignada: 'Pendiente', en_destino: 'En destino', entregada: 'Entregada', entregada_con_devolucion: 'Con devolución', rechazada: 'Rechazada', anulada: 'Anulada' };
const EST_CHIP = { asignada: '', en_destino: 'warn', entregada: 'ok', entregada_con_devolucion: 'info', rechazada: 'bad', anulada: 'plain' };
const EST_COLOR = { asignada: 'var(--muted)', en_destino: 'var(--warn)', entregada: 'var(--ok)', entregada_con_devolucion: 'var(--info)', rechazada: 'var(--bad)', anulada: 'var(--muted)' };
const badge = (e) => `<span class="chip ${EST_CHIP[e] ?? ''}">${ESTADOS[e] || esc(e)}</span>`;
const COLORES = ['#e4032e', '#2459a8', '#18864a', '#b86e00', '#7a3fb0', '#0e8a9a', '#5e6066', '#c2185b', '#3d5a1e', '#8a5a2b'];
const ROL_CORTO = { admin: 'Admin', logistica: 'Logística', chofer: 'Chofer', cliente: 'Cliente', pendiente: 'Pendiente' };
function distM(a, b, c, d) { const R = 6371000, r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
const entregaDe = (g) => Array.isArray(g.ent_entregas) ? g.ent_entregas[0] : g.ent_entregas;

/* ---------- íconos (mismo trazo que Silos TX) ---------- */
const ic = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  home: ic('<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  map: ic('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>'),
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  chart: ic('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  x: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
  alert: ic('<path d="M12 3l9.5 17h-19L12 3z"/><path d="M12 10v4M12 17.5v.01"/>'),
  truck: ic('<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  clock: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  doc: ic('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  check: ic('<path d="M4 12l5 5L20 6"/>'),
  pin: ic('<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'),
  download: ic('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  users: ic('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c2 .7 3.2 2.5 3.6 5.2"/>'),
  ret: ic('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  ban: ic('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>'),
  box: ic('<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>'),
  cam: ic('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  list: ic('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  tag: ic('<path d="M3 12V4h8l10 10-8 8L3 12z"/><circle cx="7.5" cy="8.5" r="1.5"/>'),
  phone: ic('<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>'),
  nav: ic('<path d="M3 11l18-8-8 18-2-8-8-2z"/>'),
  bell: ic('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
  factory: ic('<path d="M3 21V10l6 4V10l6 4V6l6-3v18z"/>'),
  upload: ic('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  refresh: ic('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
};

/* ---------- interfaz común (shell al estilo Silos TX) ---------- */
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, m.length > 60 ? 5500 : 3200); }
function banner(m) { const b = $('#banner'); b.textContent = m || ''; b.hidden = !m; }
function errMsg(e) { return (e && (e.message || e.error_description || e.error)) || String(e); }
const fld = (label, inner, req) => `<label class="f"><span>${label}${req ? ' <i>*</i>' : ''}</span>${inner}</label>`;

function openSheet(title, html, opts = {}) {
  closeSheet(true);
  const sh = $('#sheet');
  sh.innerHTML = `<div class="sheet-h"><div>${opts.eyebrow ? `<span class="eyebrow">${opts.eyebrow}</span>` : ''}<h2>${title}</h2></div><button class="xbtn" id="sheet-x" aria-label="Cerrar">${I.x}</button></div>${html}`;
  $('#sheet-bg').hidden = false; document.body.style.overflow = 'hidden';
  $('#sheet-x').onclick = () => (opts.onClose ? opts.onClose() : closeSheet());
  S.sheetClose = opts.onClose || null;
  sh.scrollTop = 0;
  return sh;
}
function closeSheet() {
  if (S.sheetCleanup) { try { S.sheetCleanup(); } catch (e) {} S.sheetCleanup = null; }
  S.sheetClose = null;
  $('#sheet-bg').hidden = true; document.body.style.overflow = '';
}
$('#sheet-bg').addEventListener('click', e => { if (e.target.id === 'sheet-bg') (S.sheetClose ? S.sheetClose() : closeSheet()); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet-bg').hidden) (S.sheetClose ? S.sheetClose() : closeSheet()); });

function pintarLogos() { const l = $('#logo-tpl').innerHTML; $$('[data-logo]').forEach(e => e.innerHTML = l); }

async function traerTodo(fabrica, tam = 1000) {
  let out = [], desde = 0;
  for (;;) {
    const { data, error } = await fabrica().range(desde, desde + tam - 1);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < tam) break;
    desde += tam;
  }
  return out;
}

function descargarCSV(nombre, filas) {
  if (!filas.length) return toast('No hay datos para exportar');
  const cols = Object.keys(filas[0]);
  const q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [cols.join(';'), ...filas.map(f => cols.map(c => q(f[c])).join(';'))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = nombre; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function obtenerPosicion(timeout = 15000) {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Este teléfono no permite geolocalización'));
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(new Error(e.code === 1 ? 'Permiso de ubicación denegado. Actívalo en el navegador (candado junto a la dirección) y vuelve a intentar.' : 'No se pudo obtener la ubicación (' + e.message + '). Sal a un lugar abierto y reintenta.')),
      { enableHighAccuracy: true, timeout, maximumAge: 10000 });
  });
}

async function comprimirImagen(file, max = 1400, calidad = 0.78) {
  let fuente;
  try { fuente = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { fuente = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = URL.createObjectURL(file); }); }
  const w = fuente.width, h = fuente.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(fuente, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(r, 'image/jpeg', calidad));
}

async function urlFirmada(path) {
  if (!path) return '';
  const { data } = await sb.storage.from('entregas').createSignedUrl(path, 3600);
  if (data?.signedUrl) return data.signedUrl;
  // La foto ya no está en Supabase: se pide la copia archivada en Drive
  return window.fotoArchivada ? await fotoArchivada('entregas', path).catch(() => '') : '';
}

/* mapa con el mismo estilo que Silos TX (calles / satélite, modo oscuro) */
function nuevoMapa(el, opts = {}) {
  if (!window.L) { el.innerHTML = '<div class="empty"><b>Mapa no disponible</b>No se pudo cargar el visor de mapas.</div>'; return null; }
  const m = L.map(el, { zoomControl: !opts.mini, minZoom: 4, maxZoom: 19, scrollWheelZoom: !opts.mini });
  m.attributionControl.setPrefix('');
  m.setView(opts.center || [-33.47, -70.65], opts.zoom || 10);
  const calles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'tiles-calles', attribution: '© OpenStreetMap' }).addTo(m);
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imágenes © Esri' });
  if (!opts.mini) {
    const Ctl = L.Control.extend({ onAdd() { const d = L.DomUtil.create('div', 'seg-f map-layers'); d.innerHTML = '<button type="button" aria-pressed="true" data-l="c">Calles</button><button type="button" aria-pressed="false" data-l="s">Satélite</button>';
      L.DomEvent.disableClickPropagation(d);
      d.querySelectorAll('button').forEach(btn => btn.onclick = () => { const s = btn.dataset.l === 's'; if (s) { m.removeLayer(calles); sat.addTo(m); } else { m.removeLayer(sat); calles.addTo(m); } d.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === btn))); });
      return d; } });
    new Ctl({ position: 'topright' }).addTo(m);
  }
  setTimeout(() => m.invalidateSize(), 150);
  return m;
}
const pin = (color, txt = '') => L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="mpin" style="background:${color}">${txt}</div>` });
const pinCamion = () => L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="mtruck">🚚</div>' });

async function geocodificar(direccion, comuna) {
  const q = [direccion, comuna, 'Chile'].filter(Boolean).join(', ');
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=cl&q=' + encodeURIComponent(q), { headers: { 'Accept-Language': 'es' } });
  const j = await r.json();
  return j && j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}

/* ---------- estado y navegación ---------- */
const S = { user: null, perfil: null, view: null, modo: null, productos: [], motivos: [], vehiculos: [], usuarios: [], choferes: [] };
let VIEWS = [];

function construirNav() {
  const btn = (v, bottom) => v.act
    ? `<button class="navbtn cta" data-act="${v.act}" aria-label="${v.label}">${v.icon}${bottom ? '' : `<span>${v.label}</span>`}</button>`
    : `<button class="navbtn" data-view="${v.id}" aria-label="${v.label}">${v.icon}<span>${v.label}</span></button>`;
  const rail = VIEWS.filter(v => !v.act).concat(VIEWS.filter(v => v.act));
  $('#nav-rail').innerHTML = rail.map(v => btn(v, false)).join('');
  $('#nav-bottom').innerHTML = VIEWS.filter(v => v.bottom).sort((a, b) => (a.bo ?? 0) - (b.bo ?? 0)).map(v => btn(v, true)).join('');
  $$('.navbtn[data-view]').forEach(b => b.onclick = () => go(b.dataset.view));
}
function go(v) {
  const def = VIEWS.find(x => x.id === v && x.render) || VIEWS.find(x => x.render);
  S.view = def.id;
  S.gen = (S.gen || 0) + 1;   // las vistas async comparan esto para no pintar encima de otra vista
  clearInterval(S.timer); S.timer = null;
  if (S.mapa) { try { S.mapa.remove(); } catch {} S.mapa = null; }
  $$('.navbtn[data-view]').forEach(b => b.dataset.view === def.id ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  $('#view-title').textContent = def.title;
  $('#top-actions').innerHTML = '';
  try { localStorage.setItem('entregastx.view.' + S.modo, def.id); } catch {}
  const el = $('#view'); el.innerHTML = '<div class="card empty"><b>Cargando…</b></div>';
  window.scrollTo(0, 0);
  def.render(el);
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const a = t.dataset.act;
  if (a === 'nueva-guia' && typeof editarGuia === 'function') editarGuia(null, () => go(S.view));
  if (a === 'go') go(t.dataset.to);
  if (a === 'ver-guia' && typeof verEntrega === 'function') verEntrega(t.dataset.id);
});

function montarShell(modo) {
  S.modo = modo;
  $('#splash').hidden = true; $('#auth').hidden = true; $('#app-shell').hidden = false;
  const p = S.perfil;
  $('#user-chip').innerHTML = `<span class="av">${esc(iniciales(p.nombre))}</span><span class="un"><b>${esc(p.nombre || '')}</b><small>${modo === 'chofer' && p.rol === 'admin' ? 'Vista chofer' : ROL_CORTO[p.rol]}</small></span>`;
  $('#user-chip').onclick = menuUsuario;
  construirNav();
  let v = null; try { v = localStorage.getItem('entregastx.view.' + modo); } catch {}
  go(v);
}

function menuUsuario() {
  const p = S.perfil, staff = ['logistica', 'admin'].includes(p.rol);
  const extra = S.modo === 'staff' ? [
    ['devoluciones', I.ret, 'Devoluciones', 'Motivos y productos devueltos'],
    ['usuarios', I.users, 'Choferes y usuarios', 'Crear choferes, roles y claves'],
    ['catalogos', I.tag, 'Catálogos', 'Productos, motivos y vehículos'],
  ] : [];
  const sh = openSheet(esc(p.nombre || ''), `
    <div class="card" style="padding:14px;display:grid;gap:6px"><div class="sub">${esc(p.email?.endsWith('@' + DOMINIO_CHOFER) ? 'RUT ' + (p.rut || '') : (p.email || ''))}</div><div>Perfil: <b>${ROL_CORTO[p.rol]}</b></div>
      ${S.modo === 'chofer' && S.jornada ? `<div>Patente de la jornada: <b class="mono">${esc(S.jornada.patente)}</b></div>` : ''}</div>
    ${extra.length ? `<div class="menu block">${extra.map(([id, icn, t, s]) => `<button data-ir="${id}">${icn}<span>${t}<small>${s}</small></span></button>`).join('')}</div>` : ''}
    <div class="menu block">
      ${S.modo === 'chofer' && S.jornada ? `<button id="m-pat">${I.truck}<span>Cambiar patente<small>Si cambiaste de camión</small></span></button><button id="m-fin">${I.clock}<span>Terminar jornada<small>Deja de registrar tu ubicación</small></span></button>` : ''}
      ${p.rol === 'admin' && S.modo === 'staff' ? `<button id="m-chofer">${I.truck}<span>Probar vista chofer<small>Ver la app como la ve un chofer</small></span></button>` : ''}
      ${staff && S.modo === 'chofer' ? `<button id="m-staff">${I.home}<span>Volver a Logística</span></button>` : ''}
    </div>
    <div class="actions block"><button class="btn danger" id="m-out">Cerrar sesión</button></div>`, { eyebrow: 'Mi cuenta' });
  $$('[data-ir]', sh).forEach(b => b.onclick = () => { closeSheet(); go(b.dataset.ir); });
  $('#m-out', sh).onclick = async () => { closeSheet(); await cerrarSesion(); };
  if ($('#m-pat', sh)) $('#m-pat', sh).onclick = () => { closeSheet(); pedirPatente(true); };
  if ($('#m-fin', sh)) $('#m-fin', sh).onclick = terminarJornada;
  if ($('#m-chofer', sh)) $('#m-chofer', sh).onclick = () => { closeSheet(); iniciarChofer(); };
  if ($('#m-staff', sh)) $('#m-staff', sh).onclick = () => { closeSheet(); detenerTracking(); iniciarStaff(); };
}

/* ================== SIN CONEXIÓN (fila TXOffline del chofer) ================== */
const EO = window.EntregasOffline;
const AUTH_KEY = 'sb-' + new URL(SUPABASE_URL).hostname.split('.')[0] + '-auth-token';
const MSG_LOGIN_SIN_RED = 'Necesitas conexión para iniciar sesión la primera vez';
const MSG_NO_SALIR = 'Tienes registros sin enviar. Conéctate y espera a que se envíen antes de cerrar sesión.';
const RESULTADOS = new Map();   // id de entrada de la fila → respuesta de la RPC (aviso de distancia)
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const esRed = (e) => TXOfflineCore.clasificarError(e) === 'red';
async function rpcOError(nombre, args) { const { data, error } = await sb.rpc(nombre, args); if (error) throw error; return data; }
const datosDe = async (b) => { const { data, error } = await b; if (error) throw error; return data; };

// Los tipos se registran ANTES de TXOffline.iniciar (iniciar envía de inmediato lo que haya en la fila).
TXOffline.registrarTipo(EO.T_LLEGADA, async (d, _archivos, meta) => {
  RESULTADOS.set(meta.id, await rpcOError('ent_marcar_llegada', EO.argsLlegada(d)));
});
TXOffline.registrarTipo(EO.T_CIERRE, async (d, archivos, meta) => {
  // rutas fijas guardadas en la fila + upsert: subir de nuevo en un reintento no duplica nada
  for (const ruta of [...d.fotos, d.firma]) {
    const blob = archivos[ruta];
    if (!blob) throw new Error('Falta en el teléfono el archivo ' + ruta);
    const { error } = await sb.storage.from('entregas').upload(ruta, blob, { contentType: ruta.endsWith('.png') ? 'image/png' : 'image/jpeg', upsert: true });
    if (error) throw error;
  }
  RESULTADOS.set(meta.id, await rpcOError('ent_cerrar_entrega', EO.argsCierre(d)));
});
TXOffline.registrarTipo(EO.T_JORNADA, async (d) => {
  // cierra la jornada anterior (si la había) y crea la nueva con el id generado en el teléfono;
  // ON CONFLICT DO NOTHING: reenviarla no duplica ni falla
  if (d.cerrar) {
    const { error } = await sb.from('ent_jornadas').update({ fin_at: d.fin_at }).eq('id', d.cerrar).is('fin_at', null);
    if (error) throw error;
  }
  const { error } = await sb.from('ent_jornadas').upsert(EO.filaJornada(d), { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
});
TXOffline.registrarTipo(EO.T_RUTA, async (d, _archivos, meta) => {
  try {
    RESULTADOS.set(meta.id, await rpcOError('ent_chofer_ruta', EO.argsRuta(d)));
  } catch (e) {
    if (EO.rutaYaHecha(d.accion, e)) return;   // reenvío de una acción que ya quedó hecha
    throw e;
  }
});

// Consulta con copia local; sin red conocida (navigator.onLine) va directo a la copia.
function consultarEnt(clave, fn) {
  return TXOffline.consultar(clave, () => {
    if (navigator.onLine === false) throw new TypeError('Failed to fetch');
    return fn();
  });
}

// Intenta enviar la fila y espera hasta `ms`; informa qué pasó con la entrada `id`.
async function resultadoEnvio(id, ms) {
  await Promise.race([TXOffline.sincronizar(), esperar(ms)]);
  let e = null;
  try { e = (await TXOffline.entradas()).find(x => x.id === id); } catch { return { estado: 'pendiente' }; }
  if (!e) { const data = RESULTADOS.get(id); RESULTADOS.delete(id); return { estado: 'enviado', data }; }
  return { estado: e.estado, error: e.error };
}

function avisoCache(...rs) {
  const c = rs.filter(r => r && r.desdeCache).map(r => r.guardadoEn).sort()[0];
  if (!c) return '';
  return `<div class="ctx" style="margin-bottom:14px">${I.alert}<span>Sin conexión · datos de las ${horaCL(c)}${diaCL(c) !== hoy() ? ' del ' + fechaCL(c) : ''}</span></div>`;
}

// Sesión guardada en el teléfono (para abrir sin señal cuando supabase no puede renovar el token).
function usuarioGuardado() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.user || null; } catch { return null; } }

async function cerrarSesion() {
  let ok = true;
  try { ok = await TXOffline.puedeCerrarSesion(); } catch {}
  if (!ok) { toast(MSG_NO_SALIR); return; }
  const { error } = await sb.auth.signOut();
  if (error) { toast(esRed(error) ? 'Sin conexión: no se pudo cerrar sesión. Intenta de nuevo con señal.' : errMsg(error)); return; }
  try { await TXOffline.alCerrarSesion(); } catch {}
}

// Indicador común de la fila (un solo elemento, se monta una vez y se reinserta en la barra del chofer).
let indFila = null;
function indicadorFila() {
  if (!indFila) { indFila = document.createElement('span'); indFila.className = 'chip warn'; indFila.id = 'filaInd'; indFila.hidden = true; TXOffline.montarIndicador(indFila); }
  return indFila;
}

// Al cambiar la fila (se envió algo, quedó con problema…) se repinta la ruta si está a la vista.
let resumenFila = null;
window.addEventListener('txoffline:cambio', (ev) => {
  const k = ev.detail.pendientes + '/' + ev.detail.problemas;
  const cambio = resumenFila !== null && k !== resumenFila;
  resumenFila = k;
  if (cambio && S.modo === 'chofer' && S.view === 'ruta' && $('#sheet-bg').hidden) go('ruta');
});

async function hayConexion() {
  if (navigator.onLine === false) return false;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
  // cualquier respuesta HTTP = hay red; solo un fallo de red (TypeError/abort) = sin conexión
  try { await fetch(SUPABASE_URL + '/auth/v1/health', { headers: { apikey: SUPABASE_KEY }, cache: 'no-store', signal: ctl.signal }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
async function avisoConexionLogin() {
  const el = $('#a-net'); if (!el) return;
  const ok = await hayConexion();
  if ($('#a-net') !== el) return;
  el.textContent = ok ? '' : MSG_LOGIN_SIN_RED; el.hidden = ok;
}
window.addEventListener('online', avisoConexionLogin);
window.addEventListener('offline', avisoConexionLogin);

function avisoInstalarIOS() {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios || navigator.standalone) return;
  const k = 'entx_aviso_instalar_' + S.perfil.id;
  try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch { return; }
  const sh = openSheet('Instala Entregas', `<div class="ctx">${I.download}<span>Para usar Entregas sin señal, instálala: Compartir → Agregar a pantalla de inicio.</span></div>
    <p class="muted">Si no la instalas, el iPhone puede borrar los registros guardados en el teléfono.</p>
    <div class="actions block"><button class="btn primary" id="iosOk">Entendido</button></div>`, { eyebrow: 'Trabajo sin señal' });
  $('#iosOk', sh).onclick = () => closeSheet();
}

/* ================== AUTENTICACIÓN ================== */
function pantallaAuth(modo = 'chofer', msg = '') {
  $('#splash').hidden = true; $('#app-shell').hidden = true; $('#auth').hidden = false;
  const titulos = { chofer: 'Ingreso choferes', staff: 'Ingreso personal TX', cliente: 'Ingreso clientes', signup: 'Crear cuenta', reset: 'Recuperar contraseña', newpass: 'Nueva contraseña' };
  const f = $('#auth .auth-form');
  f.innerHTML = `
    <h2>${titulos[modo]}</h2>
    ${['chofer', 'staff', 'cliente'].includes(modo) ? `<div class="seg-f" style="width:100%;display:grid;grid-template-columns:1fr 1fr 1fr"><button type="button" data-m="chofer" aria-pressed="${modo === 'chofer'}">Chofer</button><button type="button" data-m="staff" aria-pressed="${modo === 'staff'}">Personal TX</button><button type="button" data-m="cliente" aria-pressed="${modo === 'cliente'}">Cliente</button></div>` : ''}
    ${msg ? `<div class="ctx">${msg}</div>` : ''}
    ${['chofer', 'staff', 'cliente'].includes(modo) ? '<div class="ctx err" id="a-net" hidden></div>' : ''}
    <form id="af" class="form" novalidate style="gap:12px">
      ${modo === 'signup' ? fld('Nombre y apellido', '<input id="a-nombre" autocomplete="name">', 1) : ''}
      ${modo === 'chofer' ? fld('RUT', '<input id="a-rut" autocomplete="username" placeholder="12.345.678-9">', 1) : ''}
      ${['staff', 'signup', 'reset', 'cliente'].includes(modo) ? fld('Correo', '<input id="a-email" type="email" autocomplete="email" inputmode="email" placeholder="nombre@grupotx.cl">', 1) : ''}
      ${modo !== 'reset' ? fld(modo === 'newpass' ? 'Nueva contraseña' : 'Contraseña', `<input id="a-pass" type="password" autocomplete="${['chofer', 'staff', 'cliente'].includes(modo) ? 'current-password' : 'new-password'}">`, 1) : ''}
      <div class="ctx err" id="a-err" hidden></div>
      <button class="btn primary" id="a-go" style="width:100%;padding:13px">${{ chofer: 'Ingresar', staff: 'Ingresar', cliente: 'Ingresar', signup: 'Crear cuenta', reset: 'Enviar enlace', newpass: 'Guardar contraseña' }[modo]}</button>
    </form>
    <div class="auth-links">${modo === 'staff' ? '<button data-m="reset">Olvidé mi contraseña</button>'
      : modo === 'cliente' ? '<span class="sub">Sigue tus despachos en el mapa. Tu acceso lo entrega Grupo TX.</span><button data-m="reset">Olvidé mi contraseña</button>'
      : modo === 'chofer' ? '<span class="sub">Tu cuenta la crea Logística. Si olvidaste tu clave, pídeles que la restablezcan.</span>'
      : '<button data-m="staff">Volver a ingresar</button>'}</div>`;
  $$('[data-m]', f).forEach(b => b.onclick = () => pantallaAuth(b.dataset.m));
  const err = (m) => { const e = $('#a-err'); e.textContent = m; e.hidden = !m; };
  $('#af').onsubmit = async (ev) => {
    ev.preventDefault(); err('');
    const go = $('#a-go'); go.disabled = true;
    try {
      const pass = $('#a-pass')?.value || '';
      if (modo === 'chofer' || modo === 'staff' || modo === 'cliente') {
        const email = modo === 'chofer' ? `${limpiarRut($('#a-rut').value)}@${DOMINIO_CHOFER}` : $('#a-email').value.trim().toLowerCase();
        const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error && esRed(error)) throw new Error(MSG_LOGIN_SIN_RED);
        if (error) throw new Error(error.message.includes('Invalid') ? (modo === 'chofer' ? 'RUT o clave incorrectos' : 'Correo o contraseña incorrectos') : error.message);
        await cargarPerfil(data.user);
      } else if (modo === 'signup') {
        if (pass.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
        const { data, error } = await sb.auth.signUp({ email: $('#a-email').value.trim().toLowerCase(), password: pass, options: { data: { nombre: $('#a-nombre').value.trim() } } });
        if (error) throw error;
        if (data.session) await cargarPerfil(data.user); else pantallaAuth('staff', 'Cuenta creada. Revisa tu correo para confirmarla y luego ingresa.');
      } else if (modo === 'reset') {
        const { error } = await sb.auth.resetPasswordForEmail($('#a-email').value.trim(), { redirectTo: location.href.split('#')[0] });
        if (error) throw error;
        pantallaAuth('staff', 'Te enviamos un correo con el enlace para crear una nueva contraseña.');
      } else if (modo === 'newpass') {
        if (pass.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
        const { data, error } = await sb.auth.updateUser({ password: pass });
        if (error) throw error;
        toast('Contraseña actualizada'); await cargarPerfil(data.user);
      }
    } catch (e) { err(errMsg(e)); }
    go.disabled = false;
  };
  setTimeout(() => $('#af input')?.focus(), 50);
  avisoConexionLogin();
}

function pantallaPendiente(msg) {
  $('#splash').hidden = true; $('#app-shell').hidden = true; $('#auth').hidden = false;
  $('#auth .auth-form').innerHTML = `<h2>${S.perfil && !S.perfil.activo ? 'Cuenta bloqueada' : 'Cuenta en revisión'}</h2>
    <p class="muted" style="margin:0">Hola ${esc(S.perfil?.nombre || '')}. ${esc(msg)}</p>
    <div style="display:grid;gap:10px;margin-top:6px"><button class="btn primary" id="p-retry">Ya me asignaron perfil</button><button class="btn" id="p-out">Cerrar sesión</button></div>`;
  $('#p-retry').onclick = async () => { const { data } = await sb.auth.getSession(); if (data.session) cargarPerfil(data.session.user); };
  $('#p-out').onclick = () => cerrarSesion();
}

async function cargarPerfil(user) {
  S.user = user;
  // copia local y fila por usuario: se abren antes de cualquier consulta
  try { await TXOffline.iniciar({ app: 'entregas', sb, usuarioId: user.id }); } catch (e) { console.warn('[Entregas] sin copia local:', e); }
  let data;
  try {
    ({ datos: data } = await consultarEnt('ent.perfil', () => rpcOError('ent_registrarme', { p_nombre: user.user_metadata?.nombre || null })));
  } catch (error) {
    if (esRed(error)) return pantallaAuth('chofer', 'Sin conexión. Necesitas señal para abrir la app por primera vez en este teléfono.');
    return pantallaAuth('staff', 'No se pudo cargar tu perfil: ' + esc(errMsg(error)));
  }
  S.perfil = data;
  if (!data.activo) return pantallaPendiente('Tu acceso fue desactivado. Habla con Logística.');
  if (data.rol === 'pendiente') return pantallaPendiente('Tu cuenta está creada. Un administrador debe asignarte un perfil (Chofer, Logística o Admin) para que puedas usar la aplicación.');
  if (data.rol === 'cliente') return iniciarCliente();
  await cargarCatalogos();
  if (data.rol === 'chofer') return iniciarChofer();
  return iniciarStaff();
}

async function cargarCatalogos() {
  try {
    const { datos } = await consultarEnt('ent.catalogos', async () => {
      const [productos, motivos, vehiculos] = await Promise.all([
        datosDe(sb.from('ent_productos').select('*').order('codigo')),
        datosDe(sb.from('ent_motivos').select('*').order('id')),
        datosDe(sb.from('ent_vehiculos').select('*').order('patente')),
      ]);
      return { productos, motivos, vehiculos };
    });
    S.productos = datos.productos || []; S.motivos = datos.motivos || []; S.vehiculos = datos.vehiculos || [];
  } catch (e) {
    console.warn('[Entregas] catálogos:', e);
    S.productos = S.productos || []; S.motivos = S.motivos || []; S.vehiculos = S.vehiculos || [];
  }
}

async function iniciar() {
  pintarLogos();
  $('#auth-art2').innerHTML = `<div style="display:flex;gap:18px;align-items:end;color:#f3f3f1;opacity:.9">${[56, 76, 56].map(w => `<svg viewBox="0 0 24 24" style="width:${w}px;height:${w}px" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2" stroke="#e4032e"/><circle cx="17" cy="18" r="2" stroke="#e4032e"/></svg>`).join('')}</div>`;
  let recuperando = /type=recovery/.test(location.hash);
  sb.auth.onAuthStateChange((ev) => {
    if (ev === 'PASSWORD_RECOVERY') { recuperando = true; pantallaAuth('newpass'); }
    if (ev === 'SIGNED_OUT') { detenerTracking(); S.user = S.perfil = null; S.jornada = null; pantallaAuth('chofer'); }
  });
  // Sin señal y con el token vencido, supabase reintenta renovarlo ~30 s: no se espera tanto,
  // se abre con el usuario guardado en el teléfono (la fila renueva la sesión al volver la señal).
  const r = await Promise.race([sb.auth.getSession(), esperar(5000).then(() => null)]);
  const session = r?.data?.session || null;
  if (recuperando && session) return pantallaAuth('newpass');
  if (session) return cargarPerfil(session.user);
  const guardado = (!r || (r.error && esRed(r.error))) ? usuarioGuardado() : null;
  if (guardado) return cargarPerfil(guardado);
  pantallaAuth('chofer');
}

/* ================== VISTA CHOFER ================== */
const J_KEY = 'entx_jornada';
function jornadaLocal() { try { const j = JSON.parse(localStorage.getItem(J_KEY) || 'null'); return j && j.uid === S.perfil.id && j.fecha === hoy() ? j : null; } catch { return null; } }
function guardarJornada(j) { try { j ? localStorage.setItem(J_KEY, JSON.stringify(j)) : localStorage.removeItem(J_KEY); } catch {} }

async function iniciarChofer() {
  VIEWS = [
    { id: 'ruta', label: 'Mi ruta', icon: I.truck, title: 'Mi ruta de hoy', bottom: true, render: vistaRuta },
    { id: 'historial', label: 'Historial', icon: I.list, title: 'Mis entregas', bottom: true, render: vistaHistorial },
  ];
  let j = jornadaLocal();
  if (!j) {
    let data = null;
    try {
      ({ datos: data } = await consultarEnt('ent.jornada', () => datosDe(sb.from('ent_jornadas').select('*').eq('chofer_id', S.perfil.id).eq('fecha', hoy()).is('fin_at', null).order('inicio_at', { ascending: false }).limit(1))));
    } catch (e) { console.warn('[Entregas] jornada:', e); }
    const d = data && data[0];
    if (d && (!d.fecha || d.fecha === hoy())) { j = { uid: S.perfil.id, fecha: hoy(), patente: d.patente, id: d.id }; guardarJornada(j); }
  }
  S.jornada = j;
  montarShell('chofer');
  if (j) iniciarTracking();
  iniciarAvisos();
  avisoInstalarIOS();
}

/* --- avisos al chofer (cargas asignadas) --- */
const AV = { timer: null, vistas: new Set(), primera: true };
function iniciarAvisos() {
  clearInterval(AV.timer);
  if ('Notification' in window && Notification.permission === 'default') { try { Notification.requestPermission(); } catch {} }
  revisarAvisos();
  AV.timer = setInterval(() => { if (S.modo === 'chofer') revisarAvisos(); }, 30000);
}
async function revisarAvisos() {
  const { data } = await sb.from('ent_notificaciones').select('*').eq('usuario_id', S.perfil.id).eq('leida', false).order('created_at', { ascending: false }).limit(20);
  S.avisos = data || [];
  const nuevos = S.avisos.filter(a => !AV.vistas.has(a.id));
  nuevos.forEach(a => AV.vistas.add(a.id));
  pintarCampana();
  if (nuevos.length && !AV.primera) {
    try { navigator.vibrate && navigator.vibrate([300, 150, 300]); } catch {}
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(nuevos[0].titulo, { body: nuevos[0].cuerpo || '', icon: 'icon-512.png' }); } catch {}
    toast(nuevos[0].titulo + (nuevos[0].cuerpo ? ': ' + nuevos[0].cuerpo : ''));
    if (S.view === 'ruta' && $('#sheet-bg').hidden) go('ruta');
  }
  AV.primera = false;
}
function pintarCampana() {
  const b = $('#bAvisos'); if (!b) return;
  const n = (S.avisos || []).length;
  b.innerHTML = `${I.bell}${n ? `<span class="dot">${n}</span>` : ''}`;
}
function verAvisos() {
  const sh = openSheet('Avisos', (S.avisos || []).length ? `<ul class="list card">${S.avisos.map(a => `<li><span class="tx"><b>${esc(a.titulo)}</b><span class="sub">${esc(a.cuerpo || '')} · ${fechaHoraCL(a.created_at)}</span></span></li>`).join('')}</ul><div class="actions block"><button class="btn" id="avLeer">Marcar como leídos</button></div>` : '<div class="card empty"><b>Sin avisos nuevos</b></div>', { eyebrow: 'Logística' });
  if ($('#avLeer', sh)) $('#avLeer', sh).onclick = async () => { await sb.from('ent_notificaciones').update({ leida: true }).in('id', S.avisos.map(a => a.id)); S.avisos = []; pintarCampana(); closeSheet(); };
}

function topChofer() {
  $('#top-actions').innerHTML = (S.jornada
    ? `<span class="gps" id="gpsInd"></span><button class="pat" id="bPat" title="Cambiar patente">${esc(S.jornada.patente)}</button>`
    : '') + `<button class="xbtn bellbtn" id="bAvisos" aria-label="Avisos"></button>`;
  $('#top-actions').prepend(indicadorFila());
  if ($('#bPat')) $('#bPat').onclick = () => pedirPatente(true);
  $('#bAvisos').onclick = verAvisos;
  pintarGps(); pintarCampana();
}

// Inicia (o cambia) la jornada: queda guardada en el teléfono al instante y la fila crea la fila de
// ent_jornadas (id generado aquí, así S.jornada.id sirve desde ya y un reenvío no duplica).
async function iniciarJornadaCon(pat) {
  if (S.jornada?.patente === pat) return;
  const id = crypto.randomUUID(), ahora = new Date().toISOString();
  await TXOffline.encolar(EO.T_JORNADA, { id, chofer_id: S.perfil.id, patente: pat, fecha: hoy(), inicio_at: ahora, cerrar: S.jornada?.id || null, fin_at: ahora });
  S.jornada = { uid: S.perfil.id, fecha: hoy(), patente: pat, id };
  guardarJornada(S.jornada); iniciarTracking();
}

function tarjetaCarga(r, guias) {
  const paso = { asignada: 1, aceptada: 2, en_ruta: 3 }[r.estado];
  return `<div class="hero" style="grid-template-columns:minmax(0,1fr);margin-bottom:14px" data-ruta="${r.id}">
    <div>
      <span class="eyebrow" style="color:var(--brand)">${r.estado === 'asignada' ? 'Nueva carga asignada' : r.estado === 'aceptada' ? 'Carga en planta' : 'En ruta'} · ${fechaCL(r.fecha)}</span>
      <h2 style="margin:6px 0 4px;font-size:24px;font-weight:800;letter-spacing:-.02em">${r.estado === 'asignada' ? 'Preséntate en planta a cargar' : r.estado === 'aceptada' ? 'Carga el camión y sal a ruta' : 'Ruta en curso'}</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px"><span class="pat" style="cursor:default;background:var(--bg);color:var(--ink)">${esc(r.patente)}</span><span class="chip plain" style="background:color-mix(in srgb,var(--bg) 15%,transparent);color:inherit">${fmtNum(r.peso_ton)} ton</span><span class="chip plain" style="background:color-mix(in srgb,var(--bg) 15%,transparent);color:inherit">${guias.length} parada(s)</span>${r.fila?.estado === 'pendiente' ? '<span class="chip warn">Pendiente de enviar</span>' : ''}</div>
      ${r.fila?.estado === 'problema' ? `<div style="margin:0 0 12px"><span class="chip bad" style="white-space:normal">No se pudo enviar: ${esc(r.fila.error)}</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><button class="btn sm" data-rfila="reintentar">${I.refresh}Reintentar</button><button class="btn sm danger" data-rfila="descartar">${I.x}Descartar</button></div>` : ''}
      <ol style="margin:0 0 14px;padding-left:18px;opacity:.9;display:grid;gap:2px">${guias.map(g => `<li>${esc(g.cliente)} · ${esc(g.comuna || g.direccion)}</li>`).join('')}</ol>
      <div class="ratio" style="margin:0 0 6px">${[1, 2, 3].map(i => `<i style="width:33.3%;background:${i <= paso ? 'var(--brand)' : 'transparent'}"></i>`).join('')}</div>
      <div class="legend" style="margin-bottom:14px"><span style="--c:var(--brand)">1 Asignada</span><span style="--c:${paso >= 2 ? 'var(--brand)' : 'transparent'}">2 En planta</span><span style="--c:${paso >= 3 ? 'var(--brand)' : 'transparent'}">3 En ruta</span></div>
      ${r.estado === 'asignada' && r.fila?.estado !== 'problema' ? `<button class="btn primary xl" data-racc="aceptar">${I.check}Acepto, voy a planta</button>` : ''}
      ${r.estado === 'aceptada' && r.fila?.estado !== 'problema' ? `<button class="btn primary xl" data-racc="salir">${I.truck}Cargado, salgo a ruta</button>` : ''}
    </div></div>`;
}

// alListo: se llama tras guardar la patente (p. ej. para seguir con una llegada que la necesitaba).
function pedirPatente(cambio = false, alListo = null) {
  const opciones = S.vehiculos.filter(v => v.activo).map(v => `<option value="${esc(v.patente)}">${esc(v.descripcion || '')}</option>`).join('');
  const html = `<form id="fpat" class="form">
      <fieldset><legend>Vehículo</legend>
        <p class="muted" style="margin:0">${alListo ? 'Para registrar la llegada, ingresa la patente del camión que manejas hoy.' : cambio ? 'Ingresa la nueva patente del camión.' : 'Para comenzar, ingresa la patente del camión que manejas hoy. Tu nombre se completa solo con tu cuenta.'}</p>
        ${fld('Patente', `<input id="p-pat" class="pat-in" list="lpat" required placeholder="ABCD12" autocomplete="off" value="${esc(S.jornada?.patente || '')}"><datalist id="lpat">${opciones}</datalist>`, 1)}
        <div class="ctx">${I.pin}<span>Mientras la app esté abierta se registra tu ubicación para mostrar el trayecto a Logística.</span></div>
      </fieldset>
      <button class="btn primary xl">${I.truck}${cambio && !alListo ? 'Cambiar patente' : 'Iniciar jornada'}</button>
    </form>`;
  let box;
  if (cambio || alListo) box = openSheet(alListo ? 'Patente del camión' : 'Cambiar patente', html, { eyebrow: 'Jornada' });
  else { box = $('#view'); box.innerHTML = `<div style="max-width:520px;margin:0 auto">${html}</div>`; }
  $('#fpat', box).onsubmit = async (ev) => {
    ev.preventDefault();
    const pat = $('#p-pat', box).value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (pat.length < 5) return toast('Patente inválida');
    try { await iniciarJornadaCon(pat); }
    catch (e) { return toast('No se pudo guardar la patente en el teléfono: ' + errMsg(e)); }
    if (cambio || alListo) closeSheet();
    toast('Jornada iniciada con ' + pat);
    if (alListo) return alListo();
    go(S.view || 'ruta');
  };
}

async function terminarJornada() {
  if (!confirm('¿Terminar la jornada? Se deja de registrar tu ubicación.')) return;
  if (S.jornada?.id) await sb.from('ent_jornadas').update({ fin_at: new Date().toISOString() }).eq('id', S.jornada.id);
  guardarJornada(null); S.jornada = null; detenerTracking(); closeSheet(); go('ruta');
}

/* --- tracking del celular --- */
const T = { watch: null, ultimo: null, estado: 'off', wake: null };
function iniciarTracking() {
  if (T.watch != null || !navigator.geolocation) return;
  T.watch = navigator.geolocation.watchPosition(async (p) => {
    T.estado = 'on'; pintarGps();
    const pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, vel: p.coords.speed, t: Date.now() };
    S.posActual = pos;
    const u = T.ultimo;
    const d = u ? distM(u.lat, u.lng, pos.lat, pos.lng) : Infinity;
    if (!u || (pos.t - u.t >= TRACK_MIN_MS && d >= TRACK_MIN_M) || d >= 200) {
      if (pos.acc > 500) return;
      T.ultimo = pos;
      const { error } = await sb.from('ent_posiciones').insert({ chofer_id: S.perfil.id, patente: S.jornada?.patente, lat: pos.lat, lng: pos.lng, precision_m: Math.round(pos.acc), velocidad_kmh: pos.vel != null ? Math.round(pos.vel * 3.6) : null, fuente: 'celular' });
      if (error) console.warn('posición', error.message);
    }
  }, (e) => { T.estado = 'err'; pintarGps(); console.warn(e); }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 60000 });
  pedirWakeLock();
}
function detenerTracking() { if (T.watch != null) navigator.geolocation.clearWatch(T.watch); T.watch = null; T.estado = 'off'; }
async function pedirWakeLock() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') T.wake = await navigator.wakeLock.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.modo === 'chofer') { pedirWakeLock(); if (S.view === 'ruta' && $('#sheet-bg').hidden) go('ruta'); } });
function pintarGps() {
  const el = $('#gpsInd'); if (!el) return;
  el.className = 'gps ' + (T.estado === 'on' ? 'on' : T.estado === 'err' ? 'err' : '');
  el.innerHTML = `<i></i>${T.estado === 'on' ? 'GPS activo' : T.estado === 'err' ? 'Sin GPS' : 'GPS…'}`;
}

function tarjetaGuia(g, conAcciones = true, bloqueada = false) {
  const nav = g.dest_lat ? `${g.dest_lat},${g.dest_lng}` : encodeURIComponent([g.direccion, g.comuna].filter(Boolean).join(', '));
  const problema = g.fila?.estado === 'problema';
  if (problema) conAcciones = false;   // con un registro con problema solo se ofrece Reintentar / Descartar
  return `<div class="card gcard ${g.estado}" data-id="${g.id}">
    <div class="top"><div><span class="eyebrow">${g.orden ? 'Parada ' + g.orden + ' · ' : ''}Guía</span><div class="folio">${esc(g.folio)}</div></div><div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">${badge(g.estado)}${g.fila?.estado === 'pendiente' ? '<span class="chip warn">Pendiente de enviar</span>' : ''}</div></div>
    ${problema ? `<div><span class="chip bad" style="white-space:normal">No se pudo enviar: ${esc(g.fila.error)}</span></div>
    <div class="act"><button class="btn sm" data-fila="reintentar">${I.refresh}Reintentar</button><button class="btn sm danger" data-fila="descartar">${I.x}Descartar</button></div>` : ''}
    <div class="cli">${esc(g.cliente)}${g.obra ? ` <span class="muted" style="font-weight:500">· ${esc(g.obra)}</span>` : ''}</div>
    <div class="dir">${I.pin}<span>${esc(g.direccion)}${g.comuna ? ', ' + esc(g.comuna) : ''}</span></div>
    ${g.contacto || g.telefono ? `<div class="sub">${esc(g.contacto || '')}${g.telefono ? ` · <a href="tel:${esc(g.telefono)}">${esc(g.telefono)}</a>` : ''}</div>` : ''}
    ${g.detalle ? `<div class="det">${esc(g.detalle)}</div>` : ''}
    ${g.observacion ? `<div class="sub"><b>Obs:</b> ${esc(g.observacion)}</div>` : ''}
    ${g.fecha !== hoy() ? `<div class="sub" style="color:var(--bad)">Guía del ${fechaCL(g.fecha)}</div>` : ''}
    ${conAcciones && bloqueada ? `<div class="sub" style="color:var(--warn);font-weight:600">Primero confirma la carga en planta para iniciar esta entrega.</div>` : ''}
    ${conAcciones && !bloqueada ? `<div class="act">
      ${g.estado === 'asignada' ? `
        <a class="btn sm" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${nav}">${I.nav}Google Maps</a>
        <a class="btn sm" target="_blank" rel="noopener" href="https://waze.com/ul?${g.dest_lat ? 'll=' + nav : 'q=' + nav}&navigate=yes">${I.nav}Waze</a>
        <button class="btn primary xl" data-acc="llegue">${I.pin}Llegué al destino</button>` : ''}
      ${g.estado === 'en_destino' ? `<button class="btn okb xl" data-acc="registrar">${I.box}Registrar entrega</button>` : ''}
    </div>` : ''}
  </div>`;
}

async function vistaRuta(el) {
  const gen = S.gen;
  let rRutas = null, rGuias = null;
  const fila = await TXOffline.entradas().catch(() => []);
  try {
    rRutas = await consultarEnt('ent.rutas', () => datosDe(sb.from('ent_rutas').select('*').eq('chofer_id', S.perfil.id).in('estado', ['asignada', 'aceptada', 'en_ruta']).gte('fecha', sumarDias(hoy(), -1)).order('fecha').order('asignada_at')));
  } catch (e) { console.warn('[Entregas] rutas:', e); }
  if (gen !== S.gen) return;
  S.rutasChofer = EO.aplicarFilaRutas(rRutas?.datos || [], fila);   // acciones de ruta aún en el teléfono
  if (!S.jornada && !S.rutasChofer.length && rRutas) { topChofer(); return pedirPatente(false); }
  topChofer();
  try {
    rGuias = await consultarEnt('ent.guias', () => datosDe(sb.from('ent_guias').select('*')
      .eq('chofer_id', S.perfil.id).neq('estado', 'anulada')
      .or(`fecha.eq.${hoy()},estado.in.(asignada,en_destino)`)
      .order('fecha').order('orden').order('created_at')));
  } catch (error) {
    if (gen !== S.gen) return;
    el.innerHTML = `<div class="ctx err">${esRed(error) ? 'Sin conexión y sin datos guardados en este teléfono. Conéctate para cargar tu ruta.' : esc(errMsg(error))}</div>`;
    return;
  }
  if (gen !== S.gen) return;
  const data = EO.aplicarFila(rGuias.datos || [], fila);
  S.guiasChofer = data;
  const rutaDe = (g) => g.ruta_id ? S.rutasChofer.find(r => r.id === g.ruta_id) : null;
  const bloqueada = (g) => { const r = rutaDe(g); return r && r.estado !== 'en_ruta'; };
  const cargasHtml = S.rutasChofer.filter(r => r.estado !== 'en_ruta' || r.fila).map(r => tarjetaCarga(r, data.filter(g => g.ruta_id === r.id))).join('');
  const pend = data.filter(g => ['asignada', 'en_destino'].includes(g.estado));
  const hechas = data.filter(g => !['asignada', 'en_destino'].includes(g.estado));
  const tot = data.length || 1;
  const n = (e) => data.filter(g => g.estado === e).length;
  el.innerHTML = avisoCache(rRutas, rGuias) + cargasHtml + `
    <div class="hero" style="grid-template-columns:minmax(0,1fr)">
      <div>
        <span class="eyebrow" style="color:color-mix(in srgb,var(--bg) 70%,transparent)">${esc(S.perfil.nombre)} · ${fechaLarga(hoy())}</span>
        <div class="big" style="margin-top:12px">
          <div class="red"><b>${pend.length}</b><span>Por entregar</span></div>
          <div><b>${hechas.length}</b><span>Completadas</span></div>
          <div style="opacity:.75"><b>${data.length}</b><span>Guías hoy</span></div>
        </div>
        <div class="ratio">${['entregada', 'entregada_con_devolucion', 'rechazada', 'en_destino'].map(e => `<i style="width:${n(e) / tot * 100}%;background:${EST_COLOR[e]}"></i>`).join('')}</div>
        <div class="legend"><span style="--c:var(--ok)">Entregadas ${n('entregada')}</span><span style="--c:var(--info)">Con devolución ${n('entregada_con_devolucion')}</span><span style="--c:var(--bad)">Rechazadas ${n('rechazada')}</span><span style="--c:var(--warn)">En destino ${n('en_destino')}</span></div>
      </div>
    </div>
    <div class="sec-h"><div><h2>Por entregar</h2><p>En el orden en que Logística las asignó.</p></div><button class="btn sm" id="bRef">${I.refresh}Actualizar</button></div>
    <div class="grid" style="gap:12px">${pend.length ? pend.map(g => tarjetaGuia(g, true, bloqueada(g))).join('') : `<div class="card empty"><b>No tienes entregas pendientes</b>Si esperas guías, pide a Logística que te las asigne y presiona Actualizar.</div>`}</div>
    ${hechas.length ? `<div class="sec-h block"><div><h2>Completadas hoy</h2></div></div><div class="grid" style="gap:12px">${hechas.map(g => tarjetaGuia(g, false)).join('')}</div>` : ''}`;
  $('#bRef').onclick = () => { TXOffline.sincronizar(); go('ruta'); };
  const accionFila = async (b, ids, accion, pregunta) => {
    if (accion === 'descartar') {
      if (!confirm(pregunta)) return;
      for (const id of ids) await TXOffline.descartar(id);
      toast('Registro descartado');
    } else {
      b.disabled = true;
      for (const id of ids) await TXOffline.reintentar(id);   // en orden: llegada antes que cierre
      const quedan = (await TXOffline.entradas()).filter(e => ids.includes(e.id));
      toast(!quedan.length ? 'Enviado' : quedan.some(e => e.estado === 'problema') ? 'Sigue con problema: ' + (quedan.find(e => e.estado === 'problema').error || '') : 'Pendiente de enviar. Se enviará al volver la señal.');
    }
    go('ruta');
  };
  $$('[data-fila]', el).forEach(b => b.onclick = () => {
    const g = S.guiasChofer.find(x => x.id === b.closest('.gcard').dataset.id);
    accionFila(b, g?.fila?.ids || [], b.dataset.fila, `¿Descartar lo registrado sin enviar de la guía ${g.folio}? Se borrará del teléfono (fotos y firma incluidas) y no se enviará.`);
  });
  $$('[data-rfila]', el).forEach(b => b.onclick = () => {
    const r = S.rutasChofer.find(x => x.id === b.closest('[data-ruta]').dataset.ruta);
    accionFila(b, r?.fila?.ids || [], b.dataset.rfila, '¿Descartar la acción de la carga sin enviar? Se borrará del teléfono y no se enviará.');
  });
  $$('[data-racc]', el).forEach(b => b.onclick = async () => {
    const r = S.rutasChofer.find(x => x.id === b.closest('[data-ruta]').dataset.ruta), acc = b.dataset.racc;
    if (acc === 'salir' && !confirm('¿Confirmas que el camión está cargado y sales a ruta?')) return;
    b.disabled = true;
    try {
      if (r.patente) await iniciarJornadaCon(r.patente);   // jornada por la fila (sirve sin señal)
      const idFila = await TXOffline.encolar(EO.T_RUTA, { ruta: r.id, accion: acc, at: new Date().toISOString() });
      const res = await resultadoEnvio(idFila, 6000);
      if (res.estado === 'enviado') { toast(acc === 'aceptar' ? 'Carga aceptada. Dirígete a planta.' : 'Buen viaje. El cliente ya puede ver tu camión en el mapa.'); revisarAvisos(); }
      else if (res.estado === 'problema') toast('No se pudo registrar: ' + (res.error || '') + '.');
      else toast(acc === 'aceptar' ? 'Carga aceptada y guardada en el teléfono. Se enviará al volver la señal.' : 'Salida a ruta guardada en el teléfono. Se enviará al volver la señal.');
      go('ruta');
    } catch (e) { toast(errMsg(e)); b.disabled = false; }
  });
  $$('[data-acc=llegue]', el).forEach(b => b.onclick = () => marcarLlegada(b.closest('.gcard').dataset.id, b));
  $$('[data-acc=registrar]', el).forEach(b => b.onclick = () => formEntrega(S.guiasChofer.find(g => g.id === b.closest('.gcard').dataset.id)));
}

async function vistaHistorial(el) {
  const gen = S.gen;
  topChofer();
  const desde = sumarDias(hoy(), -14);
  let r;
  try {
    r = await consultarEnt('ent.historial', () => datosDe(sb.from('ent_guias').select('*, ent_entregas(*)').eq('chofer_id', S.perfil.id).gte('fecha', desde).not('estado', 'in', '(asignada,en_destino,anulada)').order('fecha', { ascending: false }).order('orden')));
  } catch (error) {
    if (gen !== S.gen) return;
    el.innerHTML = `<div class="ctx err">${esRed(error) ? 'Sin conexión y sin datos guardados en este teléfono. Conéctate para ver tu historial.' : esc(errMsg(error))}</div>`;
    return;
  }
  if (gen !== S.gen) return;
  const data = r.datos || [];
  el.innerHTML = avisoCache(r) + `<div class="sec-h"><div><h2>Últimos 14 días</h2><p>${data.length} entregas registradas.</p></div></div>
    <div class="card tbl-wrap">${data.length ? `<table><thead><tr><th>Fecha</th><th>Guía</th><th>Cliente</th><th>Llegada</th><th>Recibió</th><th>Estado</th></tr></thead><tbody>
    ${data.map(g => { const e = entregaDe(g) || {}; return `<tr><td class="num">${fechaCL(g.fecha)}</td><td class="num"><b>${esc(g.folio)}</b></td><td>${esc(g.cliente)}</td><td class="num">${horaCL(e.llegada_at)}</td><td>${esc(e.receptor_nombre || '')}</td><td>${badge(g.estado)}</td></tr>`; }).join('')}
    </tbody></table>` : '<div class="empty"><b>Sin entregas</b>Aún no registras entregas en este período.</div>'}</div>`;
}

async function marcarLlegada(id, btn, confirmada = false) {
  const g = S.guiasChofer.find(x => x.id === id);
  if (!confirmada && !confirm(`¿Confirmas que llegaste a ${g.cliente || 'destino'} (guía ${g.folio})?`)) return;
  // la RPC exige patente: la de la jornada; si no, la de la ruta (y se inicia la jornada con ella); si no, se pide
  const ruta = g.ruta_id ? (S.rutasChofer || []).find(r => r.id === g.ruta_id) : null;
  const pat = EO.patenteParaLlegada(S.jornada, ruta);
  if (!pat) return pedirPatente(false, () => marcarLlegada(id, btn, true));
  if (!S.jornada?.patente) {
    try { await iniciarJornadaCon(pat); } catch (e) { return toast('No se pudo guardar la patente en el teléfono: ' + errMsg(e)); }
  }
  btn.disabled = true; btn.innerHTML = `${I.pin}Obteniendo ubicación…`;
  let idFila;
  try {
    const pos = await obtenerPosicion();   // el GPS funciona sin señal
    btn.innerHTML = `${I.pin}Guardando…`;
    idFila = await TXOffline.encolar(EO.T_LLEGADA, { guia: id, patente: pat, lat: pos.lat, lng: pos.lng, precision: Math.round(pos.acc), at: new Date().toISOString() });
  } catch (e) {
    toast(errMsg(e)); btn.disabled = false; btn.innerHTML = `${I.pin}Llegué al destino`;
    return;
  }
  const r = await resultadoEnvio(idFila, 6000);
  if (r.estado === 'enviado') {
    const d = r.data?.distancia_destino_m;
    toast(d != null && d > RADIO_ALERTA_M ? `Llegada registrada. Ojo: estás a ${fmtM(d)} del destino informado.` : 'Llegada registrada');
  } else if (r.estado === 'problema') {
    toast('No se pudo registrar la llegada: ' + (r.error || '') + '. Revísala en Mi ruta.');
    go('ruta');
    return;
  } else {
    toast('Llegada guardada en el teléfono. Se enviará al volver la señal.');
  }
  g.estado = 'en_destino';
  go('ruta');
  formEntrega(g);
}

/* --- formulario de entrega (hoja lateral, igual que los formularios de Silos TX) --- */
function formEntrega(g) {
  const F = { fotos: [], resultado: 'entregada', devs: [] };
  const optsProd = '<option value="">Selecciona producto…</option>' + S.productos.filter(p => p.activo).map(p => `<option value="${esc(p.codigo)}">${esc(p.codigo)} — ${esc(p.descripcion)}</option>`).join('');
  const optsMot = '<option value="">Motivo…</option>' + S.motivos.filter(m => m.activo).map(m => `<option>${esc(m.motivo)}</option>`).join('');
  const salir = () => { if (confirm('¿Salir sin guardar? La llegada ya quedó guardada; puedes completar la entrega después.')) { F.fotos.forEach(f => URL.revokeObjectURL(f.url)); closeSheet(); } };
  const sh = openSheet(`Guía ${esc(g.folio)}`, `
    <div class="ctx" style="margin-bottom:16px"><b>${esc(g.cliente)}</b>${g.obra ? ' · ' + esc(g.obra) : ''}<span class="sub" style="width:100%">${esc(g.direccion)}${g.comuna ? ', ' + esc(g.comuna) : ''}</span><span class="chip dark plain">Chofer: ${esc(S.perfil.nombre)}</span>${S.jornada ? `<span class="chip dark plain mono">${esc(S.jornada.patente)}</span>` : ''}</div>
    <div class="form" id="fEntrega">
      <fieldset><legend>1 · Fotos de la mercadería</legend>
        <div class="photos" id="fotos"></div>
        <input type="file" id="inFoto" accept="image/*" capture="environment" hidden>
        <div class="sub">Toma al menos una foto de la carga descargada (máx. 6).</div>
      </fieldset>
      <fieldset><legend>2 · Resultado</legend>
        <div class="types" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <label><input type="radio" name="res" value="entregada" checked><span>${I.check}Conforme<small>Todo recibido</small></span></label>
          <label><input type="radio" name="res" value="entregada_con_devolucion"><span>${I.ret}Con devolución<small>Parte vuelve</small></span></label>
          <label><input type="radio" name="res" value="rechazada"><span>${I.ban}Rechazo<small>No recibe</small></span></label>
        </div>
        <div id="devBox" hidden style="display:grid;gap:10px">
          <div class="sub">Detalla cada producto devuelto:</div>
          <div id="devs" style="display:grid;gap:10px"></div>
          <div><button class="btn sm" id="bAddDev" type="button">${I.plus}Agregar producto</button></div>
        </div>
      </fieldset>
      <fieldset><legend>3 · Quién recibe</legend>
        ${fld('Nombre completo', '<input id="rNom" autocomplete="off">', 1)}
        <div class="fg">${fld('RUT', '<input id="rRut" autocomplete="off" placeholder="12.345.678-9">')}${fld('Cargo', '<input id="rCargo" autocomplete="off" placeholder="Bodeguero, jefe de obra…">')}</div>
        ${fld('Teléfono', '<input id="rTel" type="tel" autocomplete="off">')}
        ${fld('Observaciones', '<textarea id="rObs" placeholder="Opcional"></textarea>')}
      </fieldset>
      <fieldset><legend>4 · Firma de quien recibe</legend>
        <canvas class="firma" id="firma"></canvas>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span class="sub">Firma con el dedo dentro del recuadro</span><button class="btn sm" id="bLimpiar" type="button">Limpiar</button></div>
      </fieldset>
      <button class="btn okb xl" id="bConfirmar">${I.check}Confirmar entrega</button>
    </div>`, { eyebrow: 'Registrar entrega', onClose: salir });

  const pintarFotos = () => {
    $('#fotos', sh).innerHTML = F.fotos.map((f, i) => `<div class="ph"><img src="${f.url}" alt="foto ${i + 1}"><button data-i="${i}" aria-label="Quitar" type="button">${I.x}</button></div>`).join('')
      + (F.fotos.length < 6 ? `<button type="button" class="addph" id="bFoto">${I.cam}Agregar foto</button>` : '');
    $$('#fotos .ph button', sh).forEach(b => b.onclick = () => { URL.revokeObjectURL(F.fotos[b.dataset.i].url); F.fotos.splice(+b.dataset.i, 1); pintarFotos(); });
    const bf = $('#bFoto', sh); if (bf) bf.onclick = () => $('#inFoto', sh).click();
  };
  $('#inFoto', sh).onchange = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    try { const blob = await comprimirImagen(file); F.fotos.push({ blob, url: URL.createObjectURL(blob) }); pintarFotos(); }
    catch { toast('No se pudo leer la foto'); }
  };
  pintarFotos();

  const pintarDevs = () => {
    $('#devs', sh).innerHTML = F.devs.map((d, i) => `<div class="devl" data-i="${i}">
      <div class="w">${fld('Producto', `<select data-k="codigo">${optsProd}</select>`, 1)}</div>
      ${fld('Cantidad', '<input data-k="cantidad" type="number" inputmode="decimal" min="0" step="any">', 1)}
      ${fld('Motivo', `<select data-k="motivo">${optsMot}</select>`, 1)}
      <button class="rep-x" data-del="${i}" type="button" aria-label="Quitar">×</button>
      <div class="w" style="grid-column:1/-1">${fld('Comentario', '<input data-k="comentario" placeholder="Opcional">')}</div></div>`).join('');
    $$('#devs .devl', sh).forEach(div => {
      const d = F.devs[+div.dataset.i];
      $$('[data-k]', div).forEach(inp => { inp.value = d[inp.dataset.k] ?? ''; inp.oninput = inp.onchange = () => d[inp.dataset.k] = inp.value; });
    });
    $$('#devs [data-del]', sh).forEach(b => b.onclick = () => { F.devs.splice(+b.dataset.del, 1); pintarDevs(); });
  };
  $('#bAddDev', sh).onclick = () => { F.devs.push({ codigo: '', cantidad: '', motivo: '', comentario: '' }); pintarDevs(); };
  $$('input[name=res]', sh).forEach(r => r.onchange = () => {
    F.resultado = r.value;
    const conDev = F.resultado !== 'entregada';
    $('#devBox', sh).hidden = !conDev;
    if (conDev && !F.devs.length) { F.devs.push({ codigo: '', cantidad: '', motivo: '', comentario: '' }); pintarDevs(); }
  });

  const pad = crearFirma($('#firma', sh));
  $('#bLimpiar', sh).onclick = () => pad.limpiar();

  $('#bConfirmar', sh).onclick = async () => {
    const nom = $('#rNom', sh).value.trim();
    if (!F.fotos.length) return toast('Falta al menos una foto de la mercadería');
    if (!nom) return toast('Falta el nombre de quien recibe');
    if (pad.vacia()) return toast('Falta la firma de quien recibe');
    let devs = [];
    if (F.resultado !== 'entregada') {
      devs = F.devs.filter(d => d.codigo || d.cantidad || d.motivo);
      if (F.resultado === 'entregada_con_devolucion' && !devs.length) return toast('Indica al menos un producto devuelto');
      for (const d of devs) if (!d.codigo || !(+d.cantidad > 0) || !d.motivo) return toast('Cada devolución necesita producto, cantidad y motivo');
    }
    if (!confirm('¿Confirmar y enviar la entrega?')) return;
    const btn = $('#bConfirmar', sh); btn.disabled = true;
    let idFila;
    try {
      // Hora y rutas se fijan al confirmar y viajan en la fila: cada reintento reusa la misma firma_path.
      const at = new Date().toISOString();
      const { fotos, firma } = EO.rutasCierre(g.id, Date.now(), F.fotos.length);
      const archivos = {};
      fotos.forEach((p, i) => { archivos[p] = F.fotos[i].blob; });
      archivos[firma] = await pad.blob();
      btn.textContent = 'Guardando…';
      let pos = S.posActual;
      if (!pos || Date.now() - pos.t > 120000) { try { pos = await obtenerPosicion(8000); } catch { pos = null; } }
      const dependeDe = EO.llegadaEnFila(await TXOffline.entradas(), g.id);
      idFila = await TXOffline.encolar(EO.T_CIERRE, {
        guia: g.id, resultado: F.resultado, fotos, firma, receptor_nombre: nom,
        receptor_rut: $('#rRut', sh).value.trim() || null, receptor_cargo: $('#rCargo', sh).value.trim() || null,
        receptor_telefono: $('#rTel', sh).value.trim() || null, observacion: $('#rObs', sh).value.trim() || null,
        lat: pos?.lat ?? null, lng: pos?.lng ?? null,
        devoluciones: devs.map(d => ({ codigo: d.codigo, cantidad: +d.cantidad, motivo: d.motivo, comentario: d.comentario || null })),
        at,
      }, { archivos, dependeDe });
    } catch (e) {
      toast('No se pudo guardar en el teléfono: ' + errMsg(e));
      btn.disabled = false; btn.innerHTML = `${I.check}Confirmar entrega`;
      return;
    }
    btn.textContent = 'Enviando…';
    const r = await resultadoEnvio(idFila, 15000);
    F.fotos.forEach(f => URL.revokeObjectURL(f.url));
    closeSheet();
    if (r.estado === 'enviado') toast('Entrega registrada');
    else if (r.estado === 'problema') toast('No se pudo registrar la entrega: ' + (r.error || '') + '. Revísala en Mi ruta.');
    else toast('Entrega guardada en el teléfono. Se enviará al volver la señal.');
    go('ruta');
  };
}

function crearFirma(canvas) {
  const ctx = canvas.getContext('2d');
  let dib = false, tinta = false, ult = null;
  const ajustar = () => {
    const r = canvas.getBoundingClientRect(), k = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * k); canvas.height = Math.max(1, r.height * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, r.width, r.height);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111214';
    tinta = false;
  };
  ajustar();
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', e => { e.preventDefault(); if (!canvas.width || canvas.width < 5) ajustar(); canvas.setPointerCapture(e.pointerId); dib = true; ult = pt(e); ctx.beginPath(); ctx.arc(ult.x, ult.y, 1.1, 0, Math.PI * 2); ctx.fillStyle = '#111214'; ctx.fill(); tinta = true; });
  canvas.addEventListener('pointermove', e => { if (!dib) return; e.preventDefault(); const p = pt(e); ctx.beginPath(); ctx.moveTo(ult.x, ult.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ult = p; tinta = true; });
  const fin = () => { dib = false; };
  canvas.addEventListener('pointerup', fin); canvas.addEventListener('pointercancel', fin); canvas.addEventListener('pointerleave', fin);
  return { limpiar: ajustar, vacia: () => !tinta, blob: () => new Promise(r => canvas.toBlob(r, 'image/png')) };
}
