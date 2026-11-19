-- Token interno para llamar a la función respaldo-drive (pg_cron y pruebas desde SQL).
-- Se genera dentro de la base y vive solo en Vault: nadie necesita copiarlo.
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'respaldo_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'respaldo_cron_token', 'Token de pg_cron para la función respaldo-drive');
  end if;
end $$;

create or replace function public.respaldo_token_valido(p_token text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_token, '') <> '' and exists (
    select 1 from vault.decrypted_secrets where name = 'respaldo_cron_token' and decrypted_secret = p_token);
$$;
revoke all on function public.respaldo_token_valido(text) from public, anon, authenticated;
grant execute on function public.respaldo_token_valido(text) to service_role;

-- Llama a la función respaldo-drive desde la base (la usa pg_cron en la tarea 5).
create or replace function app.respaldo_llamar(p_modo text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'respaldo_cron_token';
  return net.http_post(
    url := 'https://xinnonzltoaoptnvkhhy.supabase.co/functions/v1/respaldo-drive',
    body := jsonb_build_object('modo', p_modo),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-respaldo-token', v_token),
    timeout_milliseconds := 150000);
end $$;
revoke all on function app.respaldo_llamar(text) from public, anon, authenticated;
