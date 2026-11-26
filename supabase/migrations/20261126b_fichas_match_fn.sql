-- Búsqueda semántica sobre fichas_fragmentos para el bot de consulta (fichas-preguntar). Security
-- definer porque corre la distancia vectorial directamente; igual exige que quien llama ya haya sido
-- autenticado (la Edge Function chequea crm_is_active() antes de llamar a esto).
-- search_path = 'public' (no vacío como en soy_admin/crm_has_perm) porque el operador <=> de pgvector
-- quedó instalado en el esquema public (create extension vector sin esquema explícito) y no se puede
-- calificar con esquema usando la sintaxis normal de operador.
create or replace function public.match_fichas_fragmentos(query_embedding vector(768), match_count int, match_threshold float)
returns table(id uuid, ficha_id uuid, contenido text, similarity float)
language sql stable security definer set search_path to 'public'
as $$
  select f.id, f.ficha_id, f.contenido, 1 - (f.embedding <=> query_embedding) as similarity
  from fichas_fragmentos f
  where 1 - (f.embedding <=> query_embedding) > match_threshold
  order by f.embedding <=> query_embedding
  limit match_count
$$;

revoke all on function public.match_fichas_fragmentos(vector, int, float) from public, anon;
grant execute on function public.match_fichas_fragmentos(vector, int, float) to authenticated;
