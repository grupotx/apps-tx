// Edge Function foto-archivada: entrega una foto que ya no está en Supabase (archivada en Drive),
// solo si el usuario que la pide puede leer el registro dueño de la foto. POST {bucket, ruta} con su JWT.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { decodeBase64 } from 'jsr:@std/encoding@1.0.5/base64';
import { puedeVer } from '../_shared/permiso.ts';

const URL_SB = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_SB, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const ORIGENES = ['https://apps.grouptx.app', 'http://localhost:5173'];

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGENES.includes(o) ? o : ORIGENES[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return new Response('método no permitido', { status: 405, headers: h });
  const auth = req.headers.get('Authorization') || '';
  const { bucket, ruta } = await req.json().catch(() => ({}));
  const usuario = createClient(URL_SB, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });

  const r = await puedeVer({
    async archivo(b, p) {
      const { data } = await admin.from('respaldo_archivos').select('drive_file_id, respaldo_cola(tabla, registro_id)')
        .eq('bucket', b).eq('ruta', p).maybeSingle();
      const c = (data as any)?.respaldo_cola;
      return data && c ? { tabla: c.tabla, registro_id: c.registro_id, drive_file_id: (data as any).drive_file_id } : null;
    },
    async leerComoUsuario(tabla, id) {
      let q = usuario.from(tabla).select('id').limit(1);
      if (tabla === 'mtto_docs') { const i = id.indexOf(':'); q = q.eq('coleccion', id.slice(0, i)).eq('id', id.slice(i + 1)); }
      else q = q.eq('id', id);
      const { data, error } = await q;
      return !error && !!data && data.length > 0;
    },
  }, String(bucket || ''), String(ruta || ''));

  if (!r.ok) return new Response(r.status === 403 ? 'sin acceso' : 'no encontrada', { status: r.status, headers: h });
  const s = await fetch(Deno.env.get('APPS_SCRIPT_URL')!, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ clave: Deno.env.get('RESPALDO_CLAVE'), accion: 'archivo', fileId: r.fileId }),
  }).then((x) => x.json()).catch(() => null);
  if (!s?.ok) return new Response('no disponible', { status: 502, headers: h });
  return new Response(decodeBase64(s.base64), {
    headers: { ...h, 'Content-Type': s.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' },
  });
});
