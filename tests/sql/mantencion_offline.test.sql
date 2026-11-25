-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Mantención sin conexión (Tarea 1): versión del servidor (updated_at fijado por disparador)
-- y guardado idempotente de mtto_docs vía mtto_guardar_doc (una sola función para todas las
-- colecciones, porque mtto_docs ya es genérica). Usa usuarios reales solo como identidad.
--
-- Pendiente conocido (revisión de la Tarea 1, hallazgo Important): falta un caso que ejerza de
-- verdad la carrera de "insert ... on conflict (coleccion,id) do nothing" de mtto_guardar_doc --
-- es decir, que su propio select la vea "not found" y que su propio insert choque de verdad
-- contra una fila que OTRA SESIÓN confirmó mientras tanto (no simulada, no aislada fuera de la
-- función). Eso exige dos transacciones realmente superpuestas, y las dos formas de lograrlo
-- que se probaron no son viables con las herramientas de esta sesión:
--   1) Dos llamadas a execute_sql en el mismo turno: se confirmó, midiendo clock_timestamp() en
--      ambas, que el host las despacha EN SERIE (la segunda no arranca hasta que la primera
--      termina), no en paralelo -- no hay ventana de superposición real.
--   2) Agendar un job de pg_cron (ya instalado en este proyecto) para el próximo minuto exacto
--      (dispara una sola vez, sin riesgo de bucle) como "la otra sesión": el clasificador de modo
--      automático bloqueó la llamada a cron.schedule contra producción como acción destructiva.
-- Queda para quien tenga permiso explícito para usar pg_cron/dblink contra este proyecto, o para
-- un entorno de CI con acceso psql real a dos conexiones (por ejemplo, correr este mismo patrón
-- con `psql` desde dos shells).
do $$
declare
  ed1 uuid; lec1 uuid;
  doc_id text := 'TEST-' || gen_random_uuid()::text;
  v_coleccion text := 'test_offline';
  u1 timestamptz; u2 timestamptz;
  v0 timestamptz;
  ok boolean; n int;
begin
  select u.id into ed1 from public.mtto_usuarios u join public.profiles p on p.id = u.id
    where u.activo and u.rol = 'editor' and p.activo order by u.id limit 1;
  select u.id into lec1 from public.mtto_usuarios u join public.profiles p on p.id = u.id
    where u.activo and u.rol = 'lector' and p.activo order by u.id limit 1;
  if ed1 is null or lec1 is null then
    raise exception 'faltan usuarios activos (1 editor y 1 lector) para la prueba';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', ed1, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ===== 1) alta con p_base null sobre un id nuevo: crea, devuelve updated_at =====
  u1 := public.mtto_guardar_doc(v_coleccion, doc_id, null, jsonb_build_object('estado', 'original'));
  if u1 is null then raise exception 'caso 1: no devolvió updated_at'; end if;
  select count(*) into n from public.mtto_docs where coleccion = v_coleccion and id = doc_id;
  if n <> 1 then raise exception 'caso 1: se esperaba 1 fila y hay %', n; end if;
  if (select data->>'estado' from public.mtto_docs where coleccion = v_coleccion and id = doc_id) <> 'original' then
    raise exception 'caso 1: los datos no quedaron guardados';
  end if;
  if (select updated_by from public.mtto_docs where coleccion = v_coleccion and id = doc_id) is distinct from ed1 then
    raise exception 'caso 1: updated_by no es auth.uid()';
  end if;
  raise notice 'caso 1 OK: alta con p_base null sobre id nuevo, updated_at = %', u1;

  -- ===== 2) mismo doc, mismo p_base (el que acaba de devolver): actualiza, updated_at sube =====
  v0 := u1;
  u2 := public.mtto_guardar_doc(v_coleccion, doc_id, v0, jsonb_build_object('estado', 'editado'));
  if u2 <= v0 then raise exception 'caso 2: updated_at no subió (% -> %)', v0, u2; end if;
  if (select data->>'estado' from public.mtto_docs where coleccion = v_coleccion and id = doc_id) <> 'editado' then
    raise exception 'caso 2: los cambios no quedaron guardados';
  end if;
  raise notice 'caso 2 OK: guardado con versión vigente, updated_at subió (% -> %)', v0, u2;

  -- ===== 3) con el p_base viejo: CONFLICTO, y el mensaje incluye el nombre de la colección =====
  ok := false;
  begin
    perform public.mtto_guardar_doc(v_coleccion, doc_id, v0, jsonb_build_object('estado', 'pisado'));
  exception when others then
    if sqlerrm not like 'CONFLICTO:%' or sqlerrm not like '%' || v_coleccion || '%' then
      raise exception 'caso 3: error inesperado: %', sqlerrm;
    end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 3: no hubo CONFLICTO con base vieja'; end if;
  if (select data->>'estado' from public.mtto_docs where coleccion = v_coleccion and id = doc_id) <> 'editado' then
    raise exception 'caso 3: el conflicto igual modificó la fila';
  end if;
  raise notice 'caso 3 OK: base vieja => CONFLICTO (con el nombre de la colección) sin tocar la fila';

  -- ===== 4) reenvío con el id ya existente y p_base null (reintento que perdió la respuesta):
  --         mismo contenido que el actual => éxito idempotente, sin pisar ni duplicar =====
  ok := false;
  u1 := public.mtto_guardar_doc(v_coleccion, doc_id, null, jsonb_build_object('estado', 'editado'));
  if u1 is distinct from u2 then
    raise exception 'caso 4a: el reenvío con mismo contenido no devolvió el updated_at vigente (% vs %)', u1, u2;
  end if;
  select count(*) into n from public.mtto_docs where coleccion = v_coleccion and id = doc_id;
  if n <> 1 then raise exception 'caso 4a: se duplicó la fila (%)', n; end if;
  raise notice 'caso 4a OK: reenvío con p_base null y mismo contenido => éxito idempotente, sin duplicar';

  -- 4b) reenvío con p_base null pero contenido DISTINTO del actual: nunca pisa sin comparar => CONFLICTO
  ok := false;
  begin
    perform public.mtto_guardar_doc(v_coleccion, doc_id, null, jsonb_build_object('estado', 'intento_pisado'));
  exception when others then
    if sqlerrm not like 'CONFLICTO:%' then raise exception 'caso 4b: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 4b: no hubo CONFLICTO con p_base null y contenido distinto'; end if;
  if (select data->>'estado' from public.mtto_docs where coleccion = v_coleccion and id = doc_id) <> 'editado' then
    raise exception 'caso 4b: el intento con p_base null igual modificó la fila';
  end if;
  raise notice 'caso 4b OK: p_base null con contenido distinto del actual => CONFLICTO, nunca pisado silencioso';

  -- ===== 5) mtto_guardar_doc como alguien sin app.mtto_editor(): el error de RLS llega tal cual =====
  perform set_config('request.jwt.claims', json_build_object('sub', lec1, 'role', 'authenticated')::text, true);
  ok := false;
  begin
    perform public.mtto_guardar_doc(v_coleccion, doc_id, u2, jsonb_build_object('estado', 'desde_lector'));
  exception when others then
    if sqlerrm like 'CONFLICTO:%' then raise exception 'caso 5: se tapó el error de permiso con CONFLICTO'; end if;
    -- Debe ser el rechazo de RLS, no nuestro raise. En este punto la fila ya existe, pero
    -- select...for update exige también el USING de "mtto_docs editar" (mtto_editor()): para un
    -- lector sin ese permiso la fila queda invisible para esta lectura con bloqueo, la función
    -- cae a la rama de ALTA, y el rechazo real sale del WITH CHECK de "mtto_docs crear" (INSERT) --
    -- no de "mtto_docs editar" directamente. Mismo gate (mtto_editor()) en ambas, por eso el
    -- comportamiento externo es el mismo; ver nota en 20261127e_mantencion_offline_ajustes.sql.
    ok := true;
  end;
  if not ok then raise exception 'caso 5: un lector sin mtto_editor() pudo guardar'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', ed1, 'role', 'authenticated')::text, true);
  if (select data->>'estado' from public.mtto_docs where coleccion = v_coleccion and id = doc_id) <> 'editado' then
    raise exception 'caso 5: la fila fue modificada a pesar del error de permiso';
  end if;
  raise notice 'caso 5 OK: sin mtto_editor() => rechazo de RLS tal cual, fila intacta';

  -- ===== 6) coleccion/id vacíos ('', ajuste Minor de la revisión): error claro, no un fallo
  --         menos predecible más adelante =====
  ok := false;
  begin
    perform public.mtto_guardar_doc('', doc_id, null, '{}'::jsonb);
  exception when others then
    if sqlerrm <> 'mtto_guardar_doc: coleccion e id son obligatorios' then
      raise exception 'caso 6: error inesperado: %', sqlerrm;
    end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 6: coleccion vacía no fue rechazada'; end if;
  raise notice 'caso 6 OK: coleccion vacía rechazada con mensaje claro';

  reset role;
  raise exception 'OK_ROLLBACK';
exception when others then
  reset role;
  raise;
end $$;
