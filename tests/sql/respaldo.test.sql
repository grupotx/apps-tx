-- Prueba de la cola de respaldo. Se ejecuta con la herramienta execute_sql de Supabase.
-- Termina SIEMPRE con la excepción 'OK_ROLLBACK' si todo pasó: la transacción se deshace
-- y no queda ningún dato de prueba. Cualquier otro error = prueba fallida.
do $$
declare
  rid uuid;
  c record;
  n1 int; n2 int; n3 int;
  otra bigint;
begin
  -- 1) Un registro editado varias veces genera UNA sola entrada pendiente, con espera de 5 min
  insert into public.registros (kind, fecha, cliente) values ('visita', current_date, 'Prueba Respaldo') returning id into rid;
  update public.registros set obra = 'A' where id = rid;
  update public.registros set obra = 'B' where id = rid;
  update public.registros set obra = 'C' where id = rid;
  assert (select count(*) from public.respaldo_cola where tabla = 'registros' and registro_id = rid::text) = 1, 'debe haber 1 fila en cola';
  select * into c from public.respaldo_cola where tabla = 'registros' and registro_id = rid::text;
  assert c.estado = 'pendiente', 'estado debe ser pendiente';
  assert c.app = 'terreno', 'app debe ser terreno';
  assert c.listo_desde > now() + interval '4 minutes', 'listo_desde debe esperar 5 min';

  -- 2) Mantención: solo colecciones chk y ots generan envíos
  insert into public.mtto_docs (coleccion, id, data) values ('org', 'zz-prueba', '{}'::jsonb);
  assert (select count(*) from public.respaldo_cola where registro_id like '%zz-prueba') = 0, 'org no debe encolar';
  insert into public.mtto_docs (coleccion, id, data) values ('chk', 'zz-prueba', '{}'::jsonb);
  assert (select count(*) from public.respaldo_cola where tabla = 'mtto_docs' and registro_id = 'chk:zz-prueba' and app = 'mantencion') = 1, 'chk debe encolar como chk:<id>';

  -- 3) Número de envío: estable por fila, correlativo por app
  n1 := public.respaldo_asignar_numero(c.id);
  n2 := public.respaldo_asignar_numero(c.id);
  assert n1 = n2, 'el número no debe cambiar al pedirlo de nuevo';
  insert into public.registros (kind, fecha, cliente) values ('charla', current_date, 'Prueba Respaldo 2');
  select id into otra from public.respaldo_cola where app = 'terreno' and id <> c.id order by id desc limit 1;
  n3 := public.respaldo_asignar_numero(otra);
  assert n3 = n1 + 1, 'el siguiente envío de la app debe ser +1';

  -- 4) Borrar el registro deja la entrada como eliminado
  delete from public.registros where id = rid;
  assert (select estado from public.respaldo_cola where tabla = 'registros' and registro_id = rid::text) = 'eliminado', 'borrado debe marcar eliminado';

  -- 5) Las tablas no son legibles por usuarios de la app
  assert (select relrowsecurity from pg_class where oid = 'public.respaldo_cola'::regclass), 'RLS activo en respaldo_cola';
  assert not has_function_privilege('authenticated', 'public.respaldo_asignar_numero(bigint)', 'execute'), 'authenticated no debe ejecutar asignar_numero';

  raise exception 'OK_ROLLBACK';
end $$;
