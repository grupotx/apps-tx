import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': 'https://apps.grouptx.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const EMBED_MODEL = 'models/gemini-embedding-001';
const EMBED_DIM = 768; // ver supabase/migrations/20261126_fichas_tecnicas.sql
const MATCH_COUNT = 6;
const MATCH_THRESHOLD = 0.6;
// Nombre del modelo generativo configurable por variable de entorno: el panorama de modelos Gemini
// cambia seguido (ver docs/superpowers/specs/2026-11-26-fichas-tecnicas-bot-design.md), así que un
// valor equivocado se corrige sin redeploy. Default: el flash más económico confirmado disponible al
// escribir esto (verificar contra aistudio.google.com/rate-limit si deja de responder).
const GEN_MODEL = Deno.env.get('GEMINI_GEN_MODEL') || 'gemini-3.5-flash';

async function embeberPregunta(pregunta: string, apiKey: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ model: EMBED_MODEL, content: { parts: [{ text: pregunta }] }, outputDimensionality: EMBED_DIM, taskType: 'RETRIEVAL_QUERY' }),
  });
  if (!r.ok) throw new Error(`Gemini embeddings falló: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values)) throw new Error('Gemini embeddings: respuesta sin vector.');
  return values;
}

const SENTINEL_SIN_INFO = 'SIN_INFORMACION';

// Devuelve el texto de la respuesta, o null si el propio modelo dice que la información no alcanza.
// No basta con el umbral de similitud de la búsqueda (match_fichas_fragmentos): un fragmento puede
// pasar el umbral y seguir sin responder la pregunta, y nunca hay que citar una ficha en ese caso.
async function generarRespuesta(pregunta: string, fragmentos: { contenido: string; ficha_id: string }[], fichasPorId: Map<string, string>, apiKey: string): Promise<string | null> {
  const contexto = fragmentos.map((f, i) => `[Ficha: ${fichasPorId.get(f.ficha_id) || f.ficha_id}]\n${f.contenido}`).join('\n\n---\n\n');
  const prompt = `Eres un asistente para vendedores y asesores técnicos de Grupo TX. Responde la pregunta usando SOLO la información de las fichas técnicas de abajo. Si la información no alcanza para responder con certeza, responde EXACTAMENTE con el texto ${SENTINEL_SIN_INFO} y nada más — ni una palabra antes ni después. Si sí alcanza, responde normalmente y cita de qué ficha sacaste cada dato cuando sea relevante.\n\nFICHAS:\n${contexto}\n\nPREGUNTA: ${pregunta}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEN_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!r.ok) throw new Error(`Gemini generateContent falló: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!texto) throw new Error('Gemini generateContent: respuesta sin texto.');
  return texto.trim() === SENTINEL_SIN_INFO ? null : texto;
}

// Responde una pregunta sobre las fichas técnicas con RAG: busca los fragmentos más relevantes de
// TODAS las fichas (no manda las fichas completas) y solo esos se le pasan al modelo para responder.
// Cualquier usuario CRM activo puede preguntar (crm_is_active()), no solo quien puede editar.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const geminiKey = Deno.env.get('GEMINI_API_KEY')!;

    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: activo, error: activoErr } = await caller.rpc('crm_is_active');
    if (activoErr || activo !== true) return json({ error: 'Solo usuarios activos del CRM pueden preguntar.' }, 403);

    const bodyIn = await req.json();
    const pregunta = String(bodyIn.pregunta || '').trim();
    if (!pregunta) return json({ error: 'Falta la pregunta.' }, 400);

    let embedding: number[];
    try {
      embedding = await embeberPregunta(pregunta, geminiKey);
    } catch (e) {
      console.error('fichas-preguntar embeddings', e);
      return json({ error: 'No se pudo procesar la pregunta.' }, 500);
    }

    const { data: fragmentos, error: matchErr } = await caller.rpc('match_fichas_fragmentos', {
      query_embedding: embedding,
      match_count: MATCH_COUNT,
      match_threshold: MATCH_THRESHOLD,
    });
    if (matchErr) { console.error('fichas-preguntar match', matchErr); return json({ error: 'No se pudo buscar en las fichas.' }, 500); }
    if (!fragmentos || fragmentos.length === 0) return json({ sin_resultado: true });

    const fichaIds = [...new Set(fragmentos.map((f: { ficha_id: string }) => f.ficha_id))];
    const { data: fichas, error: fichasErr } = await caller.from('fichas_tecnicas').select('id,nombre,storage_path').in('id', fichaIds);
    if (fichasErr) { console.error('fichas-preguntar fichas', fichasErr); return json({ error: 'No se pudo resolver las fichas citadas.' }, 500); }
    const nombrePorId = new Map((fichas ?? []).map((f: { id: string; nombre: string }) => [f.id, f.nombre]));

    let respuesta: string | null;
    try {
      respuesta = await generarRespuesta(pregunta, fragmentos, nombrePorId, geminiKey);
    } catch (e) {
      console.error('fichas-preguntar generar', e);
      return json({ error: 'No se pudo generar la respuesta.' }, 500);
    }
    if (respuesta === null) return json({ sin_resultado: true });

    return json({ respuesta, fichas: fichas ?? [] });
  } catch (e) {
    console.error('fichas-preguntar', e);
    return json({ error: 'Error interno.' }, 500);
  }
});
