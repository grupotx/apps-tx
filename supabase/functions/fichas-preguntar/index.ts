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
const GEN_MODEL = Deno.env.get('GEMINI_GEN_MODEL') || 'gemini-3.5-flash-lite';
// Modelos a probar en orden: el principal (rápido) y, si se demora o falla, gemini-3.5-flash.
const MODELOS = [...new Set([GEN_MODEL, 'gemini-3.5-flash'])];
const THINKING_LEVEL = Deno.env.get('GEMINI_THINKING_LEVEL') || 'low';

class TiempoAgotado extends Error {}

// Gemini a veces se cuelga (se vieron respuestas de 86 s y 150 s, el tope de Supabase): se corta a los
// `ms` y se reintenta UNA vez (el cuelgue casi siempre es puntual). Peor caso total: 2*15 s + 2*30 s
// = 90 s, bajo el límite de 150 s de la función.
async function fetchConTope(url: string, init: RequestInit, ms: number, intentos = 2): Promise<Response> {
  for (let intento = 1; ; intento++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
      if (r.status < 500 && r.status !== 429) return r;
      if (intento === intentos) return r;
    } catch (e) {
      if (intento === intentos) throw (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? new TiempoAgotado() : e;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

async function embeberPregunta(pregunta: string, apiKey: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:embedContent`;
  const r = await fetchConTope(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ model: EMBED_MODEL, content: { parts: [{ text: pregunta }] }, outputDimensionality: EMBED_DIM, taskType: 'RETRIEVAL_QUERY' }),
  }, 15000);
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
async function generarRespuesta(pregunta: string, fragmentos: { contenido: string; ficha_id: string }[], fichasPorId: Map<string, string>, apiKey: string): Promise<{ texto: string; citadas: string[] } | null> {
  const contexto = fragmentos.map((f) => `[Ficha: ${fichasPorId.get(f.ficha_id) || f.ficha_id}]\n${f.contenido}`).join('\n\n---\n\n');
  const prompt = `Eres un asistente para vendedores y asesores técnicos de Grupo TX. Responde la pregunta usando SOLO la información de las fichas técnicas de abajo, sin inventar nada.

Reglas:
- Si solo puedes responder una PARTE de la pregunta, responde esa parte y di explícitamente qué parte no aparece en las fichas (no adivines la que falta).
- Si el dato está en otra unidad que la preguntada (por ejemplo, por galón en vez de por litro), entrégalo tal como aparece en la ficha, indicando la unidad.
- Solo si NINGUNA parte de la pregunta se puede responder con estas fichas, responde EXACTAMENTE ${SENTINEL_SIN_INFO} y nada más (sin línea FUENTES).
- Sé breve y directo. Puedes usar **negrita** para los datos clave.
- Al final, en una última línea aparte, escribe FUENTES: seguido de los nombres EXACTOS (tal como aparecen entre corchetes en "[Ficha: ...]") de las fichas que realmente usaste, separados por " | ".

FICHAS:
${contexto}

PREGUNTA: ${pregunta}`;
  // La latencia de Gemini en el tier gratuito es muy variable (45 s para 190 tokens de salida): se prueba
  // primero el modelo rápido y, si se demora más de 20 s o falla, se cae al siguiente en vez de reintentar
  // el mismo. Peor caso: 20 s + 30 s (más las dos consultas previas, < 150 s).
  let data: any = null;
  let ultimoError: unknown = new Error('Gemini: sin modelos disponibles.');
  for (const [i, modelo] of MODELOS.entries()) {
    const t0 = Date.now();
    try {
      const r = await fetchConTope(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        // Gemini 3 razona en nivel "high" por defecto; para leer unos fragmentos y responder basta "low".
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVEL } } }),
      }, i === MODELOS.length - 1 ? 30000 : 20000, 1);
      console.log('fichas-preguntar gen', JSON.stringify({ modelo, ms: Date.now() - t0, promptChars: prompt.length, status: r.status }));
      if (r.ok) { data = await r.json(); break; }
      ultimoError = new Error(`Gemini generateContent (${modelo}) falló: ${r.status} ${await r.text()}`);
    } catch (e) {
      console.log('fichas-preguntar gen falló', JSON.stringify({ modelo, ms: Date.now() - t0 }));
      ultimoError = e;
    }
  }
  if (!data) throw ultimoError;
  console.log('fichas-preguntar uso', JSON.stringify({ uso: data?.usageMetadata, fin: data?.candidates?.[0]?.finishReason }));
  const bruto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!bruto) throw new Error('Gemini generateContent: respuesta sin texto.');
  const t = bruto.trim();
  if (t.startsWith(SENTINEL_SIN_INFO)) return null;
  // La última línea "FUENTES: a | b" no es parte de la respuesta: se separa para citar solo esas fichas.
  const m = t.match(/\n?[ \t]*FUENTES:[ \t]*(.*)$/i);
  const citadas = m ? m[1].split('|').map((s) => s.replace(/[*_`]/g, '').trim()).filter(Boolean) : [];
  return { texto: (m ? t.slice(0, m.index) : t).trim(), citadas };
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
      if (e instanceof TiempoAgotado) return json({ error: 'El asistente tardó demasiado en responder. Intenta de nuevo.' }, 504);
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

    let resultado: { texto: string; citadas: string[] } | null;
    try {
      resultado = await generarRespuesta(pregunta, fragmentos, nombrePorId, geminiKey);
    } catch (e) {
      console.error('fichas-preguntar generar', e);
      if (e instanceof TiempoAgotado) return json({ error: 'El asistente tardó demasiado en responder. Intenta de nuevo.' }, 504);
      return json({ error: 'No se pudo generar la respuesta.' }, 500);
    }
    if (resultado === null) return json({ sin_resultado: true });

    // Solo se muestran como fuente las fichas que el modelo dice haber usado; si no se pudo leer su
    // lista (o no coincide con ninguna), se cae a todas las que pasaron el umbral de similitud.
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    // El modelo a veces cita con el nombre corto ("Pintura Techo" en vez de "PINTURAS - PINTURA TECHO"):
    // coincide si un nombre contiene al otro (con al menos 4 letras, para no cruzar por casualidad).
    const citadasN = resultado.citadas.map(norm).filter((c) => c.length >= 4);
    const soloCitadas = (fichas ?? []).filter((f: { nombre: string }) => {
      const n = norm(f.nombre);
      return citadasN.some((c) => n === c || n.includes(c) || c.includes(n));
    });
    console.log('fichas-preguntar fuentes', JSON.stringify({ citadas: resultado.citadas, devueltas: soloCitadas.length, candidatas: (fichas ?? []).length }));
    return json({ respuesta: resultado.texto, fichas: soloCitadas.length ? soloCitadas : (fichas ?? []) });
  } catch (e) {
    console.error('fichas-preguntar', e);
    return json({ error: 'Error interno.' }, 500);
  }
});
