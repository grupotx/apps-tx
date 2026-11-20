-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- CRM offline (Task 6 revisión): tope de reservas con vencimiento y crm_registrar_entrega.
--
-- ADVERTENCIA: consume valores de public.crm_quote_seq (nextval no se revierte) y al final los
-- restaura sin bajar del mayor número realmente usado (igual que crm_offline.test.sql).
do $$
declare
  ua uuid; ub uuid; cli uuid;
  qx uuid := gen_random_uuid();
  linea jsonb := jsonb_build_object('ts', '2026-11-20T10:00', 'user', 'x', 'text', 'PDF descargado');
  base timestamp; n int; ok boolean; v_status text; v_sent date; v_hist jsonb; v_upd timestamp;
  seq_last bigint; seq_called boolean; v_real bigint;
begin
  select last_value, is_called into seq_last, seq_called from public.crm_quote_seq;
  begin
    select id into ua from auth.users order by created_at limit 1;
    select id into ub from auth.users where id <> ua order by created_at limit 1;
    if ub is null then raise exception 'faltan auth.users para la prueba'; end if;
    insert into public.crm_profiles (id, name, email, role, active) values
      (ua, 'Vendedor A Test', 'a@test.local', 'vendedor', true),
      (ub, 'Vendedor B Test', 'b@test.local', 'vendedor', true)
      on conflict (id) do update set role = 'vendedor', active = true;
    insert into public.crm_clients (name, rut, region, sellers, origen)
      values ('Entrega Test', '1.234.567-4', 'RM', array[ua, ub], 'CRM') returning id into cli;
    -- 45 reservas viejas (8 días) sin usar de A: no deben contar para el tope
    delete from public.crm_quote_reservas where user_id = ua and quote_id is null;
    insert into public.crm_quote_reservas (num, user_id, reservado_at)
      select 'TESTVIEJA-' || g, ua, now() - interval '8 days' from generate_series(1, 45) g;
    -- cotización de A, en borrador, con versión conocida
    insert into public.crm_quotes (id, num, client_id, user_id, date, status, history)
      values (qx, null, cli, ua, current_date, 'borrador', '[]'::jsonb);

    -- ===== Actuar como A =====
    perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
    set local role authenticated;

    -- 1) tope con vencimiento: las viejas no bloquean; 40 recientes sí
    perform public.crm_reservar_numeros(20);
    perform public.crm_reservar_numeros(20);
    ok := false;
    begin
      perform public.crm_reservar_numeros(1);
    exception when others then
      if sqlerrm <> 'Demasiados números reservados sin usar' then raise exception 'error inesperado (tope): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'tope de 40 recientes no aplicado'; end if;

    -- 2) entrega: agrega la línea una sola vez, sent_at, borrador -> enviada, sin tocar updated_at
    select updated_at into base from public.crm_quotes where id = qx;
    perform public.crm_registrar_entrega(qx, linea, current_date, true);
    perform public.crm_registrar_entrega(qx, linea, null, true);
    select status, sent_at, history, updated_at into v_status, v_sent, v_hist, v_upd from public.crm_quotes where id = qx;
    if jsonb_array_length(v_hist) <> 1 or v_hist->0 <> linea then raise exception 'historia: %', v_hist; end if;
    if v_status <> 'enviada' then raise exception 'status: %', v_status; end if;
    if v_sent is distinct from current_date then raise exception 'sent_at: %', v_sent; end if;
    if v_upd is distinct from base then raise exception 'updated_at cambió: % -> %', base, v_upd; end if;
    -- sin línea (solo sent_at): no agrega historia
    perform public.crm_registrar_entrega(qx, null, current_date, false);
    select history into v_hist from public.crm_quotes where id = qx;
    if jsonb_array_length(v_hist) <> 1 then raise exception 'línea nula agregó historia'; end if;
    -- una actualización normal después sí cambia la versión (la marca no queda pegada)
    update public.crm_quotes set notes = 'x' where id = qx;
    select updated_at into v_upd from public.crm_quotes where id = qx;
    if v_upd = base then raise exception 'updated_at quedó congelado después de la entrega'; end if;

    -- ===== Actuar como B: no puede registrar entrega en la cotización de A =====
    perform set_config('request.jwt.claims', json_build_object('sub', ub, 'role', 'authenticated')::text, true);
    ok := false;
    begin
      perform public.crm_registrar_entrega(qx, jsonb_build_object('ts', 't', 'user', 'y', 'text', 'Enviada por B'), current_date, true);
    exception when others then
      if sqlerrm <> 'Cotización no encontrada o no es tuya' then raise exception 'error inesperado (B): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'B registró entrega en cotización de A'; end if;

    -- ===== Verificaciones como dueño =====
    reset role;
    select jsonb_array_length(history) into n from public.crm_quotes where id = qx;
    if n <> 1 then raise exception 'historia final: %', n; end if;
    if has_function_privilege('anon', 'public.crm_registrar_entrega(uuid, jsonb, date, boolean)', 'execute') then
      raise exception 'anon puede ejecutar crm_registrar_entrega';
    end if;
    if not has_function_privilege('authenticated', 'public.crm_registrar_entrega(uuid, jsonb, date, boolean)', 'execute') then
      raise exception 'authenticated no puede ejecutar crm_registrar_entrega';
    end if;

    raise exception 'OK_ROLLBACK';
  exception when others then
    reset role;
    select coalesce(max(substring(x from '-([0-9]+)$')::bigint), 0) into v_real
      from (select num as x from public.crm_quotes union all select num from public.crm_quote_reservas where num like 'COT-%') s;
    if v_real > seq_last then
      perform setval('public.crm_quote_seq', v_real, true);
    else
      perform setval('public.crm_quote_seq', seq_last, seq_called);
    end if;
    raise;
  end;
end $$;
