-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 5: solución, comunicación, cierre, corregir compensación, anular, reabrir, alcances, motivos y bitácora
-- de cambios de acceso. La identidad se simula con request.jwt.claims sobre perfiles reales (solo como identidad);
-- las funciones validan con auth.uid().
create or replace function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.falla(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

create or replace function pg_temp.hist(p_id uuid) returns text language sql as $$
  select coalesce(string_agg(tipo || ':' || coalesce(de_estado, '-') || '>' || coalesce(a_estado, '-'), ',' order by id), '')
    from public.rec_eventos where reclamo_id = p_id
$$;

do $$
declare
  uids uuid[];
  sc uuid; v1 uuid; enc_l uuid; adm uuid; otro uuid;
  cli uuid;
  hoy date := (now() at time zone 'America/Santiago')::date;
  a uuid; b uuid; c uuid; d uuid;
  v_msg text; v_n int; v_n2 int; r public.rec_reclamos; ev public.rec_eventos; v_ok boolean;
begin
  -- ── actores ──
  select array_agg(id order by id) into uids from (select id from public.profiles where activo and rol::text <> 'admin' order by id limit 6) t;
  if cardinality(uids) < 6 then raise exception 'faltan perfiles activos no admin para la prueba'; end if;
  sc := uids[1]; v1 := uids[2]; enc_l := uids[3]; otro := uids[4];
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  insert into public.rec_usuarios (id, activo) values (sc, true), (v1, true), (enc_l, true), (otro, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values
    (sc, 'servicio_cliente', null, null),
    (enc_l, 'encargado_area', 'logistica', null);
  select id into cli from public.crm_clients order by id limit 1;

  -- reclamo "a": ingresado → derivado → aprobado, listo para la solución
  perform pg_temp.act(v1);
  a := public.rec_crear(cli, null, 'atraso_despacho', 'El camión llegó dos días tarde', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(a, 'logistica');
  perform pg_temp.act(enc_l);
  perform public.rec_decidir(a, 'aprobado', 'Hubo atraso confirmado en bodega.');

  -- ── (1) definir solución: validaciones ──
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, %L)', a, 'descuento', 'x', 1000));
  if v_msg is null or v_msg !~* 'servicio al cliente' then raise exception 'caso 1a: el vendedor no define la solución, dio %', v_msg; end if;
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, null)', a, 'descuento', 'x'));
  if v_msg is null or v_msg !~* 'compensaci' then raise exception 'caso 1b: sin monto debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, %L)', a, 'descuento', 'x', -1));
  if v_msg is null or v_msg !~* 'negativ|compensaci' then raise exception 'caso 1c: monto negativo debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, %L)', a, 'descuento', 'x', '12.5'));
  if v_msg is null then raise exception 'caso 1d: un monto decimal debía fallar'; end if;
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, %L)', a, 'regalo', 'x', 1000));
  if v_msg is null or v_msg !~* 'soluci' then raise exception 'caso 1e: tipo de solución inválido debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_definir_solucion(%L, %L, %L, %L)', a, 'explicacion', 'solo explico', 500));
  if v_msg is null or v_msg !~* 'explicaci|monto|compensaci' then raise exception 'caso 1f: una explicación sin compensación no lleva monto, dio %', v_msg; end if;
  if (select estado from public.rec_reclamos where id = a) <> 'aprobado' then raise exception 'caso 1g: los intentos fallidos movieron el reclamo'; end if;

  -- ── (2) ciclo completo hasta cerrado, con un evento por paso ──
  perform public.rec_definir_solucion(a, 'reposicion', 'Se repone el pedido en la próxima entrega.', 45000);
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'solucion_definida' or r.solucion_tipo <> 'reposicion' or r.compensacion <> 45000 or r.solucion_detalle is null then raise exception 'caso 2a: solución inesperada: %', to_jsonb(r); end if;
  v_msg := pg_temp.falla(format('select public.rec_cerrar(%L)', a));
  if v_msg is null or v_msg !~* 'ya cambió de estado' then raise exception 'caso 2b: cerrar sin comunicar debía fallar por estado, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_comunicar(%L, %L)', a, '   '));
  if v_msg is null or v_msg !~* 'mensaje' then raise exception 'caso 2c: comunicar sin mensaje debía fallar, dio %', v_msg; end if;
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_comunicar(%L, %L)', a, 'hola'));
  if v_msg is null then raise exception 'caso 2d: el vendedor no comunica'; end if;
  perform pg_temp.act(sc);
  perform public.rec_comunicar(a, 'Estimado cliente: su reclamo fue aprobado...', 'correo');
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'comunicado' or r.comunicado_en is null or r.comunicado_por <> sc or r.canal <> 'correo' or r.mensaje_cliente is null then raise exception 'caso 2e: comunicación inesperada: %', to_jsonb(r); end if;
  perform public.rec_cerrar(a);
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'cerrado' or r.cerrado_en is null then raise exception 'caso 2f: cierre inesperado: %', to_jsonb(r); end if;
  if pg_temp.hist(a) <> 'creado:->ingresado,derivado:ingresado>derivado,decidido:derivado>aprobado,solucion_definida:aprobado>solucion_definida,comunicado:solucion_definida>comunicado,cerrado:comunicado>cerrado'
     then raise exception 'caso 2g: historia del ciclo completo inesperada: %', pg_temp.hist(a); end if;
  select count(*) into v_n from public.rec_eventos where reclamo_id = a;
  v_msg := pg_temp.falla(format('select public.rec_cerrar(%L)', a));
  if v_msg is null or v_msg !~* 'ya cambió de estado' or v_msg !~* 'cerrado' then raise exception 'caso 2h: cerrar dos veces debía fallar con el estado real, dio %', v_msg; end if;
  select count(*) into v_n2 from public.rec_eventos where reclamo_id = a;
  if v_n2 <> v_n then raise exception 'caso 2i: el cierre repetido agregó un evento'; end if;

  -- ── (3) corregir compensación: servicio al cliente hasta antes de cerrar, después solo admin ──
  perform pg_temp.act(v1);
  b := public.rec_crear(cli, null, 'facturacion_cobro', 'Cobro duplicado en la factura', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(b, 'logistica');
  perform pg_temp.act(enc_l);
  perform public.rec_decidir(b, 'rechazado', 'La factura está bien emitida.');
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', b, 100, 'x'));
  if v_msg is null then raise exception 'caso 3a: no se corrige una compensación que aún no existe'; end if;
  perform public.rec_definir_solucion(b, 'explicacion', 'Se explica el cobro al cliente.', 0);
  if (select compensacion from public.rec_reclamos where id = b) <> 0 then raise exception 'caso 3b: la compensación 0 debía guardarse'; end if;
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', b, 100, '  '));
  if v_msg is null or v_msg !~* 'motivo' then raise exception 'caso 3c: corregir sin motivo debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', b, -5, 'error de tipeo'));
  if v_msg is null then raise exception 'caso 3d: monto negativo debía fallar'; end if;
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', b, 0, 'sin cambio'));
  if v_msg is null then raise exception 'caso 3e: corregir al mismo monto debía fallar'; end if;
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', b, 800, 'explicación no lleva monto'));
  if v_msg is null then raise exception 'caso 3f: una explicación sin compensación no admite monto'; end if;
  -- reclamo "c" con compensación corregible
  perform pg_temp.act(v1);
  c := public.rec_crear(cli, null, 'atraso_despacho', 'Despacho incompleto', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(c, 'logistica');
  perform pg_temp.act(enc_l);
  perform public.rec_decidir(c, 'aprobado', 'Faltaron pallets.');
  perform pg_temp.act(sc);
  perform public.rec_definir_solucion(c, 'nota_credito', 'Nota de crédito por lo faltante.', 20000);
  perform public.rec_corregir_compensacion(c, 25000, 'Se sumó el flete');   -- en solucion_definida
  perform public.rec_comunicar(c, 'Mensaje al cliente', null);
  perform public.rec_corregir_compensacion(c, 26000, 'Ajuste por IVA');      -- en comunicado
  select * into ev from public.rec_eventos where reclamo_id = c and tipo = 'compensacion_corregida' order by id desc limit 1;
  if ev.nota <> 'Ajuste por IVA' or (ev.detalle->>'monto_anterior')::bigint <> 25000 or (ev.detalle->>'monto_nuevo')::bigint <> 26000 or ev.de_estado <> 'comunicado' or ev.a_estado <> 'comunicado'
     then raise exception 'caso 3g: evento de corrección inesperado: %', to_jsonb(ev); end if;
  perform public.rec_cerrar(c);
  v_msg := pg_temp.falla(format('select public.rec_corregir_compensacion(%L, %L, %L)', c, 27000, 'después del cierre'));
  if v_msg is null or v_msg !~* 'administrador' then raise exception 'caso 3h: servicio al cliente sobre un cerrado debía fallar con mensaje de administrador, dio %', v_msg; end if;
  perform pg_temp.act(adm);
  perform public.rec_corregir_compensacion(c, 27000, 'Corrección autorizada por gerencia');
  if (select compensacion from public.rec_reclamos where id = c) <> 27000 then raise exception 'caso 3i: el admin debía poder corregir un cerrado'; end if;
  select * into ev from public.rec_eventos where reclamo_id = c and tipo = 'compensacion_corregida' order by id desc limit 1;
  if (ev.detalle->>'monto_anterior')::bigint <> 26000 or (ev.detalle->>'monto_nuevo')::bigint <> 27000 or ev.de_estado <> 'cerrado' or ev.usuario <> adm
     then raise exception 'caso 3j: evento de corrección del admin inesperado: %', to_jsonb(ev); end if;

  -- ── (4) anular: motivo obligatorio, un cerrado no se anula, el vendedor no anula ──
  perform pg_temp.act(v1);
  d := public.rec_crear(cli, null, 'otro', 'Reclamo duplicado', hoy);
  v_msg := pg_temp.falla(format('select public.rec_anular(%L, %L)', d, 'duplicado'));
  if v_msg is null or v_msg !~* 'servicio al cliente' then raise exception 'caso 4a: el vendedor no anula, dio %', v_msg; end if;
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_anular(%L, %L)', d, '  '));
  if v_msg is null or v_msg !~* 'motivo' then raise exception 'caso 4b: anular sin motivo debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_anular(%L, %L)', a, 'intento sobre un cerrado'));
  if v_msg is null or v_msg !~* 'cerrado' then raise exception 'caso 4c: un cerrado no se anula, dio %', v_msg; end if;
  if (select estado from public.rec_reclamos where id = a) <> 'cerrado' then raise exception 'caso 4d: el intento fallido cambió el cerrado'; end if;
  perform public.rec_anular(d, 'Es duplicado del reclamo anterior');
  select * into r from public.rec_reclamos where id = d;
  if r.estado <> 'anulado' then raise exception 'caso 4e: debía quedar anulado'; end if;
  if pg_temp.hist(d) <> 'creado:->ingresado,anulado:ingresado>anulado' then raise exception 'caso 4f: historia de anulación inesperada: %', pg_temp.hist(d); end if;
  v_msg := pg_temp.falla(format('select public.rec_anular(%L, %L)', d, 'otra vez'));
  if v_msg is null or v_msg !~* 'anulado' then raise exception 'caso 4g: anular un anulado debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', d, 'logistica'));
  if v_msg is null then raise exception 'caso 4h: un anulado no se deriva'; end if;
  -- anular en un estado intermedio (derivado) también vale
  perform pg_temp.act(v1);
  d := public.rec_crear(cli, null, 'otro', 'Se equivocó de cliente', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(d, 'comercial');
  perform public.rec_anular(d, 'Ingresado al cliente equivocado');
  if (select estado from public.rec_reclamos where id = d) <> 'anulado' then raise exception 'caso 4i: anular desde derivado'; end if;
  if (select detalle->>'estado_anterior' from public.rec_eventos where reclamo_id = d and tipo = 'anulado') <> 'derivado' then raise exception 'caso 4j: el evento debía guardar el estado anterior'; end if;

  -- ── (5) reabrir: solo admin; vuelve a ingresado con los campos limpios y una copia en el evento ──
  v_msg := pg_temp.falla(format('select public.rec_reabrir(%L, %L)', a, 'revisar de nuevo'));
  if v_msg is null or v_msg !~* 'administrador' then raise exception 'caso 5a: servicio al cliente no reabre, dio %', v_msg; end if;
  perform pg_temp.act(adm);
  v_msg := pg_temp.falla(format('select public.rec_reabrir(%L, %L)', a, '  '));
  if v_msg is null or v_msg !~* 'motivo' then raise exception 'caso 5b: reabrir sin motivo debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_reabrir(%L, %L)', b, 'no está cerrado'));
  if v_msg is null or v_msg !~* 'ya cambió de estado' then raise exception 'caso 5c: reabrir uno que no está cerrado ni anulado debía fallar, dio %', v_msg; end if;
  perform public.rec_reabrir(d, 'Era del cliente correcto');   -- anulado → ingresado
  select * into r from public.rec_reclamos where id = d;
  if r.estado <> 'ingresado' or r.area_destino is not null or r.planta_destino is not null or r.asesor_id is not null or r.decision is not null then raise exception 'caso 5d: reabrir un anulado inesperado: %', to_jsonb(r); end if;
  perform public.rec_reabrir(a, 'El cliente apeló con nuevos antecedentes');   -- cerrado → ingresado
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'ingresado' or r.decision is not null or r.razones is not null or r.decidido_por is not null or r.decidido_en is not null
     or r.solucion_tipo is not null or r.solucion_detalle is not null or r.compensacion is not null or r.mensaje_cliente is not null or r.canal is not null
     or r.comunicado_por is not null or r.comunicado_en is not null or r.cerrado_en is not null or r.area_destino is not null or r.planta_destino is not null
     or r.asesor_id is not null or r.informe is not null then raise exception 'caso 5e: los campos del ciclo anterior debían quedar limpios: %', to_jsonb(r); end if;
  select * into ev from public.rec_eventos where reclamo_id = a and tipo = 'reabierto' order by id desc limit 1;
  if ev.de_estado <> 'cerrado' or ev.a_estado <> 'ingresado' or ev.nota <> 'El cliente apeló con nuevos antecedentes' or ev.usuario <> adm
     or ev.detalle->>'decision' <> 'aprobado' or ev.detalle->>'solucion_tipo' <> 'reposicion' or (ev.detalle->>'compensacion')::bigint <> 45000
     or ev.detalle->>'canal' <> 'correo' or ev.detalle->>'mensaje_cliente' is null or ev.detalle->>'comunicado_en' is null or ev.detalle->>'area_destino' <> 'logistica'
     then raise exception 'caso 5f: el evento de reapertura debía guardar la copia del ciclo anterior: %', to_jsonb(ev); end if;
  if pg_temp.hist(a) not like '%,cerrado:comunicado>cerrado,reabierto:cerrado>ingresado' then raise exception 'caso 5g: historia tras reabrir inesperada: %', pg_temp.hist(a); end if;
  -- el reabierto sigue el flujo normal desde cero
  perform pg_temp.act(sc);
  perform public.rec_derivar(a, 'logistica');
  perform pg_temp.act(enc_l);
  perform public.rec_decidir(a, 'rechazado', 'Con los nuevos antecedentes no procede.');
  perform pg_temp.act(sc);
  perform public.rec_definir_solucion(a, 'explicacion', 'Se explica la decisión.', 0);
  if (select compensacion from public.rec_reclamos where id = a) <> 0 then raise exception 'caso 5h: el segundo ciclo debía guardar su propia compensación'; end if;

  -- ── (6) alcances (solo admin; combinaciones válidas) y bitácora ──
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, %L, true)', otro, 'gerencia', null, null));
  if v_msg is null or v_msg !~* 'administrador' then raise exception 'caso 6a: solo el admin cambia alcances, dio %', v_msg; end if;
  perform pg_temp.act(adm);
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, null, null, true)', otro, 'encargado_area'));
  if v_msg is null or v_msg !~* 'área' then raise exception 'caso 6b: encargado de área sin área debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, null, true)', otro, 'encargado_area', 'produccion'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 6c: producción sin planta debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, null, true)', otro, 'encargado_area', 'calidad'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 6d: calidad sin planta debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, %L, true)', otro, 'encargado_area', 'logistica', 'morteros'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 6e: logística no lleva planta, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, null, null, true)', otro, 'encargado_calidad'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 6f: encargado de calidad sin planta debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, null, true)', otro, 'asesor_tecnico', 'calidad'));
  if v_msg is null then raise exception 'caso 6g: asesor técnico no lleva área'; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, null, %L, true)', otro, 'servicio_cliente', 'morteros'));
  if v_msg is null then raise exception 'caso 6h: servicio al cliente no lleva planta'; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, null, null, true)', otro, 'jefe'));
  if v_msg is null or v_msg !~* 'rol' then raise exception 'caso 6i: rol inválido debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, null, null, true)', uids[6], 'gerencia'));   -- uids[6] no tiene acceso al módulo
  if v_msg is null or v_msg !~* 'acceso' then raise exception 'caso 6j: una persona sin acceso al módulo no recibe alcances, dio %', v_msg; end if;
  perform public.rec_set_alcance(otro, 'encargado_area', 'produccion', 'morteros', true);
  perform public.rec_set_alcance(otro, 'encargado_area', 'produccion', 'morteros', true);   -- idempotente
  select count(*) into v_n from public.rec_alcances where usuario_id = otro and rol = 'encargado_area' and area = 'produccion' and planta = 'morteros';
  if v_n <> 1 then raise exception 'caso 6k: el alcance debía existir una sola vez, hay %', v_n; end if;
  perform public.rec_set_alcance(otro, 'asesor_tecnico', null, null, true);
  perform public.rec_set_alcance(otro, 'encargado_calidad', null, 'pinturas', true);
  select count(*) into v_n from public.rec_alcances where usuario_id = otro;
  if v_n <> 3 then raise exception 'caso 6l: debía tener 3 alcances, tiene %', v_n; end if;
  perform public.rec_set_alcance(otro, 'encargado_area', 'produccion', 'morteros', false);
  select count(*) into v_n from public.rec_alcances where usuario_id = otro and rol = 'encargado_area';
  if v_n <> 0 then raise exception 'caso 6m: el alcance debía borrarse con p_activo = false, quedan %', v_n; end if;
  perform public.rec_set_alcance(otro, 'encargado_area', 'produccion', 'morteros', false);   -- borrar uno que no existe no falla
  -- bitácora: cada alta y baja queda registrada con quién, qué y cuándo
  select count(*) into v_n from public.rec_accesos_log where tipo = 'alcance' and usuario = adm and objetivo->>'usuario' = otro::text;
  if v_n <> 4 then raise exception 'caso 6n: la bitácora debía tener 4 cambios de alcance (3 altas y 1 baja; las repetidas no cuentan), tiene %', v_n; end if;
  if not exists (select 1 from public.rec_accesos_log where tipo = 'alcance' and accion = 'baja' and objetivo->>'rol' = 'encargado_area' and creado_en is not null) then raise exception 'caso 6o: falta la baja en la bitácora'; end if;

  -- ── (7) motivos (solo admin) ──
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_set_motivo(%L, %L, false, 8, true)', 'motivo_prueba', 'Motivo de prueba'));
  if v_msg is null or v_msg !~* 'administrador' then raise exception 'caso 7a: solo el admin cambia motivos, dio %', v_msg; end if;
  perform pg_temp.act(adm);
  v_msg := pg_temp.falla(format('select public.rec_set_motivo(%L, %L, false, 8, true)', 'Mal Id', 'Motivo'));
  if v_msg is null or v_msg !~* 'identificador|id' then raise exception 'caso 7b: id inválido debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_motivo(%L, %L, false, 8, true)', 'motivo_prueba', '   '));
  if v_msg is null or v_msg !~* 'nombre' then raise exception 'caso 7c: nombre vacío debía fallar, dio %', v_msg; end if;
  perform public.rec_set_motivo('motivo_prueba', 'Motivo de prueba', true, 8, true);
  if not exists (select 1 from public.rec_motivos where id = 'motivo_prueba' and nombre = 'Motivo de prueba' and requiere_producto and orden = 8 and activo) then raise exception 'caso 7d: el motivo debía crearse'; end if;
  perform public.rec_set_motivo('motivo_prueba', 'Motivo renombrado', false, 3, true);
  if not exists (select 1 from public.rec_motivos where id = 'motivo_prueba' and nombre = 'Motivo renombrado' and not requiere_producto and orden = 3) then raise exception 'caso 7e: el motivo debía actualizarse'; end if;
  perform pg_temp.act(v1);
  c := public.rec_crear(cli, null, 'motivo_prueba', 'Con el motivo nuevo', hoy);   -- un motivo nuevo ya sirve en el ingreso
  perform pg_temp.act(adm);
  perform public.rec_set_motivo('motivo_prueba', 'Motivo renombrado', false, 3, false);
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'motivo_prueba', 'Con el motivo desactivado', hoy));
  if v_msg is null or v_msg !~* 'motivo' then raise exception 'caso 7f: un motivo desactivado no sirve para ingresar, dio %', v_msg; end if;
  if (select count(*) from public.rec_motivos) <> 8 then raise exception 'caso 7g: debía haber 8 motivos (7 + el de prueba)'; end if;
  select count(*) into v_n from public.rec_accesos_log where tipo = 'motivo' and usuario = adm;
  if v_n <> 3 then raise exception 'caso 7h: la bitácora debía tener 3 cambios de motivo, tiene %', v_n; end if;

  -- ── (8) permisos de ejecución: nada para anon; authenticated sí; todas security definer ──
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_definir_solucion','rec_comunicar','rec_cerrar','rec_corregir_compensacion','rec_anular','rec_reabrir','rec_set_alcance','rec_set_motivo');
  if v_n <> 8 then raise exception 'caso 8a: se esperaban 8 funciones públicas, hay %', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_definir_solucion','rec_comunicar','rec_cerrar','rec_corregir_compensacion','rec_anular','rec_reabrir','rec_set_alcance','rec_set_motivo')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute') or not p.prosecdef);
  if v_n <> 0 then raise exception 'caso 8b: % funciones con permisos mal puestos', v_n; end if;
  -- la bitácora la lee solo el admin y nadie escribe desde el cliente
  perform pg_temp.act(adm);
  set local role authenticated;
  select count(*) into v_n from public.rec_accesos_log;
  reset role;
  if v_n <> 7 then raise exception 'caso 8c: el admin debía leer los 7 registros de la bitácora (4 de alcance y 3 de motivo), ve %', v_n; end if;
  perform pg_temp.act(sc);
  set local role authenticated;
  select count(*) into v_n from public.rec_accesos_log;
  v_ok := false;
  begin
    insert into public.rec_accesos_log (tipo, accion, usuario) values ('alcance', 'alta', sc);
  exception when insufficient_privilege then v_ok := true; end;
  reset role;
  if v_n <> 0 then raise exception 'caso 8d: quien no es admin no lee la bitácora, ve %', v_n; end if;
  if not v_ok then raise exception 'caso 8e: nadie escribe la bitácora desde el cliente'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
