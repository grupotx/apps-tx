-- CRM offline (fase 2, Task 6 revisión) — tope de reservas con vencimiento y entrega de PDF sin versión.
-- PENDIENTE: aplicar con apply_migration (nombre: crm_offline_entrega) antes de publicar (crm.html llama crm_registrar_entrega).

-- 1) Reservar números: el tope de 40 sin usar cuenta solo reservas de los últimos 7 días.
--    Las reservas viejas sin usar (sesión cerrada: la reserva local se borra; cotización descartada;
--    otro equipo) quedan como saltos y ya no bloquean nuevas reservas.
create or replace function public.crm_reservar_numeros(p_n int)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out text[] := '{}';
  v_seq bigint;
  i int;
begin
  if auth.uid() is null or not public.crm_has_perm('cotizar') then
    raise exception 'Sin permiso para cotizar';
  end if;
  if p_n is null or p_n < 1 or p_n > 20 then
    raise exception 'Cantidad de números inválida (1 a 20)';
  end if;
  if (select count(*) from public.crm_quote_reservas r
       where r.user_id = auth.uid() and r.quote_id is null
         and r.reservado_at > now() - interval '7 days') >= 40 then
    raise exception 'Demasiados números reservados sin usar';
  end if;
  for i in 1..p_n loop
    v_seq := nextval('public.crm_quote_seq');
    v_out := v_out || ('COT-' || to_char(public.crm_now_cl(),'YYYY') || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0'));
    insert into public.crm_quote_reservas (num, user_id) values (v_out[i], auth.uid());
  end loop;
  return v_out;
end $$;
revoke all on function public.crm_reservar_numeros(int) from public, anon;
grant execute on function public.crm_reservar_numeros(int) to authenticated;

-- 2) updated_at (versión de la cotización): se conserva cuando la transacción marcó
--    crm.sin_version = '1' (registro de entrega del PDF, que no es una edición del contenido).
create or replace function public.crm_quotes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('crm.sin_version', true), '') = '1' then
    new.updated_at := old.updated_at;
  else
    new.updated_at := (now() at time zone 'America/Santiago');
  end if;
  return new;
end $$;
revoke all on function public.crm_quotes_touch() from public, anon;

-- 3) Entrega del PDF (descargado, compartido o enviado por correo) de una cotización propia:
--    agrega la línea de historia de forma atómica y sin duplicarla, fija sent_at si viene,
--    pasa borrador → enviada si se pide, y NO cambia updated_at (no provoca CONFLICTO en
--    ediciones sin conexión hechas sobre la versión anterior).
create or replace function public.crm_registrar_entrega(
  p_id uuid, p_linea jsonb, p_sent_at date, p_a_enviada boolean)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform set_config('crm.sin_version', '1', true);
  update public.crm_quotes q set
    history = case
      when p_linea is null or jsonb_typeof(p_linea) <> 'object' then q.history
      when coalesce(q.history, '[]'::jsonb) @> jsonb_build_array(p_linea) then q.history
      else coalesce(q.history, '[]'::jsonb) || jsonb_build_array(p_linea) end,
    sent_at = coalesce(p_sent_at, q.sent_at),
    status  = case when coalesce(p_a_enviada, false) and q.status = 'borrador' then 'enviada' else q.status end
  where q.id = p_id and q.user_id = auth.uid();
  if not found then
    raise exception 'Cotización no encontrada o no es tuya';
  end if;
  perform set_config('crm.sin_version', '', true);
end $$;
revoke all on function public.crm_registrar_entrega(uuid, jsonb, date, boolean) from public, anon;
grant execute on function public.crm_registrar_entrega(uuid, jsonb, date, boolean) to authenticated;
