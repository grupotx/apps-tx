import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': 'https://apps.grouptx.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Resetea el 2FA de otro usuario (admin perdió el celular con el autenticador). Solo un admin central
// puede llamar esto, verificado con el JWT real de quien llama (no con lo que el cliente diga ser).
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: userRes, error: userErr } = await caller.auth.getUser();
    if (userErr || !userRes?.user) return json({ error: 'Sesión inválida.' }, 401);
    const { data: isAdmin, error: permErr } = await caller.rpc('soy_admin');
    if (permErr || isAdmin !== true) return json({ error: 'Solo un administrador puede hacer esto.' }, 403);

    const body = await req.json();
    const admin = createClient(url, service, { auth: { persistSession: false } });

    if (body.action === 'reset_mfa') {
      const userId = String(body.user_id || '');
      if (!userId) return json({ error: 'Falta el usuario.' }, 400);
      // Defensa en profundidad: un admin no puede resetear su propio 2FA por esta vía (si perdió su
      // propio celular, otro admin lo resetea, como quedó definido para este flujo).
      if (userId === userRes.user.id) return json({ error: 'No puedes resetear tu propio 2FA: pide a otro administrador que lo haga.' }, 400);
      const { data: listed, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
      if (listErr) { console.error('admin-mfa listFactors', listErr); return json({ error: 'No se pudo consultar el 2FA de ese usuario.' }, 400); }
      const factors = listed?.factors ?? [];
      for (const f of factors) {
        const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
        if (delErr) { console.error('admin-mfa deleteFactor', delErr); return json({ error: 'No se pudo resetear el 2FA de ese usuario.' }, 400); }
      }
      return json({ ok: true, removed: factors.length });
    }
    return json({ error: 'Acción no reconocida.' }, 400);
  } catch (e) {
    console.error('admin-mfa', e);
    return json({ error: 'Error interno.' }, 500);
  }
});
