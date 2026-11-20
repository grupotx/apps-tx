-- CRM offline (fase 2): reserva de números de cotización, resolver cliente/prospecto
-- y edición de cotizaciones con versión (updated_at fijado por el servidor).
-- Aplicada en producción con apply_migration (nombre: crm_offline).

-- 1) Reservas de números ------------------------------------------------------
create table if not exists public.crm_quote_reservas (
  num          text primary key,
  user_id      uuid not null,
  reservado_at timestamptz not null default now(),
  quote_id     uuid null,
  usado_at     timestamptz null
);
create index if not exists crm_quote_reservas_user_idx on public.crm_quote_reservas (user_id);
alter table public.crm_quote_reservas enable row level security;
-- Sin políticas: solo se accede vía funciones SECURITY DEFINER.
revoke all on table public.crm_quote_reservas from anon, authenticated;

create or replace function public.crm_reservar_numeros(p_n int)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out text[] := '{}';
  v_num text;
  i int;
begin
  if auth.uid() is null or not public.crm_has_perm('cotizar') then
    raise exception 'Sin permiso para cotizar';
  end if;
  if p_n is null or p_n < 1 or p_n > 20 then
    raise exception 'Cantidad de números inválida (1 a 20)';
  end if;
  for i in 1..p_n loop
    v_num := 'COT-' || to_char(public.crm_now_cl(),'YYYY') || '-' || lpad(nextval('public.crm_quote_seq')::text, 4, '0');
    insert into public.crm_quote_reservas (num, user_id) values (v_num, auth.uid());
    v_out := v_out || v_num;
  end loop;
  return v_out;
end $$;
revoke all on function public.crm_reservar_numeros(int) from public, anon;
grant execute on function public.crm_reservar_numeros(int) to authenticated;

-- 2) Trigger de número: null -> como hoy; con número -> debe estar reservado por el usuario.
-- Pasa a SECURITY DEFINER para leer/marcar crm_quote_reservas (RLS sin políticas).
-- CREATE OR REPLACE conserva el ACL existente.
create or replace function public.crm_set_quote_num()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.num is null then
    new.num := 'COT-' || to_char(public.crm_now_cl(),'YYYY') || '-' || lpad(nextval('public.crm_quote_seq')::text, 4, '0');
  else
    update public.crm_quote_reservas r
       set quote_id = new.id, usado_at = coalesce(r.usado_at, now())
     where r.num = new.num
       and r.user_id = auth.uid()
       and (r.quote_id is null or r.quote_id = new.id);
    if not found then
      raise exception 'Número de cotización no reservado';
    end if;
  end if;
  return new;
end $$;

-- 3) Resolver cliente (prospectos creados sin conexión) --------------------------
-- SECURITY INVOKER: solo busca entre los clientes visibles (RLS de crm_clients).
create or replace function public.crm_resolver_cliente(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rut  text := upper(regexp_replace(coalesce(p->>'rut', ''), '[-.[:space:]]', '', 'g'));
  v_name text := regexp_replace(btrim(translate(lower(coalesce(p->>'name', '')),
                   'áéíóúàèìòùäëïöüâêîôû', 'aeiouaeiouaeiouaeiou')), '[[:space:]]+', ' ', 'g');
  v_id   uuid;
  v_cols text;
begin
  if v_rut <> '' then
    select c.id into v_id from public.crm_clients c
     where upper(regexp_replace(c.rut, '[-.[:space:]]', '', 'g')) = v_rut
     order by c.created_at limit 1;
  elsif v_name <> '' then
    select c.id into v_id from public.crm_clients c
     where regexp_replace(btrim(translate(lower(c.name), 'áéíóúàèìòùäëïöüâêîôû', 'aeiouaeiouaeiouaeiou')), '[[:space:]]+', ' ', 'g') = v_name
     order by c.created_at limit 1;
  else
    raise exception 'Cliente sin RUT ni nombre';
  end if;
  if v_id is not null then
    return v_id;
  end if;

  v_id := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
  if exists (select 1 from public.crm_clients c where c.id = v_id) then
    return v_id;
  end if;
  p := p || jsonb_build_object('id', v_id);

  -- Solo las columnas de crm_clients presentes en p (el resto toma su default).
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = 'public.crm_clients'::regclass
     and a.attnum > 0 and not a.attisdropped
     and p ? a.attname::text;
  execute format(
    'insert into public.crm_clients (%1$s) select %1$s from jsonb_populate_record(null::public.crm_clients, $1) on conflict (id) do nothing',
    v_cols) using p;
  return v_id;
end $$;
revoke all on function public.crm_resolver_cliente(jsonb) from public, anon;
grant execute on function public.crm_resolver_cliente(jsonb) to authenticated;

-- 4) Versión de cotización: updated_at lo fija el servidor en cada UPDATE ------
-- Columna es timestamp sin zona en hora de Chile (igual que crm_now_cl), con precisión completa.
create or replace function public.crm_quotes_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := (now() at time zone 'America/Santiago');
  return new;
end $$;
revoke all on function public.crm_quotes_touch() from public, anon;

drop trigger if exists crm_quotes_updated_at on public.crm_quotes;
create trigger crm_quotes_updated_at
  before update on public.crm_quotes
  for each row execute function public.crm_quotes_touch();

-- 5) Edición con versión ------------------------------------------------------
create or replace function public.crm_editar_cotizacion(
  p_id uuid, p_base timestamptz, p_cambios jsonb, p_requiere_aprobacion boolean, p_nota text)
returns public.crm_quotes
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v public.crm_quotes;
  c jsonb := coalesce(p_cambios, '{}'::jsonb);
begin
  select * into v from public.crm_quotes q
   where q.id = p_id and q.user_id = auth.uid()
   for update;
  if not found then
    raise exception 'Cotización no encontrada o no es tuya';
  end if;
  if p_base is null or v.updated_at is distinct from p_base::timestamp then
    raise exception 'CONFLICTO: la cotización cambió en el servidor';
  end if;
  if v.status in ('pendiente', 'rechazada', 'ganada', 'perdida') then
    raise exception 'CONFLICTO: la cotización cambió de estado';
  end if;

  update public.crm_quotes q set
    items       = case when c ? 'items'       then coalesce(nullif(c->'items', 'null'::jsonb), '[]'::jsonb) else q.items end,
    payment     = case when c ? 'payment'     then c->>'payment'     else q.payment end,
    conditions  = case when c ? 'conditions'  then c->>'conditions'  else q.conditions end,
    notes       = case when c ? 'notes'       then c->>'notes'       else q.notes end,
    contact     = case when c ? 'contact'     then c->>'contact'     else q.contact end,
    next_action = case when c ? 'next_action' then c->>'next_action' else q.next_action end,
    next_date   = case when c ? 'next_date'   then nullif(c->>'next_date', '')::date else q.next_date end,
    list_id     = case when c ? 'list_id'     then c->>'list_id'     else q.list_id end,
    entrega     = case when c ? 'entrega'     then coalesce(nullif(c->'entrega', 'null'::jsonb), '{}'::jsonb) else q.entrega end,
    valid_days  = case when c ? 'valid_days'  then coalesce(nullif(c->>'valid_days', '')::int, q.valid_days) else q.valid_days end,
    history     = q.history || jsonb_build_array(jsonb_build_object(
                    'ts', to_char(public.crm_now_cl(), 'YYYY-MM-DD"T"HH24:MI'),
                    'user', auth.uid(),
                    'text', coalesce(p_nota, 'Cotización editada'))),
    status      = case when p_requiere_aprobacion then 'pendiente' else q.status end
  where q.id = p_id
  returning q.* into v;
  return v;
end $$;
revoke all on function public.crm_editar_cotizacion(uuid, timestamptz, jsonb, boolean, text) from public, anon;
grant execute on function public.crm_editar_cotizacion(uuid, timestamptz, jsonb, boolean, text) to authenticated;
