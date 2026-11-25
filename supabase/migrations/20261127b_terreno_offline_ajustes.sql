-- Registro de Terreno sin conexión: ajustes a rt_crear_registro (revisión de la tarea 1).
-- - Si el id ya existe y es de otra persona, el alta ya no "tiene éxito" en silencio: lanza
--   AJENO (rechazo de regla; el teléfono marca el registro con problema y el PM ve el motivo). El prefijo
--   AJENO: no se confunde con el NO_EXISTE: de rt_guardar_registro (registro borrado).
-- Reenviar el propio id sigue devolviendo el mismo updated_at sin error.
-- Aplicada en producción con apply_migration (nombre: terreno_offline_ajustes).
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
  v_autor uuid;
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

  select r.updated_at, r.autor into v_ts, v_autor from public.registros r where r.id = v_id;
  if not found then
    -- El id existe pero la política de lectura no deja verlo: tampoco es de esta persona.
    raise exception 'AJENO: ese id ya es de un registro de otra persona';
  end if;
  if v_autor is distinct from auth.uid() then
    raise exception 'AJENO: ese id ya es de un registro de otra persona';
  end if;
  return v_ts;
end $$;
revoke all on function public.rt_crear_registro(jsonb) from public, anon;
grant execute on function public.rt_crear_registro(jsonb) to authenticated;
