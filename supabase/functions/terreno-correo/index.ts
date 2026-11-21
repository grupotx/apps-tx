// Edge Function terreno-correo (verify_jwt activo): envía al cliente la copia del informe de una visita.
// La llama la app con la sesión del PM: POST { registro_id, para, asunto, cuerpo, nombre, base64 }.
// Autoriza con el token del usuario (app.rt_activo() vía rt_tengo_acceso, y que la visita sea suya o sea admin),
// valida el pedido (_shared/correo.ts) y recién entonces llama al Apps Script, que envía desde controldegestion@grupotx.cl
// con copia al PM. La clave del Apps Script vive solo aquí (secrets APPS_SCRIPT_URL y RESPALDO_CLAVE): nunca llega al navegador.
// Respuesta siempre JSON { ok, error?, detalle? }. Si el Apps Script aún no conoce la acción: { ok: false, error: 'pendiente_publicar' }.
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import { correoValido, traducirRespuestaAppsScript, validarSolicitud } from '../_shared/correo.ts';

const URL_SB = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
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
  const responder = (cuerpo: Record<string, unknown>, status = 200) => Response.json(cuerpo, { status, headers: h });
  if (req.method === 'OPTIONS') return new Response('ok', { headers: h });
  if (req.method !== 'POST') return responder({ ok: false, error: 'metodo_no_permitido' }, 405);

  const auth = req.headers.get('Authorization') || '';
  const usuario = createClient(URL_SB, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  // Solo usuarios con sesión: la clave pública (rol anon) también pasa la verificación JWT del gateway.
  const { data: quien } = await usuario.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  const user = quien?.user;
  if (!user) return responder({ ok: false, error: 'no_autorizado' }, 401);

  const body = await req.json().catch(() => null);
  const registroId = body && typeof body.registro_id === 'string' ? body.registro_id : '';

  // 1) Acceso al módulo (app.rt_activo()) y 2) la visita es suya, o es admin. Todo con el token del usuario: las reglas RLS son las de la app.
  const { data: acceso, error: eAcceso } = await usuario.rpc('rt_tengo_acceso');
  if (eAcceso || acceso !== true) return responder({ ok: false, error: 'sin_acceso' }, 403);
  if (!registroId) return responder({ ok: false, error: 'registro_no_existe' }, 404);
  const { data: reg } = await usuario.from('registros').select('id, kind, autor, cliente, obra, datos').eq('id', registroId).maybeSingle();
  if (!reg || (reg.kind !== 'visita' && reg.kind !== 'adherencia')) return responder({ ok: false, error: 'registro_no_existe' }, 404);
  const { data: perfil } = await usuario.from('profiles').select('email, rol, activo').eq('id', user.id).maybeSingle();
  const esAdmin = !!(perfil && perfil.activo && perfil.rol === 'admin');
  if (reg.autor !== user.id && !esAdmin) return responder({ ok: false, error: 'no_es_autor' }, 403);

  // La copia va al PM que envía (dato del servidor, no del pedido).
  const copia = perfil?.email || user.email;
  if (!correoValido(copia)) return responder({ ok: false, error: 'sin_acceso' }, 403);

  const v = validarSolicitud(body, { kind: reg.kind, cierreEmail: reg.kind === 'adherencia' ? reg.datos?.correo_cliente : reg.datos?.cierre?.email, cliente: reg.cliente, obra: reg.obra });
  if (!v.ok) return responder({ ok: false, error: v.error }, 400);
  const s = v.solicitud;

  let respuesta: unknown;
  try {
    const r = await fetch(Deno.env.get('APPS_SCRIPT_URL')!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({
        clave: Deno.env.get('RESPALDO_CLAVE'), accion: 'correo',
        para: s.para, copia, responderA: copia, asunto: s.asunto, cuerpo: s.cuerpo, nombre: s.nombre, base64: s.base64,
      }),
    });
    const t = await r.text();
    try { respuesta = JSON.parse(t); } catch { respuesta = { ok: false, error: `respuesta no JSON (${r.status})` }; }
  } catch (e) {
    respuesta = { ok: false, error: String((e as Error)?.message || e) };
  }
  const t = traducirRespuestaAppsScript(respuesta);
  return responder(t, t.ok ? 200 : t.error === 'pendiente_publicar' ? 200 : 502);
});
