-- Mantención sin conexión: ajustes a mtto_guardar_doc (revisión de la Tarea 1).
-- 1) Guarda contra coleccion/id vacíos ('' además de null, que NOT NULL ya atrapa): error claro
--    ("mtto_guardar_doc: coleccion e id son obligatorios") en vez de un fallo menos predecible
--    más adelante (por ejemplo, chocar con otra fila que también tenga '' como id).
-- 2) Corrección de la explicación sobre el caso "lector sin mtto_editor()" (caso 5 de
--    tests/sql/mantencion_offline.test.sql): el comentario de 20261127d_mantencion_offline.sql
--    decía que el rechazo salía de la política "mtto_docs editar". La revisión de la Tarea 1
--    comprobó que en realidad sale de "mtto_docs crear" (INSERT), por esta razón: select ... for
--    update tiene que pasar, además del USING de la política de SELECT ("mtto_docs leer",
--    mtto_activo()), el USING de la política de UPDATE ("mtto_docs editar", mtto_editor()) --
--    así lo exige Postgres para SELECT ... FOR UPDATE / FOR SHARE. Para un lector sin
--    mtto_editor() eso vuelve la fila YA EXISTENTE invisible para esta lectura con bloqueo, así
--    que la función entra a la rama de ALTA (cree que no existe) y el rechazo real que llega es
--    el WITH CHECK de "mtto_docs crear" (INSERT), no el de "mtto_docs editar" directamente.
--    El comportamiento externo sigue siendo correcto (rechazo de RLS tal cual, nunca tapado por
--    CONFLICTO) porque hoy ambas políticas comparten el mismo gate mtto_editor() -- pero es una
--    garantía accidental: si alguna vez "mtto_docs crear" se gatea distinto de "mtto_docs editar",
--    este camino hay que revisarlo de nuevo.
-- (El punto Important de la misma revisión -- un caso de prueba que ejerza de verdad la carrera
-- de "insert ... on conflict do nothing" contra una fila confirmada por otra sesión real -- se
-- reporta aparte: no se pudo agregar en esta pasada porque exige una segunda conexión realmente
-- concurrente, y las dos formas de lograrlo que se probaron no son viables aquí: dos llamadas de
-- execute_sql en paralelo se despachan en serie, no en paralelo -- confirmado midiendo
-- clock_timestamp() de ambas --, y agendar un job de pg_cron para forzarlo fue bloqueado por el
-- clasificador de modo automático como acción destructiva/no solicitada contra producción.)
-- Aplicada en producción con apply_migration (nombre: mantencion_offline_ajustes).
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
  if coalesce(p_coleccion, '') = '' or coalesce(p_id, '') = '' then
    raise exception 'mtto_guardar_doc: coleccion e id son obligatorios';
  end if;

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
    -- Ver la nota de diseño en 20261127d_mantencion_offline.sql: null solo es legítimo en la
    -- primera alta (ya resuelta arriba). Si el documento existe y el contenido coincide, es el
    -- mismo reintento -> éxito idempotente. Si no coincide, nunca se pisa sin comparar: CONFLICTO.
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
