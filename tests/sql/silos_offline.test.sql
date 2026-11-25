-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Silos sin conexión (fase 4): versión del servidor (updated_at), alta idempotente de solicitudes
-- (sil_crear_solicitud), guardado con versión (sil_guardar_solicitud), reserva de códigos SOL-NNNN
-- (sil_reservar_codigos) y cli_registrar devolviendo el id del cliente. Usa usuarios reales solo
-- como identidad (no los modifica); todo lo creado se revierte al final.
do $$
declare
  v1 uuid; v2 uuid; adm uuid;
  sol uuid := gen_random_uuid();
  sol_ajena uuid := gen_random_uuid();
  u1 timestamptz; u1b timestamptz; v0 timestamptz; v1ts timestamptz;
  ok boolean; n int;
  cods1 text[]; cods2 text[]; allcods text[];
  v_rut text := 'TEST99999901';
  id1 uuid; id2 uuid;
  v_silo uuid;
  ev uuid := gen_random_uuid();
  ev_ajeno uuid := gen_random_uuid();
  t1 timestamptz; t2 timestamptz;
  cod_r text; cod_otro text;
  sol_cr uuid := gen_random_uuid();
  v_inst timestamptz;
begin
  select id into v1 from public.profiles where activo and rol::text = 'vendedor' order by id limit 1;
  select id into v2 from public.profiles where activo and rol::text = 'vendedor' and id <> v1 order by id limit 1;
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  if v1 is null or v2 is null or adm is null then raise exception 'faltan usuarios activos (2 vendedores y 1 admin) para la prueba'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v1, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- ===== 1) sil_crear_solicitud dos veces con el mismo id: una sola fila, mismo updated_at =====
  u1 := public.sil_crear_solicitud(jsonb_build_object('id', sol,
          'data', jsonb_build_object('cliente', 'Cliente Test', 'obra', 'Obra Test')));
  u1b := public.sil_crear_solicitud(jsonb_build_object('id', sol,
          'data', jsonb_build_object('cliente', 'Otro', 'obra', 'Otra')));
  select count(*) into n from public.solicitudes where id = sol;
  if n <> 1 then raise exception 'caso 1: se esperaba 1 fila y hay %', n; end if;
  if u1 is null or u1 is distinct from u1b then raise exception 'caso 1: updated_at distinto (% vs %)', u1, u1b; end if;
  if (select data->>'cliente' from public.solicitudes where id = sol) <> 'Cliente Test' then
    raise exception 'caso 1: el segundo envío pisó los datos';
  end if;
  if (select created_by from public.solicitudes where id = sol) is distinct from v1 then
    raise exception 'caso 1: created_by no es auth.uid()';
  end if;
  raise notice 'caso 1 OK: sil_crear_solicitud idempotente (una fila, mismo updated_at)';

  -- ===== 2) sil_guardar_solicitud con p_base vigente: actualiza y updated_at sube =====
  v0 := u1;
  v1ts := public.sil_guardar_solicitud(sol, v0, jsonb_build_object('estado', 'Aprobada',
            'data', jsonb_build_object('cliente', 'Cliente Test', 'obra', 'Obra Editada')));
  if v1ts <= v0 then raise exception 'caso 2: updated_at no subió (% -> %)', v0, v1ts; end if;
  if (select estado from public.solicitudes where id = sol) <> 'Aprobada'
     or (select data->>'obra' from public.solicitudes where id = sol) <> 'Obra Editada' then
    raise exception 'caso 2: los cambios no quedaron guardados';
  end if;
  raise notice 'caso 2 OK: sil_guardar_solicitud con versión vigente, updated_at subió';

  -- ===== 3) sil_guardar_solicitud con el p_base viejo: CONFLICTO =====
  ok := false;
  begin
    perform public.sil_guardar_solicitud(sol, v0, jsonb_build_object('data', '{}'::jsonb));
  exception when others then
    if sqlerrm not like 'CONFLICTO:%' then raise exception 'caso 3: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 3: no hubo CONFLICTO con base vieja'; end if;
  if (select data->>'obra' from public.solicitudes where id = sol) <> 'Obra Editada' then
    raise exception 'caso 3: el conflicto igual modificó la fila';
  end if;
  raise notice 'caso 3 OK: base vieja => CONFLICTO sin tocar la fila';

  -- ===== 4) sil_guardar_solicitud sobre un id inexistente: NO_EXISTE =====
  ok := false;
  begin
    perform public.sil_guardar_solicitud(gen_random_uuid(), v1ts, jsonb_build_object('data', '{}'::jsonb));
  exception when others then
    if sqlerrm not like 'NO_EXISTE:%' then raise exception 'caso 4: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 4: no hubo NO_EXISTE'; end if;
  raise notice 'caso 4 OK: id inexistente => NO_EXISTE';

  -- ===== 5) sil_reservar_codigos(3) con dos usuarios distintos: 6 códigos, todos distintos =====
  cods1 := public.sil_reservar_codigos(3);
  perform set_config('request.jwt.claims', json_build_object('sub', v2, 'role', 'authenticated')::text, true);
  cods2 := public.sil_reservar_codigos(3);
  perform set_config('request.jwt.claims', json_build_object('sub', v1, 'role', 'authenticated')::text, true);

  if array_length(cods1, 1) <> 3 or array_length(cods2, 1) <> 3 then
    raise exception 'caso 5: cantidad de códigos incorrecta (% / %)', cods1, cods2;
  end if;
  allcods := cods1 || cods2;
  select count(*) into n from (select distinct unnest(allcods)) t;
  if n <> 6 then raise exception 'caso 5: se esperaban 6 códigos distintos, hay % (%)', n, allcods; end if;
  raise notice 'caso 5 OK: sil_reservar_codigos entrega códigos distintos entre dos usuarios (% / %)', cods1, cods2;

  -- ===== 6) sil_crear_solicitud con un id ya usado por OTRO autor: AJENO, fila ajena intacta =====
  reset role;
  insert into public.solicitudes (id, estado, data, created_by)
    values (sol_ajena, 'Solicitada', jsonb_build_object('cliente', 'Ajeno'), adm);
  set local role authenticated;
  ok := false;
  begin
    perform public.sil_crear_solicitud(jsonb_build_object('id', sol_ajena, 'data', jsonb_build_object('cliente', 'Intruso')));
  exception when others then
    if sqlerrm not like 'AJENO:%' then raise exception 'caso 6: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 6: el alta con id ajeno no lanzó AJENO'; end if;
  reset role;
  if (select data->>'cliente' from public.solicitudes where id = sol_ajena) <> 'Ajeno'
     or (select created_by from public.solicitudes where id = sol_ajena) <> adm then
    raise exception 'caso 6: la fila ajena fue modificada';
  end if;
  set local role authenticated;
  raise notice 'caso 6 OK: id ajeno => AJENO, fila ajena intacta';

  -- ===== 7) cli_registrar llamado dos veces con el mismo RUT: mismo id, sin fila nueva =====
  id1 := public.cli_registrar(v_rut, 'Cliente Prueba RUT', 'Comuna Test', 'Dirección 123', 'Vendedor Test');
  if id1 is null then raise exception 'caso 7: cli_registrar no devolvió id en el primer llamado'; end if;
  id2 := public.cli_registrar(v_rut, 'Cliente Prueba RUT', 'Comuna Test', 'Dirección 123', 'Vendedor Test');
  if id2 is distinct from id1 then raise exception 'caso 7: el segundo llamado devolvió un id distinto (% vs %)', id1, id2; end if;
  select count(*) into n from public.crm_clients where rut_key = upper(regexp_replace(v_rut, '[^0-9kK]', '', 'g'));
  if n <> 1 then raise exception 'caso 7: se esperaba 1 fila de cliente y hay %', n; end if;
  raise notice 'caso 7 OK: cli_registrar idempotente por RUT, mismo id devuelto (%)', id1;

  -- ===== 8) sil_crear_evento: alta idempotente y AJENO (mismo patrón que sil_crear_solicitud) =====
  select id into v_silo from public.silos limit 1;
  if v_silo is null then raise exception 'no hay silos para la prueba de sil_crear_evento'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  t1 := public.sil_crear_evento(jsonb_build_object('id', ev, 'tipo', 'Mantención', 'silo_id', v_silo,
          'data', jsonb_build_object('a', 1)));
  t2 := public.sil_crear_evento(jsonb_build_object('id', ev, 'tipo', 'Mantención', 'silo_id', v_silo,
          'data', jsonb_build_object('a', 2)));
  select count(*) into n from public.eventos where id = ev;
  if n <> 1 then raise exception 'caso 8: se esperaba 1 fila y hay %', n; end if;
  if t1 is null or t1 is distinct from t2 then raise exception 'caso 8: updated_at distinto (% vs %)', t1, t2; end if;
  if (select data->>'a' from public.eventos where id = ev) <> '1' then
    raise exception 'caso 8: el segundo envío pisó los datos';
  end if;
  if (select created_by from public.eventos where id = ev) is distinct from adm then
    raise exception 'caso 8: created_by no es auth.uid()';
  end if;
  raise notice 'caso 8 OK: sil_crear_evento idempotente (una fila, mismo updated_at)';

  -- id de evento ya usado por OTRO autor (vendedor v1): AJENO, fila ajena intacta
  reset role;
  insert into public.eventos (id, tipo, fecha, silo_id, data, created_by)
    values (ev_ajeno, 'Mantención', current_date, v_silo, jsonb_build_object('a', 'ajeno'), v1);
  set local role authenticated;
  ok := false;
  begin
    perform public.sil_crear_evento(jsonb_build_object('id', ev_ajeno, 'tipo', 'Mantención', 'silo_id', v_silo,
              'data', jsonb_build_object('a', 'intruso')));
  exception when others then
    if sqlerrm not like 'AJENO:%' then raise exception 'caso 8b: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 8b: el alta con id de evento ajeno no lanzó AJENO'; end if;
  reset role;
  if (select data->>'a' from public.eventos where id = ev_ajeno) <> 'ajeno'
     or (select created_by from public.eventos where id = ev_ajeno) <> v1 then
    raise exception 'caso 8b: la fila ajena fue modificada';
  end if;
  set local role authenticated;
  raise notice 'caso 8b OK: id de evento ajeno => AJENO, fila ajena intacta';

  -- ===== 9) disparador de código (hoy desactivado en producción por C-1): se activa solo dentro
  --         de esta transacción para probarlo; el rollback lo deja desactivado afuera =====
  perform set_config('request.jwt.claims', json_build_object('sub', v1, 'role', 'authenticated')::text, true);
  reset role;
  alter table public.solicitudes enable trigger sil_solicitudes_codigo_trg;
  set local role authenticated;

  -- 9a) código reservado por el propio usuario: se acepta y queda marcado con la solicitud
  cod_r := (public.sil_reservar_codigos(1))[1];
  perform public.sil_crear_solicitud(jsonb_build_object('id', sol_cr, 'data', jsonb_build_object('codigo', cod_r)));
  reset role;
  if (select solicitud_id from public.sil_solicitud_reservas where num = cod_r) is distinct from sol_cr then
    raise exception 'caso 9a: el código reservado no quedó marcado con la solicitud';
  end if;
  set local role authenticated;
  raise notice 'caso 9a OK: código reservado por el propio usuario se acepta y se marca (%)', cod_r;

  -- 9b) reenvío idempotente con el mismo código ya usado: no debe fallar
  perform public.sil_crear_solicitud(jsonb_build_object('id', sol_cr, 'data', jsonb_build_object('codigo', cod_r)));
  raise notice 'caso 9b OK: reenvío con el mismo código ya usado no falla';

  -- 9c) código no reservado por nadie: rechazo
  ok := false;
  begin
    perform public.sil_crear_solicitud(jsonb_build_object('id', gen_random_uuid(), 'data', jsonb_build_object('codigo', 'SOL-9001')));
  exception when others then
    if sqlerrm <> 'Código de solicitud no reservado' then raise exception 'caso 9c: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 9c: un código no reservado no fue rechazado'; end if;
  raise notice 'caso 9c OK: código no reservado => rechazo';

  -- 9d) código reservado por OTRO usuario (v2): rechazo
  perform set_config('request.jwt.claims', json_build_object('sub', v2, 'role', 'authenticated')::text, true);
  cod_otro := (public.sil_reservar_codigos(1))[1];
  perform set_config('request.jwt.claims', json_build_object('sub', v1, 'role', 'authenticated')::text, true);
  ok := false;
  begin
    perform public.sil_crear_solicitud(jsonb_build_object('id', gen_random_uuid(), 'data', jsonb_build_object('codigo', cod_otro)));
  exception when others then
    if sqlerrm <> 'Código de solicitud no reservado' then raise exception 'caso 9d: error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 9d: un código reservado por otro usuario no fue rechazado'; end if;
  raise notice 'caso 9d OK: código reservado por otro usuario => rechazo (%)', cod_otro;

  -- ===== 10) sil_guardar_solicitud sobre una solicitud propia en un estado fuera de alcance:
  --          SIN_PERMISO, no NO_EXISTE (I-2) =====
  reset role;
  update public.solicitudes set estado = 'Instalada' where id = sol;
  select updated_at into v_inst from public.solicitudes where id = sol;
  set local role authenticated;
  ok := false;
  begin
    perform public.sil_guardar_solicitud(sol, v_inst, jsonb_build_object('data',
              jsonb_build_object('cliente', 'Cliente Test', 'obra', 'Obra Editada 2')));
  exception when others then
    if sqlerrm <> 'SIN_PERMISO: no tienes permiso para editar esta solicitud' then
      raise exception 'caso 10: error inesperado: %', sqlerrm;
    end if;
    ok := true;
  end;
  if not ok then raise exception 'caso 10: no hubo SIN_PERMISO sobre una solicitud en estado fuera de alcance'; end if;
  if (select data->>'obra' from public.solicitudes where id = sol) <> 'Obra Editada' then
    raise exception 'caso 10: la fila fue modificada a pesar del error de permiso';
  end if;
  raise notice 'caso 10 OK: SIN_PERMISO (no NO_EXISTE) cuando el problema es de permiso, no de existencia';

  reset role;
  raise exception 'OK_ROLLBACK';
exception when others then
  reset role;
  raise;
end $$;
