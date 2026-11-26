import { createClient } from 'npm:@supabase/supabase-js@2';
import { getDocumentProxy, extractText } from 'npm:unpdf@1.9.1';

const cors = {
  'Access-Control-Allow-Origin': 'https://apps.grouptx.app',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_PDF_BYTES = 20 * 1024 * 1024; // mismo tope que storage.buckets.file_size_limit (migración)
const EMBED_MODEL = 'models/gemini-embedding-001';
const EMBED_DIM = 768; // ver comentario en supabase/migrations/20261126_fichas_tecnicas.sql
const CHUNK_WORDS = 700;
const CHUNK_OVERLAP_WORDS = 100;

function partirEnFragmentos(texto: string): string[] {
  const palabras = texto.split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return [];
  const fragmentos: string[] = [];
  let i = 0;
  while (i < palabras.length) {
    fragmentos.push(palabras.slice(i, i + CHUNK_WORDS).join(' '));
    if (i + CHUNK_WORDS >= palabras.length) break;
    i += CHUNK_WORDS - CHUNK_OVERLAP_WORDS;
  }
  return fragmentos;
}

async function embeberFragmentos(fragmentos: string[], apiKey: string): Promise<number[][]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/${EMBED_MODEL}:batchEmbedContents`;
  const body = {
    requests: fragmentos.map((f) => ({
      model: EMBED_MODEL,
      content: { parts: [{ text: f }] },
      outputDimensionality: EMBED_DIM,
      taskType: 'RETRIEVAL_DOCUMENT',
    })),
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Gemini embeddings falló: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const embeddings = data?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== fragmentos.length) {
    throw new Error('Gemini embeddings: respuesta incompleta.');
  }
  return embeddings.map((e: { values: number[] }) => e.values);
}

// Sube o reemplaza una ficha técnica (PDF) y la indexa para el bot de consulta RAG. Solo quien tiene
// el permiso 'productos' del CRM puede llamar esto, verificado con el JWT real de quien llama (no con
// lo que el cliente diga ser) — mismo patrón que admin-mfa con soy_admin().
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const geminiKey = Deno.env.get('GEMINI_API_KEY')!;

    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: tienePermiso, error: permErr } = await caller.rpc('crm_has_perm', { p: 'productos' });
    if (permErr || tienePermiso !== true) return json({ error: 'Solo quien puede editar el catálogo puede subir fichas técnicas.' }, 403);

    const bodyIn = await req.json();
    const nombre = String(bodyIn.nombre || '').trim();
    const categoria = String(bodyIn.categoria || '').trim();
    const fichaIdIn = bodyIn.ficha_id ? String(bodyIn.ficha_id) : null;
    const pdfB64 = String(bodyIn.pdf_base64 || '');
    if (!nombre || !pdfB64) return json({ error: 'Falta el nombre o el PDF.' }, 400);

    let pdfBytes: Uint8Array;
    try {
      pdfBytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
    } catch {
      return json({ error: 'El PDF no es un base64 válido.' }, 400);
    }
    const header = new TextDecoder().decode(pdfBytes.slice(0, 5));
    if (header !== '%PDF-') return json({ error: 'El archivo no es un PDF.' }, 400);
    if (pdfBytes.byteLength > MAX_PDF_BYTES) return json({ error: 'El PDF supera los 20 MB permitidos.' }, 400);

    let texto: string;
    try {
      const doc = await getDocumentProxy(pdfBytes);
      const { text } = await extractText(doc, { mergePages: true });
      texto = (text || '').trim();
    } catch (e) {
      console.error('fichas-ingesta extractText', e);
      texto = '';
    }
    if (texto.length < 50) return json({ error: 'No se pudo leer texto del PDF.' }, 400);

    const fragmentosTexto = partirEnFragmentos(texto);
    let vectores: number[][];
    try {
      vectores = await embeberFragmentos(fragmentosTexto, geminiKey);
    } catch (e) {
      console.error('fichas-ingesta embeddings', e);
      return json({ error: 'No se pudieron generar los embeddings de la ficha.' }, 400);
    }

    const admin = createClient(url, service, { auth: { persistSession: false } });

    const esReemplazo = !!fichaIdIn;
    let fichaId = fichaIdIn;
    let version = 1;
    if (esReemplazo) {
      const { data: actual, error: getErr } = await admin.from('fichas_tecnicas').select('version').eq('id', fichaIdIn).single();
      if (getErr || !actual) return json({ error: 'No se encontró la ficha a reemplazar.' }, 400);
      version = (actual.version as number) + 1;
    } else {
      fichaId = crypto.randomUUID();
    }
    // Ruta con sufijo único (no "v<version>.pdf"): si una subida se cae a mitad de camino, el próximo
    // intento nunca choca con un objeto que ya existe en Storage (antes, un reintento tras una falla
    // podía dejar la ficha imposible de reemplazar — "resource already exists" para siempre).
    const storagePath = `${fichaId}/${crypto.randomUUID()}.pdf`;

    const { error: upErr } = await admin.storage.from('fichas-tecnicas').upload(storagePath, pdfBytes, { contentType: 'application/pdf' });
    if (upErr) { console.error('fichas-ingesta storage.upload', upErr); return json({ error: 'No se pudo guardar el PDF.' }, 500); }

    const borrarPdfSubido = () => admin.storage.from('fichas-tecnicas').remove([storagePath]).catch(() => {});

    if (!esReemplazo) {
      // Ficha nueva: fichas_fragmentos.ficha_id tiene FK a fichas_tecnicas, así que la fila de la ficha
      // tiene que existir antes de poder insertar sus fragmentos — no hay forma de invertir este orden.
      // Si la inserción de fragmentos falla después, se borra esta fila (Review Focus: nunca dejar una
      // ficha "activa" con cero fragmentos sin que nadie se entere).
      const { error: insErr } = await admin.from('fichas_tecnicas').insert({ id: fichaId, nombre, categoria, storage_path: storagePath, version });
      if (insErr) { console.error('fichas-ingesta insert ficha', insErr); await borrarPdfSubido(); return json({ error: 'No se pudo crear la ficha.' }, 500); }

      const nuevasFilas = fragmentosTexto.map((contenido, indice) => ({ ficha_id: fichaId, indice, contenido, embedding: vectores[indice] }));
      const { error: fragErr } = await admin.from('fichas_fragmentos').insert(nuevasFilas);
      if (fragErr) {
        console.error('fichas-ingesta insert fragmentos', fragErr);
        await admin.from('fichas_tecnicas').delete().eq('id', fichaId); // cascada borra fragmentos si algo sí entró
        await borrarPdfSubido();
        return json({ error: 'No se pudieron guardar los fragmentos de la ficha.' }, 500);
      }
      return json({ ok: true, ficha_id: fichaId, fragmentos: nuevasFilas.length });
    }

    // Reemplazo: la ficha ya existe, así que SÍ se puede (y se debe) insertar los fragmentos nuevos
    // antes de tocar la fila de la ficha — si esto falla, la ficha queda intacta apuntando a la versión
    // vieja, sin ningún momento en que apunte a un PDF nuevo sin sus fragmentos.
    const nuevasFilas = fragmentosTexto.map((contenido, indice) => ({ ficha_id: fichaId, indice, contenido, embedding: vectores[indice] }));
    const { data: insertados, error: fragErr } = await admin.from('fichas_fragmentos').insert(nuevasFilas).select('id');
    if (fragErr) { console.error('fichas-ingesta insert fragmentos', fragErr); await borrarPdfSubido(); return json({ error: 'No se pudieron guardar los fragmentos de la ficha.' }, 500); }
    const idsNuevos = (insertados ?? []).map((f: { id: string }) => f.id);

    const { error: updErr } = await admin.from('fichas_tecnicas').update({ nombre, categoria, storage_path: storagePath, version }).eq('id', fichaId);
    if (updErr) {
      console.error('fichas-ingesta update ficha', updErr);
      await admin.from('fichas_fragmentos').delete().in('id', idsNuevos); // la ficha sigue en la versión vieja: no dejar fragmentos nuevos sueltos
      await borrarPdfSubido();
      return json({ error: 'No se pudo actualizar la ficha.' }, 500);
    }

    // Los fragmentos de la versión anterior comparten el mismo ficha_id (la tabla no distingue
    // versión): se borran solo los que NO son los recién insertados, y solo después de que la ficha ya
    // quedó apuntando a la versión nueva. Si este borrado falla, NO se informa éxito: quedarían
    // fragmentos viejos (con datos desactualizados) mezclados en la búsqueda sin que nadie se entere.
    const { error: delErr } = await admin.from('fichas_fragmentos').delete().eq('ficha_id', fichaId).not('id', 'in', `(${idsNuevos.join(',')})`);
    if (delErr) {
      console.error('fichas-ingesta borrar fragmentos viejos', delErr);
      return json({ error: 'La ficha se actualizó pero quedaron fragmentos antiguos sin borrar. Avisa a soporte.' }, 500);
    }

    return json({ ok: true, ficha_id: fichaId, fragmentos: nuevasFilas.length });
  } catch (e) {
    console.error('fichas-ingesta', e);
    return json({ error: 'Error interno.' }, 500);
  }
});
