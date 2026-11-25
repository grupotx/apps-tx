-- Silos sin conexión (fase 4): versión del servidor, altas idempotentes y reserva de códigos.
-- 1) updated_at de silos/solicitudes/eventos lo fija el servidor (el teléfono ya no decide la versión).
-- 2) sil_crear_solicitud / sil_crear_evento: alta con el id generado en el teléfono; reenviar el mismo
--    registro no duplica. Si el id ya es de OTRO autor, AJENO (no "éxito" en silencio).
-- 3) sil_guardar_solicitud: edición con versión base (p_base); si el servidor cambió, CONFLICTO; si la
--    fila ya no existe, NO_EXISTE. Todas SECURITY INVOKER: siguen mandando las políticas RLS existentes
--    de silos/solicitudes/eventos (quién puede insertar/editar qué).
-- 4) cli_registrar pasa de "returns void" a "returns uuid" (devuelve el id del cliente, existente o
--    recién creado): hoy el único llamador (silos-tx/index.html, alta de solicitud con cliente nuevo)
--    descarta el valor de retorno (.then(() => loadMasters())), así que el cambio de firma no le rompe
--    nada; se confirmó con grep que ningún otro módulo (CRM incluido) llama a cli_registrar. El cambio
--    de tipo de retorno obliga a DROP + CREATE (CREATE OR REPLACE no permite cambiar el tipo).
-- 5) sil_reservar_codigos: reserva hasta 20 códigos SOL-NNNN (secuencia nueva, sin año, padding de 4
--    dígitos, igual al patrón que ya arma el teléfono) antes de crear la solicitud, para que dos
--    teléfonos sin señal no generen el mismo código. Mismo patrón que crm_quote_reservas /
--    crm_reservar_numeros (tabla de reservas sin políticas, solo accesible vía función SECURITY
--    DEFINER) y que el trigger de número de crm_set_quote_num (si data->>'codigo' viene, debe estar
--    reservado por auth.uid(); si no viene, se comporta como hoy).
-- Aplicada en producción con apply_migration (nombre: silos_offline).

-- 1) Versión: updated_at lo fija el servidor en cada INSERT/UPDATE -------------------------
-- clock_timestamp() y no now(): dos guardados dentro de una misma transacción deben distinguirse.
alter table public.silos       add column if not exists updated_at timestamptz not null default now();
alter table public.solicitudes add column if not exists updated_at timestamptz not null default now();
alter table public.eventos     add column if not exists updated_at timestamptz not null default now();

create or replace function app.sil_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke all on function app.sil_touch() from public, anon;

drop trigger if exists sil_silos_touch_trg on public.silos;
create trigger sil_silos_touch_trg
  before insert or update on public.silos
  for each row execute function app.sil_touch();

drop trigger if exists sil_solicitudes_touch_trg on public.solicitudes;
create trigger sil_solicitudes_touch_trg
  before insert or update on public.solicitudes
  for each row execute function app.sil_touch();

drop trigger if exists sil_eventos_touch_trg on public.eventos;
create trigger sil_eventos_touch_trg
  before insert or update on public.eventos
  for each row execute function app.sil_touch();

-- 2) Alta idempotente de solicitudes ---------------------------------------------------------
create or replace function public.sil_crear_solicitud(p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id    uuid := (p->>'id')::uuid;
  v_ts    timestamptz;
  v_autor uuid;
begin
  if v_id is null then
    raise exception 'Solicitud sin id';
  end if;

  insert into public.solicitudes (id, estado, silo_id, data, created_by)
  values (
    v_id,
    coalesce(p->>'estado', 'Solicitada'),
    nullif(p->>'silo_id', '')::uuid,
    coalesce(nullif(p->'data', 'null'::jsonb), '{}'::jsonb),
    auth.uid()
  )
  on conflict (id) do nothing;

  select s.updated_at, s.created_by into v_ts, v_autor from public.solicitudes s where s.id = v_id;
  if not found then
    -- El id existe pero la política de lectura no deja verlo: tampoco es de esta persona.
    raise exception 'AJENO: ese id ya es de una solicitud de otra persona';
  end if;
  if v_autor is distinct from auth.uid() then
    raise exception 'AJENO: ese id ya es de una solicitud de otra persona';
  end if;
  return v_ts;
end $$;
revoke all on function public.sil_crear_solicitud(jsonb) from public, anon;
grant execute on function public.sil_crear_solicitud(jsonb) to authenticated;

-- Alta idempotente de eventos (mismo patrón) -------------------------------------------------
create or replace function public.sil_crear_evento(p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id    uuid := (p->>'id')::uuid;
  v_ts    timestamptz;
  v_autor uuid;
begin
  if v_id is null then
    raise exception 'Evento sin id';
  end if;

  insert into public.eventos (id, tipo, fecha, silo_id, solicitud_id, data, created_by)
  values (
    v_id,
    p->>'tipo',
    coalesce((p->>'fecha')::date, current_date),
    (p->>'silo_id')::uuid,
    nullif(p->>'solicitud_id', '')::uuid,
    coalesce(nullif(p->'data', 'null'::jsonb), '{}'::jsonb),
    auth.uid()
  )
  on conflict (id) do nothing;

  select e.updated_at, e.created_by into v_ts, v_autor from public.eventos e where e.id = v_id;
  if not found then
    raise exception 'AJENO: ese id ya es de un evento de otra persona';
  end if;
  if v_autor is distinct from auth.uid() then
    raise exception 'AJENO: ese id ya es de un evento de otra persona';
  end if;
  return v_ts;
end $$;
revoke all on function public.sil_crear_evento(jsonb) from public, anon;
grant execute on function public.sil_crear_evento(jsonb) to authenticated;

-- 3) Guardado con versión -------------------------------------------------------------------
create or replace function public.sil_guardar_solicitud(p_id uuid, p_base timestamptz, p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actual timestamptz;
  v_nuevo  timestamptz;
begin
  select s.updated_at into v_actual from public.solicitudes s where s.id = p_id for update;
  if not found then
    raise exception 'NO_EXISTE: la solicitud ya no está';
  end if;
  if p_base is distinct from v_actual then
    raise exception 'CONFLICTO: la solicitud cambió en el servidor';
  end if;

  update public.solicitudes s set
    estado  = coalesce(p->>'estado', s.estado),
    silo_id = case when p ? 'silo_id' then nullif(p->>'silo_id', '')::uuid else s.silo_id end,
    data    = coalesce(nullif(p->'data', 'null'::jsonb), s.data)
  where s.id = p_id
  returning s.updated_at into v_nuevo;
  return v_nuevo;
end $$;
revoke all on function public.sil_guardar_solicitud(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.sil_guardar_solicitud(uuid, timestamptz, jsonb) to authenticated;

-- 4) cli_registrar devuelve el id del cliente (existente o recién creado) -------------------
-- Cambia el tipo de retorno (void -> uuid): DROP + CREATE porque CREATE OR REPLACE no lo permite.
drop function if exists public.cli_registrar(text, text, text, text, text);

create function public.cli_registrar(p_rut text, p_razon text, p_comuna text, p_direccion text, p_vendedor text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not app.tiene_rol(variadic array['vendedor', 'supervisor', 'admin']) then raise exception 'sin permiso'; end if;
  if coalesce(trim(p_rut), '') = '' or coalesce(trim(p_razon), '') = '' then return null; end if;

  insert into public.crm_clients (name, razon, rut, comuna, address, vendedor, origen, segment, type, region, contacts, sellers)
  values (p_razon, p_razon, p_rut, p_comuna, p_direccion, p_vendedor, 'Silos', 'C', 'Constructora', 'RM', '[]'::jsonb, '{}')
  on conflict (rut_key) where rut_key <> '' do nothing
  returning id into v_id;

  if v_id is null then
    select c.id into v_id from public.crm_clients c
     where c.rut_key = upper(regexp_replace(coalesce(p_rut, ''), '[^0-9kK]', '', 'g'))
     order by c.created_at limit 1;
  end if;
  return v_id;
end $$;
revoke all on function public.cli_registrar(text, text, text, text, text) from public, anon;
grant execute on function public.cli_registrar(text, text, text, text, text) to authenticated;

-- 5) Reserva de códigos SOL-NNNN -------------------------------------------------------------
create table if not exists public.sil_solicitud_reservas (
  num          text primary key,
  user_id      uuid not null,
  reservado_at timestamptz not null default now(),
  solicitud_id uuid null
);
create index if not exists sil_solicitud_reservas_user_idx on public.sil_solicitud_reservas (user_id);
alter table public.sil_solicitud_reservas enable row level security;
-- Sin políticas: solo se accede vía funciones SECURITY DEFINER.
revoke all on table public.sil_solicitud_reservas from anon, authenticated;

create sequence if not exists public.sil_solicitud_seq;

create or replace function public.sil_reservar_codigos(p_n int)
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
  if auth.uid() is null or not app.tiene_rol(variadic array['vendedor', 'supervisor', 'admin']) then
    raise exception 'Sin permiso para crear solicitudes';
  end if;
  if p_n is null or p_n < 1 or p_n > 20 then
    raise exception 'Cantidad de códigos inválida (1 a 20)';
  end if;
  for i in 1..p_n loop
    v_num := 'SOL-' || lpad(nextval('public.sil_solicitud_seq')::text, 4, '0');
    insert into public.sil_solicitud_reservas (num, user_id) values (v_num, auth.uid());
    v_out := v_out || v_num;
  end loop;
  return v_out;
end $$;
revoke all on function public.sil_reservar_codigos(int) from public, anon;
grant execute on function public.sil_reservar_codigos(int) to authenticated;

-- Trigger de código: null -> como hoy; con código -> debe estar reservado por el usuario.
-- SECURITY DEFINER para leer/marcar sil_solicitud_reservas (RLS sin políticas). Convive con el
-- disparador BEFORE de updated_at (sil_solicitudes_touch_trg) y con el AFTER de respaldo (respaldo_trg).
create or replace function public.sil_check_codigo_reserva()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := new.data->>'codigo';
begin
  if v_codigo is not null then
    update public.sil_solicitud_reservas r
       set solicitud_id = new.id
     where r.num = v_codigo
       and r.user_id = auth.uid()
       and (r.solicitud_id is null or r.solicitud_id = new.id);
    if not found then
      raise exception 'Código de solicitud no reservado';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.sil_check_codigo_reserva() from public, anon;

drop trigger if exists sil_solicitudes_codigo_trg on public.solicitudes;
create trigger sil_solicitudes_codigo_trg
  before insert on public.solicitudes
  for each row execute function public.sil_check_codigo_reserva();
