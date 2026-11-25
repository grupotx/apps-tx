-- Mantención sin conexión (Tarea 1): versión del servidor y guardado idempotente de mtto_docs.
-- 1) updated_at/updated_by de mtto_docs los fija el servidor (el teléfono ya no decide la versión).
-- 2) mtto_guardar_doc: una sola función para TODAS las colecciones (mtto_docs ya es genérica:
--    coleccion,id,data con PK compuesta (coleccion,id) — no hace falta una función por colección,
--    a diferencia de Terreno que sí tiene una tabla por tipo).
-- SECURITY INVOKER: siguen mandando las políticas RLS de mtto_docs (mtto_editor() para
-- insert/update/delete, mtto_activo() para select) sin duplicar el chequeo de rol aquí.
--
-- Decisión del Step 1.4 (el punto delicado de esta tarea):
--   p_base = null solo es un "no comparar" legítimo la PRIMERA vez que el documento se crea
--   (no existe fila todavía: no hay nada contra qué comparar). Si la fila YA existe y el
--   cliente manda p_base null, NO se trata como "pisar incondicional": eso sería un bug de
--   pisado silencioso (ej.: el teléfono guardó con éxito, la respuesta se perdió en el camino,
--   reintenta con p_base null porque nunca llegó a conocer el updated_at real; mientras tanto
--   otra persona pudo haber cambiado el documento de verdad). En ese caso se compara el
--   CONTENIDO (p_data) contra el de la fila actual:
--     - si es igual, es el mismo reintento -> éxito idempotente, devuelve el updated_at vigente
--       sin volver a escribir.
--     - si es distinto, no hay forma de saber si es un cambio ajeno real o un reintento con
--       datos corregidos localmente -> nunca se pisa sin comparar: CONFLICTO.
--   A diferencia de Terreno (que resuelve el reintento del lado del cliente comparando contenido
--   antes de reintentar, porque allí "crear" y "guardar" son dos funciones separadas), aquí el
--   cliente SIEMPRE debe mandar el p_base que tenía en memoria salvo la primera vez que crea el
--   documento; esta función hace cumplir esa regla también del lado del servidor porque una sola
--   función cubre alta y edición: sin este chequeo, un reintento con base null después de la
--   primera alta exitosa sería indistinguible de "no me importa lo que haya, pisa" y pisaría
--   cualquier cambio ajeno que haya llegado justo después.
-- Aplicada en producción con apply_migration (nombre: mantencion_offline).

-- 1) Versión: updated_at/updated_by los fija el servidor en cada INSERT/UPDATE -------------
-- clock_timestamp() y no now(): dos guardados dentro de una misma transacción deben distinguirse.
create or replace function app.mtto_docs_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;
revoke all on function app.mtto_docs_touch() from public, anon;

drop trigger if exists mtto_docs_touch_trg on public.mtto_docs;
create trigger mtto_docs_touch_trg
  before insert or update on public.mtto_docs
  for each row execute function app.mtto_docs_touch();

-- 2) Guardado idempotente, con versión base --------------------------------------------------
create or replace function public.mtto_guardar_doc(p_coleccion text, p_id text, p_base timestamptz, p_data jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actual timestamptz;
  v_data_actual jsonb;
  v_nuevo timestamptz;
begin
  select d.updated_at, d.data into v_actual, v_data_actual
    from public.mtto_docs d
    where d.coleccion = p_coleccion and d.id = p_id
    for update;

  if not found then
    -- Alta: no existía ninguna fila, así que no hay nada contra qué comparar p_base.
    insert into public.mtto_docs (coleccion, id, data)
    values (p_coleccion, p_id, p_data)
    on conflict (coleccion, id) do nothing
    returning updated_at into v_nuevo;

    if v_nuevo is not null then
      return v_nuevo;
    end if;

    -- Carrera: otra sesión creó el mismo (coleccion,id) entre el select y el insert.
    -- Se cae al mismo camino de "ya existe" de abajo, decidiendo por contenido/base.
    select d.updated_at, d.data into v_actual, v_data_actual
      from public.mtto_docs d
      where d.coleccion = p_coleccion and d.id = p_id;
  end if;

  -- Ya existe (o acaba de crearla una sesión concurrente).
  if p_base is null then
    -- Ver la nota de diseño arriba: null solo es legítimo en la primera alta (ya resuelta).
    -- Si el documento existe y el contenido coincide, es el mismo reintento -> éxito idempotente.
    -- Si no coincide, nunca se pisa sin comparar -> CONFLICTO.
    if v_data_actual is distinct from p_data then
      raise exception 'CONFLICTO: % cambió en el servidor', p_coleccion;
    end if;
    return v_actual;
  end if;

  if p_base is distinct from v_actual then
    raise exception 'CONFLICTO: % cambió en el servidor', p_coleccion;
  end if;

  update public.mtto_docs d set data = p_data
    where d.coleccion = p_coleccion and d.id = p_id
    returning d.updated_at into v_nuevo;

  return v_nuevo;
end $$;
revoke all on function public.mtto_guardar_doc(text, text, timestamptz, jsonb) from public, anon;
grant execute on function public.mtto_guardar_doc(text, text, timestamptz, jsonb) to authenticated;
