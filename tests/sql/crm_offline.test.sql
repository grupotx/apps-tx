-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- CRM offline: reserva de números, resolver cliente (prospectos) y edición con versión.
-- Nota: nextval no se revierte con el rollback; el bloque restaura crm_quote_seq al final.
do $$
declare
  ua uuid; ub uuid; cli uuid; cnew uuid := gen_random_uuid(); r uuid;
  qx uuid := gen_random_uuid(); qy uuid := gen_random_uuid(); qz uuid := gen_random_uuid();
  nums text[]; v_num text; n int; ok boolean; q public.crm_quotes; base timestamp;
  seq_last bigint; seq_called boolean;
begin
  select last_value, is_called into seq_last, seq_called from public.crm_quote_seq;
  begin
    -- Datos de prueba (como dueño): dos vendedores activos
    select id into ua from auth.users order by created_at limit 1;
    select id into ub from auth.users where id <> ua order by created_at limit 1;
    if ub is null then raise exception 'faltan auth.users para la prueba'; end if;
    insert into public.crm_profiles (id, name, email, role, active) values
      (ua, 'Vendedor A Test', 'a@test.local', 'vendedor', true),
      (ub, 'Vendedor B Test', 'b@test.local', 'vendedor', true)
      on conflict (id) do update set role = 'vendedor', active = true;
    insert into public.crm_clients (name, rut, region, sellers, origen)
      values ('Constructora Ñandú  Test', '1.234.567-4', 'RM', array[ua, ub], 'CRM') returning id into cli;

    -- ===== Actuar como A =====
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    set local role authenticated;

    -- 1) reservar 3 números
    nums := public.crm_reservar_numeros(3);
    if coalesce(array_length(nums, 1), 0) <> 3 then raise exception 'reservar(3) no devolvió 3: %', nums; end if;
    if (select count(distinct x) from unnest(nums) x) <> 3 then raise exception 'números repetidos: %', nums; end if;
    if exists (select 1 from unnest(nums) x where x !~ '^COT-[0-9]{4}-[0-9]{4,}$') then raise exception 'formato inválido: %', nums; end if;
    ok := false;
    begin perform public.crm_reservar_numeros(21); exception when others then ok := true; end;
    if not ok then raise exception 'reservar(21) no falló'; end if;

    -- 2) insertar con número reservado; repetir con on conflict -> sin error ni duplicado
    insert into public.crm_quotes (id, num, client_id, user_id, date, updated_at)
      values (qx, nums[1], cli, ua, current_date, timestamp '2020-01-01 00:00:00');
    insert into public.crm_quotes (id, num, client_id, user_id, date)
      values (qx, nums[1], cli, ua, current_date) on conflict (id) do nothing;

    -- 3) otra cotización con el mismo número -> error
    ok := false;
    begin
      insert into public.crm_quotes (id, num, client_id, user_id, date) values (qy, nums[1], cli, ua, current_date);
    exception when others then
      if sqlerrm <> 'Número de cotización no reservado' then raise exception 'error inesperado (Y): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'número ya usado aceptado en otra cotización'; end if;

    -- 4) número inventado -> error; num null -> asignado como hoy
    ok := false;
    begin
      insert into public.crm_quotes (id, num, client_id, user_id, date) values (qy, 'COT-1999-9999', cli, ua, current_date);
    exception when others then
      if sqlerrm <> 'Número de cotización no reservado' then raise exception 'error inesperado (inventado): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'número inventado aceptado'; end if;
    insert into public.crm_quotes (id, num, client_id, user_id, date) values (qz, null, cli, ua, current_date) returning num into v_num;
    if v_num is null or v_num !~ ('^COT-' || to_char(public.crm_now_cl(), 'YYYY') || '-[0-9]{4,}$') then raise exception 'num null no asignado: %', v_num; end if;

    -- 5) crm_resolver_cliente
    r := public.crm_resolver_cliente(jsonb_build_object('id', gen_random_uuid(), 'name', 'Otro nombre', 'rut', '1234567-4', 'region', 'RM', 'sellers', jsonb_build_array(ua)));
    if r <> cli then raise exception 'resolver por RUT no devolvió el existente'; end if;
    r := public.crm_resolver_cliente(jsonb_build_object('id', gen_random_uuid(), 'name', '  constructora ñandu TEST ', 'rut', '', 'region', 'RM', 'sellers', jsonb_build_array(ua)));
    if r <> cli then raise exception 'resolver por nombre no devolvió el existente'; end if;
    r := public.crm_resolver_cliente(jsonb_build_object('id', cnew, 'name', 'Prospecto Nuevo Offline Test', 'rut', '', 'region', 'RM',
      'sellers', jsonb_build_array(ua), 'origen', 'prospecto', 'contacts', '[{"name":"Juan"}]'::jsonb));
    if r <> cnew then raise exception 'resolver nuevo no devolvió el id del teléfono: %', r; end if;
    r := public.crm_resolver_cliente(jsonb_build_object('id', cnew, 'name', 'Prospecto Nuevo Offline Test', 'rut', '', 'region', 'RM',
      'sellers', jsonb_build_array(ua), 'origen', 'prospecto'));
    if r <> cnew then raise exception 'resolver repetido devolvió otro id: %', r; end if;

    -- 6) crm_editar_cotizacion
    select updated_at into base from public.crm_quotes where id = qx;
    q := public.crm_editar_cotizacion(qx, base, jsonb_build_object('notes', 'nota offline', 'items', '[{"code":"X","qty":2}]'::jsonb,
      'valid_days', 15, 'num', 'HACK', 'status', 'ganada'), false, 'Editada sin conexión');
    if q.notes is distinct from 'nota offline' or q.valid_days <> 15 or q.items <> '[{"code":"X","qty":2}]'::jsonb then raise exception 'cambios no aplicados'; end if;
    if q.num <> nums[1] or q.status <> 'borrador' then raise exception 'editar tocó num/status: % %', q.num, q.status; end if;
    if jsonb_array_length(q.history) <> 1 or q.history->0->>'text' <> 'Editada sin conexión' or q.history->0->>'user' <> ua::text then raise exception 'historia no agregada: %', q.history; end if;
    if q.updated_at = base then raise exception 'updated_at no cambió'; end if;
    -- base vieja -> CONFLICTO
    ok := false;
    begin
      perform public.crm_editar_cotizacion(qx, base, '{"notes":"x"}'::jsonb, false, 'x');
    exception when others then
      if sqlerrm not like 'CONFLICTO%' then raise exception 'error inesperado (base vieja): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'base vieja no dio conflicto'; end if;
    -- actualización estilo app publicada (saveQ): updated_at lo fija el servidor
    update public.crm_quotes set status = 'pendiente', updated_at = timestamp '2000-01-01' where id = qx;
    select updated_at into base from public.crm_quotes where id = qx;
    if base < timestamp '2020-01-01' then raise exception 'trigger updated_at no sobrescribió'; end if;
    ok := false;
    begin
      perform public.crm_editar_cotizacion(qx, base, '{"notes":"x"}'::jsonb, false, 'x');
    exception when others then
      if sqlerrm <> 'CONFLICTO: la cotización cambió de estado' then raise exception 'error inesperado (pendiente): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'edición sobre pendiente no falló'; end if;
    -- requiere aprobación -> pendiente
    select updated_at into base from public.crm_quotes where id = qz;
    q := public.crm_editar_cotizacion(qz, base, '{"notes":"con dcto"}'::jsonb, true, 'Editada: requiere aprobación');
    if q.status <> 'pendiente' or q.num <> v_num then raise exception 'requiere_aprobacion: % %', q.status, q.num; end if;

    -- ===== Actuar como B =====
    perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
    ok := false;
    begin
      insert into public.crm_quotes (id, num, client_id, user_id, date) values (qy, nums[2], cli, ub, current_date);
    exception when others then
      if sqlerrm <> 'Número de cotización no reservado' then raise exception 'error inesperado (B): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'B usó un número reservado por A'; end if;
    -- B no puede editar cotización de A
    ok := false;
    begin perform public.crm_editar_cotizacion(qz, base, '{}'::jsonb, false, 'x'); exception when others then ok := true; end;
    if not ok then raise exception 'B editó cotización de A'; end if;

    -- ===== Verificaciones como dueño =====
    reset role;
    select count(*) into n from public.crm_quote_reservas where user_id = ua and num = any(nums);
    if n <> 3 then raise exception 'reservas de A: %', n; end if;
    if (select quote_id from public.crm_quote_reservas where num = nums[1]) is distinct from qx then raise exception 'reserva sin quote_id'; end if;
    if (select usado_at from public.crm_quote_reservas where num = nums[1]) is null then raise exception 'reserva sin usado_at'; end if;
    select count(*) into n from public.crm_quotes where id = qx; if n <> 1 then raise exception 'filas qx: %', n; end if;
    select count(*) into n from public.crm_quotes where id = qy; if n <> 0 then raise exception 'qy se insertó'; end if;
    select count(*) into n from public.crm_clients where id = cnew; if n <> 1 then raise exception 'prospecto nuevo: %', n; end if;
    select count(*) into n from public.crm_clients where rut = '1.234.567-4' or name ilike '%ñand%test%'; if n <> 1 then raise exception 'cliente duplicado: %', n; end if;

    raise exception 'OK_ROLLBACK';
  exception when others then
    reset role;
    perform setval('public.crm_quote_seq', seq_last, seq_called);
    raise;
  end;
end $$;
