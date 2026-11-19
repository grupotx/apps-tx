// Armado de envíos de respaldo por app. Lógica pura: sin APIs de Deno ni de red.
// Spec: docs/superpowers/specs/2026-11-19-respaldo-drive-design.md

export type ArchivoBucket = { bucket: string; ruta: string; nombre: string };
export type ArchivoBase64 = { base64: string; nombre: string };
export type Archivo = ArchivoBucket | ArchivoBase64;
export type App = 'entregas' | 'terreno' | 'silos' | 'mantencion' | 'crm';
export type Envio = {
  app: App;
  numero: number;
  carpeta: string;
  fecha: string;
  identificador: string;
  campos: Array<[string, string]>;
  fila: Record<string, string>;
  archivos: Archivo[];
};

type Obj = Record<string, any>;

const num6 = (n: number) => String(n).padStart(6, '0');
const txt = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const dia = (v: unknown): string => txt(v).slice(0, 10);
const may = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const limpio = (campos: Array<[string, unknown]>): Array<[string, string]> =>
  campos.map(([k, v]) => [k, txt(v)] as [string, string]).filter(([, v]) => v !== '');

export function nombreCarpeta(numero: number, identificador: string, fecha: string): string {
  const id = identificador.replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${num6(numero)} · ${id} · ${fecha}`;
}

export function rutaDesdeUrlPublica(url: string, bucket: string): string | null {
  const marca = `/storage/v1/object/public/${bucket}/`;
  const i = url.indexOf(marca);
  if (i < 0) return null;
  return decodeURIComponent(url.slice(i + marca.length).split(/[?#]/)[0]);
}

const deBucket = (bucket: string, rutas: unknown[]): ArchivoBucket[] =>
  rutas.filter(Boolean).map((r, i) => ({ bucket, ruta: String(r), nombre: `foto_${i + 1}.jpg` }));

const planos = (o: Obj | undefined, excluir: string[] = []): Array<[string, unknown]> =>
  Object.entries(o || {}).filter(([k, v]) => !excluir.includes(k) && v !== null && typeof v !== 'object');

function entregas(d: Obj) {
  const e: Obj = d.entrega || {}, g: Obj = d.guia || {};
  const dev = (d.devoluciones || []).map((x: Obj) => `${x.cantidad} ${x.unidad || ''} ${x.producto_descripcion || x.producto_codigo || ''} (${x.motivo || ''})`.replace(/\s+/g, ' ')).join('; ');
  const archivos: Archivo[] = deBucket('entregas', e.fotos || []);
  if (e.firma_path) archivos.push({ bucket: 'entregas', ruta: e.firma_path, nombre: 'firma.png' });
  return {
    identificador: `Folio ${g.folio || e.guia_id || e.id}`,
    fecha: dia(e.cierre_at || g.fecha || e.created_at),
    campos: limpio([['Folio', g.folio], ['Fecha guía', g.fecha], ['Cliente', g.cliente], ['Obra', g.obra], ['Dirección', g.direccion], ['Comuna', g.comuna],
      ['Chofer', e.chofer_nombre], ['Patente', e.patente], ['Resultado', e.resultado], ['Llegada', e.llegada_at], ['Cierre', e.cierre_at],
      ['GPS cierre', e.cierre_lat != null ? `${e.cierre_lat}, ${e.cierre_lng}` : ''],
      ['Receptor', [e.receptor_nombre, e.receptor_rut, e.receptor_cargo, e.receptor_telefono].filter(Boolean).join(' · ')],
      ['Observación', e.observacion], ['Devoluciones', dev]]),
    fila: { Cliente: txt(g.cliente), Obra: txt(g.obra), Chofer: txt(e.chofer_nombre), Resultado: txt(e.resultado) },
    archivos,
  };
}

function terreno(d: Obj) {
  return {
    identificador: `${may(txt(d.kind))} · ${txt(d.cliente)}`,
    fecha: dia(d.fecha || d.created_at),
    campos: limpio([['Tipo', d.kind], ['Fecha', d.fecha], ['Cliente', d.cliente], ['Obra', d.obra], ['Estado', d.estado], ['Autor', d.autor_nombre], ...planos(d.datos)]),
    fila: { Tipo: txt(d.kind), Cliente: txt(d.cliente), Obra: txt(d.obra), Autor: txt(d.autor_nombre) },
    archivos: deBucket('registro-terreno', d.fotos || []),
  };
}

function silos(tabla: string, d: Obj) {
  const data: Obj = d.data || {};
  const rutas = (data.fotos || []).map((f: Obj) => f?.id || (f?.url ? rutaDesdeUrlPublica(f.url, 'fotos') : null));
  if (tabla === 'solicitudes') {
    return {
      identificador: `Solicitud · ${txt(data.obra || data.cliente)}`,
      fecha: dia(data.fecha || d.created_at),
      campos: limpio([['Estado', d.estado], ...planos(data, ['fotos'])]),
      fila: { Tipo: 'Solicitud', Estado: txt(d.estado), Obra: txt(data.obra), Cliente: txt(data.cliente) },
      archivos: deBucket('fotos', rutas),
    };
  }
  return {
    identificador: `${txt(d.tipo)} · ${txt(d.silo_codigo || 'sin silo')}`,
    fecha: dia(d.fecha || d.created_at),
    campos: limpio([['Tipo', d.tipo], ['Fecha', d.fecha], ['Silo', d.silo_codigo], ...planos(data, ['fotos'])]),
    fila: { Tipo: txt(d.tipo), Silo: txt(d.silo_codigo) },
    archivos: deBucket('fotos', rutas),
  };
}

function mantencion(d: Obj) {
  const data: Obj = d.data || {};
  const archivos: Archivo[] = [];
  for (const it of data.items || []) {
    const f = it?.foto;
    const nombre = `foto_${archivos.length + 1}.jpg`;
    if (typeof f === 'string' && f.startsWith('data:')) archivos.push({ base64: f.slice(f.indexOf(',') + 1), nombre });
    else if (f && typeof f === 'object' && f.path) archivos.push({ bucket: 'mantencion', ruta: f.path, nombre });
  }
  const esChk = d.coleccion === 'chk';
  const items = (data.items || []).map((it: Obj) => `${it.item}: ${it.r}${it.com ? ` (${it.com})` : ''}`).join('; ');
  return {
    identificador: esChk ? `Checklist · ${txt(data.eq)}` : `OT · ${txt(data.eq)} · ${txt(data.tipo)}`,
    fecha: dia(data.fecha || data.creada || data.inicio),
    campos: limpio([...planos(data, ['id']), ['Ítems', items]]),
    fila: { Tipo: esChk ? 'Checklist' : 'Orden de trabajo', Equipo: txt(data.eq), Estado: txt(data.estado) },
    archivos,
  };
}

function crm(d: Obj) {
  return {
    identificador: txt(d.cliente_nombre || d.lugar || 'Sin cliente'),
    fecha: dia(d.date || d.created_at),
    campos: limpio([['Fecha', d.date], ['Cliente', d.cliente_nombre], ['Lugar', d.lugar], ['Vendedor', d.vendedor_nombre], ['Dirección', d.address],
      ['Motivo', d.reason], ['Resultado', d.result], ['Comentarios', d.comments], ['Próximo paso', d.next], ['Seguimiento', d.follow_date],
      ['GPS', d.lat != null ? `${d.lat}, ${d.lng}` : '']]),
    fila: { Cliente: txt(d.cliente_nombre || d.lugar), Vendedor: txt(d.vendedor_nombre), Resultado: txt(d.result) },
    archivos: deBucket('crm-visitas', d.photo ? [d.photo] : []),
  };
}

export function armarEnvio(app: App, tabla: string, datos: Obj, numero: number): Envio {
  const p = app === 'entregas' ? entregas(datos)
    : app === 'terreno' ? terreno(datos)
    : app === 'silos' ? silos(tabla, datos)
    : app === 'mantencion' ? mantencion(datos)
    : crm(datos);
  return {
    app,
    numero,
    carpeta: nombreCarpeta(numero, p.identificador, p.fecha),
    fecha: p.fecha,
    identificador: p.identificador,
    campos: p.campos,
    fila: { 'Número': num6(numero), 'Fecha': p.fecha, 'Identificador': p.identificador, ...p.fila },
    archivos: p.archivos,
  };
}
