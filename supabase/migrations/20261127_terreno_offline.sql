-- Registro de Terreno sin conexión (fase 3): versión del servidor y guardado idempotente.
-- 1) updated_at de registros lo fija el servidor (el teléfono ya no decide la versión).
-- 2) rt_crear_registro: alta con el id generado en el teléfono; reenviar el mismo registro no duplica.
-- 3) rt_guardar_registro: edición con versión base (p_base); si el servidor cambió, CONFLICTO.
-- Todas SECURITY INVOKER: siguen mandando las políticas RLS de registros y el disparador
-- rt_registros_edicion_trg (quién puede editar qué).
-- Aplicada en producción con apply_migration (nombre: terreno_offline).

-- 1) Versión: updated_at lo fija el servidor en cada INSERT/UPDATE -------------------------
-- clock_timestamp() y no now(): dos guardados dentro de una misma transacción deben distinguirse.
create or replace function app.rt_registros_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke all on function app.rt_registros_touch() from public, anon;

drop trigger if exists rt_registros_touch_trg on public.registros;
create trigger rt_registros_touch_trg
  before insert or update on public.registros
  for each row execute function app.rt_registros_touch();

-- 2) Alta idempotente -----------------------------------------------------------------------
-- created_at sale de p.hecho_en (hora real en el teléfono) solo si cae entre ahora-72 h y ahora+10 min;
-- fuera de ese rango (o inválida) se usa now(): un reloj desfasado no rechaza ni fecha el registro en otro año.
create or replace function public.rt_crear_registro(p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id    uuid := (p->>'id')::uuid;
  v_hecho timestamptz;
  v_ts    timestamptz;
begin
  if v_id is null then
    raise exception 'Registro sin id';
  end if;
  begin
    v_hecho := nullif(p->>'hecho_en', '')::timestamptz;
  exception when others then
    v_hecho := null;
  end;
  if v_hecho is null or v_hecho < now() - interval '72 hours' or v_hecho > now() + interval '10 minutes' then
    v_hecho := now();
  end if;

  insert into public.registros (id, kind, fecha, cliente, cliente_id, obra, estado, datos, fotos, autor, autor_nombre, created_at)
  values (
    v_id,
    p->>'kind',
    (p->>'fecha')::date,
    p->>'cliente',
    nullif(p->>'cliente_id', '')::uuid,
    coalesce(p->>'obra', ''),
    p->>'estado',
    coalesce(nullif(p->'datos', 'null'::jsonb), '{}'::jsonb),
    coalesce(array(select jsonb_array_elements_text(nullif(p->'fotos', 'null'::jsonb))), '{}'::text[]),
    auth.uid(),
    p->>'autor_nombre',
    v_hecho
  )
  on conflict (id) do nothing;

  select r.updated_at into v_ts from public.registros r where r.id = v_id;
  if v_ts is null then
    raise exception 'NO_EXISTE: el registro ya no está';
  end if;
  return v_ts;
end $$;
revoke all on function public.rt_crear_registro(jsonb) from public, anon;
grant execute on function public.rt_crear_registro(jsonb) to authenticated;

-- 3) Guardado con versión -----------------------------------------------------------------
create or replace function public.rt_guardar_registro(p_id uuid, p_base timestamptz, p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actual timestamptz;
  v_nuevo  timestamptz;
begin
  select r.updated_at into v_actual from public.registros r where r.id = p_id for update;
  if not found then
    raise exception 'NO_EXISTE: el registro ya no está';
  end if;
  if p_base is distinct from v_actual then
    raise exception 'CONFLICTO: el registro cambió en el servidor';
  end if;

  update public.registros r set
    kind       = p->>'kind',
    fecha      = (p->>'fecha')::date,
    cliente    = p->>'cliente',
    cliente_id = nullif(p->>'cliente_id', '')::uuid,
    obra       = coalesce(p->>'obra', ''),
    estado     = p->>'estado',
    datos      = coalesce(nullif(p->'datos', 'null'::jsonb), '{}'::jsonb),
    fotos      = coalesce(array(select jsonb_array_elements_text(nullif(p->'fotos', 'null'::jsonb))), '{}'::text[])
  where r.id = p_id
  returning r.updated_at into v_nuevo;
  return v_nuevo;
end $$;
revoke all on function public.rt_guardar_registro(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.rt_guardar_registro(uuid, timestamptz, jsonb) to authenticated;
