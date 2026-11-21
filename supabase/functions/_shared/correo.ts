// Validaciones puras de la función terreno-correo (sin red ni base de datos): el pedido del navegador antes de
// reenviarlo al Apps Script, y la traducción de la respuesta del Apps Script.

export const LIMITE_BYTES = 8 * 1024 * 1024;
const FIRMA_PDF_B64 = 'JVBERi0'; // "%PDF-" en base64

// Misma regla que lib.js del Apps Script y TC.correoValido: una sola dirección, sin espacios, comas ni saltos de línea.
export const correoValido = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/.test(s);

export const bytesDeBase64 = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

export type Solicitud = { registro_id: string; para: string; asunto: string; cuerpo: string; nombre: string; base64: string };

// `cierreEmail`: el correo del cliente que la visita tiene GUARDADO. El destino debe ser exactamente ese: así un pedido
// manipulado o desfasado no puede mandar el informe a otra dirección.
export function validarSolicitud(b: unknown, cierreEmail: string | null | undefined):
  { ok: true; solicitud: Solicitud } | { ok: false; error: string } {
  const x = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  if (!correoValido(x.para)) return { ok: false, error: 'correo_invalido' };
  if (!correoValido(cierreEmail) || x.para.trim().toLowerCase() !== cierreEmail.trim().toLowerCase()) return { ok: false, error: 'correo_no_coincide' };
  if (typeof x.asunto !== 'string' || !x.asunto.trim() || x.asunto.length > 300 || /[\r\n]/.test(x.asunto)) return { ok: false, error: 'solicitud_invalida' };
  if (typeof x.cuerpo !== 'string' || !x.cuerpo.trim() || x.cuerpo.length > 50000) return { ok: false, error: 'solicitud_invalida' };
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
