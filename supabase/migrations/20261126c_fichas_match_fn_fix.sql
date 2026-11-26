-- Corrige un hallazgo Crítico de la revisión final: match_fichas_fragmentos() quedó como
-- security definer otorgada a 'authenticated' SIN chequear crm_is_active() en el cuerpo, así que
-- cualquier usuario autenticado del proyecto compartido (incluye cuentas de otras apps y perfiles CRM
-- inactivos/desactivados, 31 de 60 según se confirmó en vivo) podía volcar el texto completo de todas
-- las fichas con un vector cualquiera y un umbral negativo. Se cambia a security invoker: así corre
-- con el rol real de quien llama y queda sujeta a la misma política de lectura (crm_is_active()) que
-- ya protege la tabla — defensa en profundidad real, no solo "la Edge Function ya lo chequea antes".
-- De paso se topa match_count para que nadie pueda pedir una cantidad arbitraria de filas.
create or replace function public.match_fichas_fragmentos(query_embedding vector(768), match_count int, match_threshold float)
returns table(id uuid, ficha_id uuid, contenido text, similarity float)
language sql stable security invoker set search_path to 'public'
as $$
  select f.id, f.ficha_id, f.contenido, 1 - (f.embedding <=> query_embedding) as similarity
  from fichas_fragmentos f
  where 1 - (f.embedding <=> query_embedding) > match_threshold
  order by f.embedding <=> query_embedding
  limit least(match_count, 20)
$$;
