// Procesa la cola de respaldo: arma cada envío, descarga sus archivos y lo manda al Apps Script.
// Lógica pura: todas las APIs (Supabase, Storage, fetch) llegan como dependencias.

import { armarEnvio, type App, type Archivo } from './envios.ts';

export type Cola = {
  id: number;
  app: App;
  tabla: string;
  registro_id: string;
  estado: 'pendiente' | 'enviado' | 'error' | 'eliminado';
  intentos: number;
  ultimo_error: string | null;
  numero: number | null;
  drive_folder_id: string | null;
  drive_url: string | null;
  enviado_at: string | null;
  listo_desde: string;
};

export type RespuestaScript = {
  ok: boolean;
  error?: string;
  folderId?: string;
  folderUrl?: string;
  archivos?: Array<{ nombre: string; fileId: string }>;
};

export type ArchivoRegistrado = { bucket: string; ruta: string; nombre_drive: string; drive_file_id: string; subido_at: string };

export type Deps = {
  pendientes(limit: number): Promise<Cola[]>;
  cargar(c: Cola): Promise<Record<string, unknown> | null>;
  numero(colaId: number): Promise<number>;
  descargar(a: Archivo): Promise<string | null>; // null = el archivo no existe; lanza si es un error temporal
  enviar(body: unknown): Promise<RespuestaScript>;
  marcar(c: Cola, cambios: Partial<Cola>): Promise<void>; // actualiza solo si la fila sigue igual (estado, listo_desde)
  registrarArchivos(colaId: number, archivos: ArchivoRegistrado[]): Promise<void>;
  ahora?: () => string;
};

class ErrorEnvio extends Error {}

// Error de descarga de Storage: ¿el archivo no existe (se anota como faltante) o es un fallo temporal?
// Storage responde 400 con cuerpo vacío para un objeto inexistente.
export function descargaNoExiste(error: any): boolean {
  const st = Number(error?.statusCode ?? error?.status ?? error?.originalError?.status);
  return st === 400 || st === 404 || /not.?found/i.test(String(error?.message || ''));
}

async function procesarEliminado(c: Cola, d: Deps, ahora: string) {
  if (c.numero != null) {
    const r = await d.enviar({ accion: 'eliminado', app: c.app, numero: c.numero });
    if (!r.ok) throw new ErrorEnvio(r.error || 'error del script');
  }
  await d.marcar(c, { enviado_at: ahora, intentos: 0, ultimo_error: null });
}

async function procesarEnvio(c: Cola, d: Deps, ahora: string) {
  const datos = await d.cargar(c);
  if (!datos) throw new ErrorEnvio('registro no encontrado');
  const numero = await d.numero(c.id);
  const env = armarEnvio(c.app, c.tabla, datos, numero);

  const archivos: Array<{ nombre: string; base64: string }> = [];
  const origen = new Map<string, { bucket: string; ruta: string }>();
  const faltan: string[] = [];
  for (const a of env.archivos) {
    if ('base64' in a) {
      archivos.push({ nombre: a.nombre, base64: a.base64 });
      origen.set(a.nombre, { bucket: 'mtto_docs', ruta: `${c.registro_id}/${a.nombre}` });
      continue;
    }
    const b64 = await d.descargar(a);
    if (b64 == null) { faltan.push(a.nombre); continue; }
    archivos.push({ nombre: a.nombre, base64: b64 });
    origen.set(a.nombre, { bucket: a.bucket, ruta: a.ruta });
  }
  const fila = { ...env.fila };
  if (faltan.length) {
    const nota = faltan.map((n) => `falta ${n}`).join(', ');
    fila['Observaciones'] = fila['Observaciones'] ? `${fila['Observaciones']}; ${nota}` : nota;
  }

  const r = await d.enviar({ accion: 'envio', envio: { ...env, fila, archivos } });
  if (!r.ok) throw new ErrorEnvio(r.error || 'error del script');

  await d.marcar(c, {
    estado: 'enviado', numero, drive_folder_id: r.folderId ?? null, drive_url: r.folderUrl ?? null,
    enviado_at: ahora, intentos: 0, ultimo_error: null,
  });
  const registrados: ArchivoRegistrado[] = (r.archivos || [])
    .filter((a) => origen.has(a.nombre))
    .map((a) => ({ ...origen.get(a.nombre)!, nombre_drive: a.nombre, drive_file_id: a.fileId, subido_at: ahora }));
  if (registrados.length) await d.registrarArchivos(c.id, registrados);
}

export async function procesarLote(d: Deps, limite = 10): Promise<{ ok: number; error: number }> {
  const ahora = d.ahora ? d.ahora() : new Date().toISOString();
  const res = { ok: 0, error: 0 };
  for (const c of await d.pendientes(limite)) {
    try {
      if (c.estado === 'eliminado') await procesarEliminado(c, d, ahora);
      else await procesarEnvio(c, d, ahora);
      res.ok++;
    } catch (e) {
      res.error++;
      const msg = String((e as Error)?.message || e).slice(0, 500);
      // intentos ya se sumó al reclamar la fila (respaldo_pendientes), así un corte a medias también cuenta
      await d.marcar(c, { estado: c.estado === 'eliminado' ? 'eliminado' : 'error', ultimo_error: msg });
    }
  }
  return res;
}
