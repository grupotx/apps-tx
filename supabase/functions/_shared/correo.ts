// Validaciones puras de la función terreno-correo (sin red ni base de datos): el pedido del navegador antes de
// reenviarlo al Apps Script, y la traducción de la respuesta del Apps Script.

export const LIMITE_BYTES = 8 * 1024 * 1024;
const FIRMA_PDF_B64 = 'JVBERi0'; // "%PDF-" en base64

// Misma regla que lib.js del Apps Script y TC.correoValido: una sola dirección, sin espacios, comas ni saltos de línea.
// (lib.js del Apps Script repite esta regla y el tope de 200 caracteres del asunto; tests/correo-contrato.test.ts ata el asunto
// y el cuerpo reales de TC.correoVisita / TC.correoEnsayo con validarSolicitud.)
export const correoValido = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/.test(s);

export const bytesDeBase64 = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export type Solicitud = { registro_id: string; para: string; asunto: string; cuerpo: string; nombre: string; base64: string };

// `ctx`: lo que la visita tiene GUARDADO. El destino debe ser exactamente el correo guardado (así un pedido manipulado o
// desfasado no puede mandar el informe a otra dirección) y el mensaje debe corresponder a la visita: el cuerpo nombra al
// cliente y la obra, y el asunto sigue el patrón de TC.correoVisita ('Visita técnica <obra> – <fecha>'). El PM puede editar
// el texto, pero no usar la casilla institucional para un mensaje ajeno a la visita.
// `kind`: 'visita' (por omisión) o 'adherencia'; en un ensayo el correo guardado es datos.correo_cliente y el asunto sigue el patrón de TC.correoEnsayo.
export type ContextoVisita = { kind?: 'visita' | 'adherencia'; cierreEmail: string | null | undefined; cliente: string | null | undefined; obra: string | null | undefined };
const PREFIJO_ASUNTO = { visita: 'Visita técnica ', adherencia: 'Informe prueba de adherencia ' };
export function validarSolicitud(b: unknown, ctx: ContextoVisita):
  { ok: true; solicitud: Solicitud } | { ok: false; error: string } {
  const x = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  if (!correoValido(x.para)) return { ok: false, error: 'correo_invalido' };
  if (!correoValido(ctx.cierreEmail) || x.para.trim().toLowerCase() !== ctx.cierreEmail.trim().toLowerCase()) return { ok: false, error: 'correo_no_coincide' };
  if (typeof x.asunto === 'string' && x.asunto.length > 200) return { ok: false, error: 'asunto_largo' };
  if (typeof x.asunto !== 'string' || !x.asunto.trim() || /[\r\n]/.test(x.asunto)) return { ok: false, error: 'solicitud_invalida' };
  if (typeof x.cuerpo !== 'string' || !x.cuerpo.trim() || x.cuerpo.length > 20000) return { ok: false, error: 'solicitud_invalida' };
  if (!x.asunto.startsWith(PREFIJO_ASUNTO[ctx.kind === 'adherencia' ? 'adherencia' : 'visita'] + (ctx.obra || '') + ' – ')) return { ok: false, error: 'mensaje_no_corresponde' };
  if ((ctx.cliente && !x.cuerpo.includes(ctx.cliente)) || (ctx.obra && !x.cuerpo.includes(ctx.obra))) return { ok: false, error: 'mensaje_no_corresponde' };
  if (typeof x.nombre !== 'string' || !/\.pdf$/i.test(x.nombre) || /[\\/\r\n]/.test(x.nombre) || x.nombre.length > 200) return { ok: false, error: 'archivo_invalido' };
  if (typeof x.base64 !== 'string' || !x.base64) return { ok: false, error: 'archivo_invalido' };
  if (bytesDeBase64(x.base64) > LIMITE_BYTES) return { ok: false, error: 'demasiado_grande' };
  if (!x.base64.startsWith(FIRMA_PDF_B64) || !/^[A-Za-z0-9+/]+={0,2}$/.test(x.base64)) return { ok: false, error: 'archivo_invalido' };
  return { ok: true, solicitud: { registro_id: String(x.registro_id || ''), para: x.para, asunto: x.asunto, cuerpo: x.cuerpo, nombre: x.nombre, base64: x.base64 } };
}

// El Apps Script publicado antes de esta versión no conoce la acción 'correo': responde "acción desconocida".
export function traducirRespuestaAppsScript(r: any): { ok: true } | { ok: false; error: string; detalle?: string } {
  if (r && r.ok === true) return { ok: true };
  if (r && r.error === 'acción desconocida') return { ok: false, error: 'pendiente_publicar' };
  return { ok: false, error: 'apps_script', detalle: String((r && r.error) || 'sin respuesta') };
}
