// Edge Function respaldo-drive: envía la cola de respaldo al Apps Script de Google Drive.
// Solo la llama pg_cron con el token de Vault (header x-respaldo-token). Secrets: APPS_SCRIPT_URL, RESPALDO_CLAVE.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { encodeBase64 } from 'jsr:@std/encoding@1.0.5/base64';
import { procesarLote, descargaNoExiste, type Cola, type Deps } from '../_shared/proceso.ts';
import type { Archivo } from '../_shared/envios.ts';
import { nombreCopia, seleccionarParaBorrar, type ArchivoRetencion } from '../_shared/noche.ts';

const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const sb = createClient(Deno.env.get('SUPABASE_URL')!, SERVICE_KEY, { auth: { persistSession: false } });
const LIMITE = 6; // ~10 s por envío; deja margen bajo el límite de 150 s de la función.

// Token interno guardado en Vault (respaldo_cron_token); lo envía pg_cron vía app.respaldo_llamar().
async function tokenValido(token: string | null): Promise<boolean> {
  if (!token) return false;
  const { data, error } = await sb.rpc('respaldo_token_valido', { p_token: token });
  return !error && data === true;
}

async function uno(tabla: string, col: string, val: unknown, campos = '*') {
  if (val == null) return null;
  const { data, error } = await sb.from(tabla).select(campos).eq(col, val).maybeSingle();
  if (error) throw new Error(`${tabla}: ${error.message}`);
  return data as Record<string, any> | null;
}

async function cargar(c: Cola): Promise<Record<string, unknown> | null> {
  switch (c.tabla) {
    case 'ent_entregas': {
      const entrega = await uno('ent_entregas', 'id', c.registro_id);
      if (!entrega) return null;
      const guia = await uno('ent_guias', 'id', entrega.guia_id);
      const { data: devoluciones, error } = await sb.from('ent_devoluciones').select('*').eq('entrega_id', entrega.id);
      if (error) throw new Error(`ent_devoluciones: ${error.message}`);
      return { entrega, guia, devoluciones: devoluciones || [] };
    }
    case 'mtto_docs': {
      const i = c.registro_id.indexOf(':');
      const { data, error } = await sb.from('mtto_docs').select('*')
        .eq('coleccion', c.registro_id.slice(0, i)).eq('id', c.registro_id.slice(i + 1)).maybeSingle();
      if (error) throw new Error(`mtto_docs: ${error.message}`);
      return data;
    }
    case 'eventos': {
      const ev = await uno('eventos', 'id', c.registro_id);
      if (!ev) return null;
      const silo = await uno('silos', 'id', ev.silo_id, 'codigo');
      return { ...ev, silo_codigo: silo?.codigo ?? null };
    }
    case 'crm_visits': {
      const v = await uno('crm_visits', 'id', c.registro_id);
      if (!v) return null;
      const cli = await uno('crm_clients', 'id', v.client_id, 'name');
      const ven = await uno('crm_profiles', 'id', v.user_id, 'name');
      return { ...v, cliente_nombre: cli?.name ?? null, vendedor_nombre: ven?.name ?? null };
    }
    default:
      return await uno(c.tabla, 'id', c.registro_id);
  }
}

async function descargar(a: Archivo): Promise<string | null> {
  if ('base64' in a) return a.base64;
  const { data, error } = await sb.storage.from(a.bucket).download(a.ruta);
  if (error) {
    // Solo "no existe" se anota como foto faltante; cualquier otro error se reintenta más tarde.
    if (descargaNoExiste(error)) return null;
    throw new Error(`descarga ${a.bucket}/${a.ruta}: ${(error as any).originalError?.status || error.message}`);
  }
  return encodeBase64(new Uint8Array(await data!.arrayBuffer()));
}

async function enviar(body: unknown) {
  const r = await fetch(Deno.env.get('APPS_SCRIPT_URL')!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clave: Deno.env.get('RESPALDO_CLAVE'), ...(body as object) }),
    redirect: 'follow',
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { ok: false, error: `respuesta no JSON (${r.status})` }; }
}

const deps: Deps = {
  async pendientes(limite) { return await lote('procesar', limite); },
  cargar,
  async numero(colaId) {
    const { data, error } = await sb.rpc('respaldo_asignar_numero', { p_cola_id: colaId });
    if (error) throw new Error(error.message);
    return data as number;
  },
  descargar,
  enviar,
  async marcar(c, cambios) {
    // Condicional: si el registro se editó o borró durante el envío, la fila cambió y no se pisa.
    const { error } = await sb.from('respaldo_cola').update(cambios)
      .eq('id', c.id).eq('estado', c.estado).eq('listo_desde', c.listo_desde);
    if (error) throw new Error(error.message);
  },
  async registrarArchivos(colaId, archivos) {
    // Nunca reasigna a otro registro una ruta ya registrada (respaldo_registrar_archivos).
    const { error } = await sb.rpc('respaldo_registrar_archivos', { p_cola_id: colaId, p_archivos: archivos });
    if (error) throw new Error(error.message);
  },
};

async function lote(modo: string, limite: number): Promise<Cola[]> {
  const { data, error } = await sb.rpc('respaldo_pendientes', { p_modo: modo, p_limite: limite });
  if (error) throw new Error(error.message);
  return (data || []) as Cola[];
}

// Copia diaria: todas las tablas en un JSON comprimido, a 'Base completa/' (el script conserva 30).
async function copiaDiaria() {
  const { data, error } = await sb.rpc('respaldo_volcado');
  if (error) throw new Error(error.message);
  const gz = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(gz).arrayBuffer());
  const r = await enviar({ accion: 'copia', nombre: nombreCopia(new Date()), base64: encodeBase64(bytes) });
  return { ok: !!r.ok, error: r.error, bytes: bytes.length };
}

// Retención: libera de Supabase los archivos de más de 60 días ya confirmados en Drive.
async function retener() {
  const { data, error } = await sb.rpc('respaldo_archivos_retencion');
  if (error) throw new Error(error.message);
  const filas = (data || []) as Array<ArchivoRetencion & { ruta: string }>;
  const ids = new Set(seleccionarParaBorrar(filas, new Date()));
  const porBucket = new Map<string, Array<{ id: number; ruta: string }>>();
  for (const f of filas) if (ids.has(f.id)) porBucket.set(f.bucket, [...(porBucket.get(f.bucket) || []), { id: f.id, ruta: f.ruta }]);
  let borrados = 0;
  for (const [bucket, lista] of porBucket) {
    for (let i = 0; i < lista.length; i += 100) {
      const parte = lista.slice(i, i + 100);
      const { error: e1 } = await sb.storage.from(bucket).remove(parte.map((p) => p.ruta));
      if (e1) continue;
      const { error: e2 } = await sb.from('respaldo_archivos').update({ borrado_supabase_at: new Date().toISOString() }).in('id', parte.map((p) => p.id));
      if (!e2) borrados += parte.length;
    }
  }
  return { borrados, candidatos: ids.size };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST' || !(await tokenValido(req.headers.get('x-respaldo-token')))) return new Response('no autorizado', { status: 401 });
  try {
    const { modo } = await req.json().catch(() => ({ modo: 'procesar' }));
    if (modo !== 'noche') return Response.json({ modo: 'procesar', ...(await procesarLote(deps, LIMITE)) });
    const reintentos = await procesarLote({ ...deps, pendientes: (n) => lote('noche', n) }, LIMITE);
    const copia = await copiaDiaria().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    const retencion = await retener().catch((e) => ({ borrados: 0, error: String(e?.message || e) }));
    return Response.json({ modo: 'noche', reintentos, copia, retencion });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
