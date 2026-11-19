-- Modo noche: volcado completo para la copia diaria y lista de archivos para la retención de 60 días. Solo service_role.

-- Todas las tablas de public (menos respaldo_*) + auth_users con 5 columnas (sin hashes de contraseña).
create or replace function public.respaldo_volcado()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t text; v jsonb; r jsonb := '{}'::jsonb;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename not like 'respaldo\_%' order by 1 loop
    execute format('select coalesce(jsonb_agg(x), ''[]''::jsonb) from public.%I x', t) into v;
    r := r || jsonb_build_object(t, v);
  end loop;
  select coalesce(jsonb_agg(u), '[]'::jsonb) into v from (
    select id, email, raw_user_meta_data, created_at, last_sign_in_at from auth.users order by created_at) u;
  return r || jsonb_build_object('auth_users', v, '_generado', now());
end $$;
revoke all on function public.respaldo_volcado() from public, anon, authenticated;
grant execute on function public.respaldo_volcado() to service_role;

-- Archivos respaldados aún presentes en Supabase, con su fecha de subida al storage.
create or replace function public.respaldo_archivos_retencion()
returns table (id bigint, bucket text, ruta text, drive_file_id text, creado_storage timestamptz, borrado_supabase_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, a.bucket, a.ruta, a.drive_file_id, o.created_at, a.borrado_supabase_at
  from public.respaldo_archivos a
  left join storage.objects o on o.bucket_id = a.bucket and o.name = a.ruta
  where a.borrado_supabase_at is null;
$$;
revoke all on function public.respaldo_archivos_retencion() from public, anon, authenticated;
grant execute on function public.respaldo_archivos_retencion() to service_role;
