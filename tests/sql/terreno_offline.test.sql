-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Registro de Terreno sin conexión: versión del servidor (updated_at fijado por disparador),
-- creación idempotente y guardado con versión base. Usa un usuario real solo como identidad.
do $$
declare
  pm1 uuid; adm uuid;
  reg uuid := gen_random_uuid();
  reg2 uuid := gen_random_uuid();
  reg3 uuid := gen_random_uuid();
  reg4 uuid := gen_random_uuid();
  u1 timestamptz; u1b timestamptz; v0 timestamptz; v1 timestamptz;
  n int; ok boolean; ca timestamptz; ua timestamptz; reg5 uuid := gen_random_uuid(); u5 timestamptz;
begin
  select u.id into pm1 from public.rt_usuarios u join public.profiles p on p.id = u.id
    where u.activo and p.activo and p.rol::text <> 'admin' order by u.id limit 1;
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  if pm1 is null or adm is null then raise exception 'faltan usuarios activos (1 PM no admin y 1 admin) para la prueba'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', pm1, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ===== 1) crear dos veces con el mismo id: una sola fila, mismo updated_at =====
  u1 := public.rt_crear_registro(jsonb_build_object('id', reg, 'kind', 'charla', 'fecha', current_date,
          'cliente', 'Cliente Test', 'obra', 'Obra Test', 'estado', 'Abierto',
          'datos', jsonb_build_object('tema', 'original'), 'fotos', jsonb_build_array('a.jpg'),
          'autor_nombre', 'PM Test'));
  u1b := public.rt_crear_registro(jsonb_build_object('id', reg, 'kind', 'charla', 'fecha', current_date,
          'cliente', 'Cliente Test', 'obra', 'Obra Test', 'datos', jsonb_build_object('tema', 'otro')));
  select count(*) into n from public.registros where id = reg;
  if n <> 1 then raise exception 'caso 1: se esperaba 1 fila y hay %', n; end if;
  if u1 is null or u1 is distinct from u1b then raise exception 'caso 1: updated_at distinto (% vs %)', u1, u1b; end if;
  if (select datos->>'tema' from public.registros where id = reg) <> 'original' then
    raise exception 'caso 1: el segundo envio pisó los datos';
  end if;
  if (select autor from public.registros where id = reg) is distinct from pm1 then
    raise exception 'caso 1: autor no es auth.uid()';
  end if;
  raise notice 'caso 1 OK: creación idempotente (una fila, mismo updated_at)';

  -- ===== 2) guardar con p_base vigente: actualiza y updated_at sube =====
  v0 := u1;
  v1 := public.rt_guardar_registro(reg, v0, jsonb_build_object('kind', 'charla', 'fecha', current_date,
          'cliente', 'Cliente Test', 'obra', 'Obra Test', 'estado', 'Cerrado',
          'datos', jsonb_build_object('tema', 'editado'), 'fotos', jsonb_build_array('a.jpg', 'b.jpg')));
  if v1 <= v0 then raise exception 'caso 2: updated_at no subió (% -> %)', v0, v1; end if;
  if (select datos->>'tema' from public.registros where id = reg) <> 'editado'
     or (select estado from public.registros where id = reg) <> 'Cerrado'
     or (select array_length(fotos, 1) from public.registros where id = reg) <> 2 then
    raise exception 'caso 2: los cambios no quedaron guardados';
  end if;
  raise notice 'caso 2 OK: guardado con versión vigente, updated_at subió';

  -- ===== 3) guardar con el p_base viejo: CONFLICTO =====
  ok := false;
  begin
    perform public.rt_guardar_registro(reg, v0, jsonb_build_object('kind', 'charla', 'fecha', current_date,
              'cliente', 'Cliente Test', 'obra', 'Obra Test', 'datos', '{}'::jsonb));
  exception when others then
    if sqlerrm not like 'CONFLICTO:%' then raise exception 'caso 3: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 3: no hubo CONFLICTO con base vieja'; end if;
  if (select datos->>'tema' from public.registros where id = reg) <> 'editado' then
    raise exception 'caso 3: el conflicto igual modificó la fila';
  end if;
  raise notice 'caso 3 OK: base vieja => CONFLICTO sin tocar la fila';

  -- ===== 4) guardar un id inexistente: NO_EXISTE =====
  ok := false;
  begin
    perform public.rt_guardar_registro(gen_random_uuid(), v1, jsonb_build_object('kind', 'charla', 'fecha', current_date,
              'cliente', 'X', 'obra', 'Y', 'datos', '{}'::jsonb));
  exception when others then
    if sqlerrm not like 'NO_EXISTE:%' then raise exception 'caso 4: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 4: no hubo NO_EXISTE'; end if;
  raise notice 'caso 4 OK: id inexistente => NO_EXISTE';

  -- ===== 5) update directo con updated_at del año 2000: el servidor lo ignora =====
  update public.registros set obra = 'Obra directa', updated_at = '2000-01-01 00:00:00+00' where id = reg;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'caso 5: el update directo no afectó la fila (% filas)', n; end if;
  select updated_at into ua from public.registros where id = reg;
  if ua < now() - interval '1 minute' or ua > clock_timestamp() + interval '1 minute' then
    raise exception 'caso 5: updated_at quedó en % (debía ser ahora)', ua;
  end if;
  if ua <= v1 then raise exception 'caso 5: updated_at no subió respecto de %', v1; end if;
  raise notice 'caso 5 OK: updated_at del cliente ignorado';

  -- ===== 6) hecho_en: dentro de la ventana se respeta; fuera, now() =====
  perform public.rt_crear_registro(jsonb_build_object('id', reg2, 'kind', 'charla', 'fecha', current_date,
            'cliente', 'C', 'obra', 'O', 'hecho_en', (now() - interval '2 hours')));
  perform public.rt_crear_registro(jsonb_build_object('id', reg3, 'kind', 'charla', 'fecha', current_date,
            'cliente', 'C', 'obra', 'O', 'hecho_en', '2000-01-01T00:00:00Z'));
  perform public.rt_crear_registro(jsonb_build_object('id', reg4, 'kind', 'charla', 'fecha', current_date,
            'cliente', 'C', 'obra', 'O', 'hecho_en', (now() + interval '1 day')));
  select created_at into ca from public.registros where id = reg2;
  if abs(extract(epoch from (ca - (now() - interval '2 hours')))) > 1 then
    raise exception 'caso 6: hecho_en de hace 2 h no se respetó (created_at = %)', ca;
  end if;
  select created_at into ca from public.registros where id = reg3;
  if abs(extract(epoch from (ca - now()))) > 60 then raise exception 'caso 6: hecho_en del 2000 no cayó a now() (%)', ca; end if;
  select created_at into ca from public.registros where id = reg4;
  if abs(extract(epoch from (ca - now()))) > 60 then raise exception 'caso 6: hecho_en de mañana no cayó a now() (%)', ca; end if;
  raise notice 'caso 6 OK: hecho_en dentro de ventana se respeta; fuera, now()';

  -- ===== 7) alta con el id de un registro de otra persona: AJENO, la fila ajena queda intacta =====
  reset role;
  insert into public.registros (id, kind, fecha, cliente, obra, autor, datos)
    values (reg5, 'charla', current_date, 'Cliente Ajeno', 'Obra Ajena', adm, '{"tema":"ajeno"}'::jsonb);
  select updated_at into u5 from public.registros where id = reg5;
  set local role authenticated;
  ok := false;
  begin
    perform public.rt_crear_registro(jsonb_build_object('id', reg5, 'kind', 'charla', 'fecha', current_date,
              'cliente', 'Intruso', 'obra', 'O', 'datos', jsonb_build_object('tema', 'intruso')));
  exception when others then
    if sqlerrm not like 'AJENO:%' then raise exception 'caso 7: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 7: el alta con id ajeno no lanzó AJENO'; end if;
  reset role;
  if (select datos->>'tema' from public.registros where id = reg5) <> 'ajeno'
     or (select autor from public.registros where id = reg5) <> adm
     or (select updated_at from public.registros where id = reg5) <> u5 then
    raise exception 'caso 7: la fila ajena fue modificada';
  end if;
  set local role authenticated;
  raise notice 'caso 7 OK: id ajeno => AJENO, fila ajena intacta';

  -- ===== 8) reenvío del propio id (tras guardar): mismo updated_at vigente, sin error =====
  u1b := public.rt_crear_registro(jsonb_build_object('id', reg, 'kind', 'charla', 'fecha', current_date,
           'cliente', 'Cliente Test', 'obra', 'Obra Test'));
  if u1b is distinct from (select updated_at from public.registros where id = reg) then
    raise exception 'caso 8: el reenvío del propio id no devolvió el updated_at vigente';
  end if;
  raise notice 'caso 8 OK: reenvío del propio id devuelve el updated_at vigente';

  reset role;
  raise exception 'OK_ROLLBACK';
exception when others then
  reset role;
  raise;
end $$;
