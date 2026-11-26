-- 2FA (mejora 8/8): una Edge Function necesita verificar, con el JWT de quien llama, que es admin
-- central antes de resetear el 2FA de otra persona. app.tiene_rol vive en el esquema app (no expuesto
-- por PostgREST ni por rpc() directo); esta envoltura en public solo expone el resultado booleano.
create or replace function public.soy_admin()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$ select app.tiene_rol(variadic array['admin']) $$;

revoke all on function public.soy_admin() from public, anon;
grant execute on function public.soy_admin() to authenticated;
