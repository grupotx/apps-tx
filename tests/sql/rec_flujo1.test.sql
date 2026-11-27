-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 4: ingreso, derivación, verificación y decisión (funciones rec_* security definer).
-- La identidad se simula con request.jwt.claims sobre perfiles reales (solo como identidad). Las funciones validan
-- con auth.uid(), así que el rol de base de datos da igual salvo en el caso 12 (permisos de ejecución).
create or replace function pg_temp.act(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end $$;

-- Ejecuta una sentencia y devuelve el mensaje de error, o null si no falló.
create or replace function pg_temp.falla(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end $$;

-- Eventos de un reclamo como "tipo:de>a" separados por coma, en orden.
create or replace function pg_temp.hist(p_id uuid) returns text language sql as $$
  select coalesce(string_agg(tipo || ':' || coalesce(de_estado, '-') || '>' || coalesce(a_estado, '-'), ',' order by id), '')
    from public.rec_eventos where reclamo_id = p_id
$$;

do $$
declare
  uids uuid[];
  sc uuid; v1 uuid; as1 uuid; as2 uuid; enc_m uuid; enc_a uuid; sin_acceso uuid; adm uuid;
  cli uuid; p_m text; p_a text;
  hoy date := (now() at time zone 'America/Santiago')::date;
  a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; g uuid; h uuid;
  v_msg text; v_n int; v_n2 int; r public.rec_reclamos;
  v_ruta text;
begin
  -- ── actores ──
  select array_agg(id order by id) into uids from (select id from public.profiles where activo and rol::text <> 'admin' order by id limit 8) t;
  if cardinality(uids) < 8 then raise exception 'faltan perfiles activos no admin para la prueba'; end if;
  sc := uids[1]; v1 := uids[2]; as1 := uids[3]; as2 := uids[4]; enc_m := uids[5]; enc_a := uids[6]; sin_acceso := uids[7];
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  insert into public.rec_usuarios (id, activo) values (sc, true), (v1, true), (as1, true), (as2, true), (enc_m, true), (enc_a, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values
    (sc, 'servicio_cliente', null, null),
    (as1, 'asesor_tecnico', null, null),
    (as2, 'asesor_tecnico', null, null),
    (enc_m, 'encargado_area', 'produccion', 'morteros'),
    (enc_a, 'encargado_area', 'produccion', 'adhesivos');
  select id into cli from public.crm_clients order by id limit 1;
  select code into p_m from public.crm_products where planta = 'morteros' order by code limit 1;
  select code into p_a from public.crm_products where planta = 'adhesivos' order by code limit 1;

  -- ── (1) rec_crear: validaciones ──
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'calidad_producto', 'sin producto', hoy));
  if v_msg is null or v_msg !~* 'producto' then raise exception 'caso 1a: calidad_producto sin producto debía fallar con mensaje de producto, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'atraso_despacho', 'mañana', hoy + 1));
  if v_msg is null or v_msg !~* 'futura' then raise exception 'caso 1b: fecha de mañana debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'atraso_despacho', '   ', hoy));
  if v_msg is null or v_msg !~* 'descripci' then raise exception 'caso 1c: descripción en blanco debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'no_existe', 'x', hoy));
  if v_msg is null or v_msg !~* 'motivo' then raise exception 'caso 1d: motivo inexistente debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', gen_random_uuid(), 'atraso_despacho', 'x', hoy));
  if v_msg is null or v_msg !~* 'cliente' then raise exception 'caso 1e: cliente inexistente debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, %L, %L, %L, %L)', cli, 'NO-EXISTE-XYZ', 'calidad_producto', 'x', hoy));
  if v_msg is null or v_msg !~* 'producto' then raise exception 'caso 1h: producto inexistente debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, %L, %L, %L, %L, %L)', cli, p_m, 'calidad_producto', 'x', hoy, '[1,2]'));
  if v_msg is null or v_msg !~* 'datos' then raise exception 'caso 1f: datos que no son un objeto debían fallar, dio %', v_msg; end if;
  perform pg_temp.act(sin_acceso);
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'atraso_despacho', 'x', hoy));
  if v_msg is null or v_msg !~* 'acceso' then raise exception 'caso 1g: sin acceso al módulo no ingresa, dio %', v_msg; end if;

  -- ── (2) rec_crear: camino válido (con producto → planta; sin producto → planta nula) ──
  perform pg_temp.act(v1);
  a := public.rec_crear(cli, p_m, 'calidad_producto', 'El producto llegó con grumos', hoy, '{"obra":"Edificio Centro"}'::jsonb);
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'ingresado' or r.planta <> 'morteros' or r.creado_por <> v1 or r.folio !~ '^REC-[0-9]{4}-[0-9]{4}$' or r.datos->>'obra' <> 'Edificio Centro'
     then raise exception 'caso 2a: reclamo creado con datos inesperados: %', to_jsonb(r); end if;
  if pg_temp.hist(a) <> 'creado:->ingresado' then raise exception 'caso 2b: historia inicial inesperada: %', pg_temp.hist(a); end if;
  b := public.rec_crear(cli, null, 'atraso_despacho', 'El camión llegó tarde', hoy);
  select * into r from public.rec_reclamos where id = b;
  if r.planta is not null or r.producto is not null then raise exception 'caso 2c: sin producto la planta debía quedar nula'; end if;
  if (select folio from public.rec_reclamos where id = a) = (select folio from public.rec_reclamos where id = b) then raise exception 'caso 2d: folio repetido'; end if;

  -- ── (3) quién puede derivar: el vendedor no; servicio al cliente sí ──
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', a, 'calidad'));
  if v_msg is null or v_msg !~* 'servicio al cliente' then raise exception 'caso 3a: el vendedor no puede derivar, dio %', v_msg; end if;

  -- ── (4) camino feliz de calidad con visita: ingresado → derivado → en_verificacion → aprobado ──
  perform pg_temp.act(sc);
  perform public.rec_derivar(a, 'calidad');   -- planta por defecto: la del reclamo
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'derivado' or r.area_destino <> 'calidad' or r.planta_destino <> 'morteros' then raise exception 'caso 4a: derivación inesperada: %', to_jsonb(r); end if;
  v_msg := pg_temp.falla(format('select public.rec_pedir_verificacion(%L, %L)', a, enc_m));   -- no es asesor técnico
  if v_msg is null or v_msg !~* 'asesor' then raise exception 'caso 4b: pedir visita a quien no es asesor debía fallar, dio %', v_msg; end if;
  perform public.rec_pedir_verificacion(a, as1);
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'en_verificacion' or r.asesor_id <> as1 then raise exception 'caso 4c: verificación inesperada: %', to_jsonb(r); end if;
  -- informe: solo el asesor asignado
  perform pg_temp.act(as2);
  v_msg := pg_temp.falla(format('select public.rec_registrar_informe(%L, %L)', a, 'informe de otro asesor'));
  if v_msg is null then raise exception 'caso 4d: otro asesor no puede registrar el informe'; end if;
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', a, 'aprobado', 'no me corresponde'));
  if v_msg is null then raise exception 'caso 4e: un asesor ajeno al reclamo no puede decidir'; end if;
  perform pg_temp.act(as1);
  v_msg := pg_temp.falla(format('select public.rec_registrar_informe(%L, %L)', a, '   '));
  if v_msg is null or v_msg !~* 'informe' then raise exception 'caso 4f: informe en blanco debía fallar, dio %', v_msg; end if;
  perform public.rec_registrar_informe(a, 'Se verificó el lote: humedad alta en el almacenaje.');
  if (select informe from public.rec_reclamos where id = a) <> 'Se verificó el lote: humedad alta en el almacenaje.' then raise exception 'caso 4g: informe no guardado'; end if;
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', a, 'aprobado', '  '));
  if v_msg is null or v_msg !~* 'razones' then raise exception 'caso 4h: decidir sin razones debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', a, 'quizas', 'x'));
  if v_msg is null then raise exception 'caso 4i: decisión inválida debía fallar'; end if;
  perform public.rec_decidir(a, 'aprobado', 'El material salió defectuoso de fábrica.');
  select * into r from public.rec_reclamos where id = a;
  if r.estado <> 'aprobado' or r.decision <> 'aprobado' or r.decidido_por <> as1 or r.decidido_en is null or r.razones is null then raise exception 'caso 4j: decisión inesperada: %', to_jsonb(r); end if;
  if pg_temp.hist(a) <> 'creado:->ingresado,derivado:ingresado>derivado,verificacion_pedida:derivado>en_verificacion,informe:en_verificacion>en_verificacion,decidido:en_verificacion>aprobado'
     then raise exception 'caso 4k: historia del camino feliz inesperada: %', pg_temp.hist(a); end if;

  -- ── (5) carrera: tras decidir, un re-derivar con el estado ya cambiado falla y no agrega evento ──
  perform pg_temp.act(sc);
  select count(*) into v_n from public.rec_eventos where reclamo_id = a;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', a, 'logistica'));
  if v_msg is null or v_msg !~* 'ya cambió de estado' or v_msg !~* 'aprobado' then raise exception 'caso 5a: debía fallar con el estado real, dio %', v_msg; end if;
  select count(*) into v_n2 from public.rec_eventos where reclamo_id = a;
  if v_n2 <> v_n then raise exception 'caso 5b: el intento fallido agregó un evento (% → %)', v_n, v_n2; end if;
  if (select area_destino from public.rec_reclamos where id = a) <> 'calidad' then raise exception 'caso 5c: el intento fallido cambió el área'; end if;

  -- ── (6) calidad sin visita: la decide el asesor (cualquiera si no hay asesor asignado) ──
  perform pg_temp.act(v1);
  c := public.rec_crear(cli, p_m, 'calidad_producto', 'Color distinto al muestrario', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(c, 'calidad', null, 'Revisar con el lote');
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', c, 'rechazado', 'x'));   -- servicio al cliente no decide
  if v_msg is null then raise exception 'caso 6a: servicio al cliente no puede decidir'; end if;
  perform pg_temp.act(enc_m);
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', c, 'rechazado', 'x'));   -- ni un encargado de producción decide calidad
  if v_msg is null then raise exception 'caso 6b: un encargado de producción no decide calidad'; end if;
  perform pg_temp.act(as2);
  perform public.rec_decidir(c, 'rechazado', 'El color está dentro de la tolerancia del muestrario.');
  if (select estado from public.rec_reclamos where id = c) <> 'rechazado' then raise exception 'caso 6c: debía quedar rechazado'; end if;
  if pg_temp.hist(c) <> 'creado:->ingresado,derivado:ingresado>derivado,decidido:derivado>rechazado' then raise exception 'caso 6d: historia inesperada: %', pg_temp.hist(c); end if;

  -- ── (7) producción: decide el encargado de la planta del reclamo, no el de otra planta ──
  perform pg_temp.act(v1);
  d := public.rec_crear(cli, p_m, 'calidad_producto', 'Falla de envasado', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(d, 'produccion');   -- planta del reclamo: morteros
  if (select planta_destino from public.rec_reclamos where id = d) <> 'morteros' then raise exception 'caso 7a: planta destino debía ser morteros'; end if;
  perform pg_temp.act(enc_a);
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', d, 'aprobado', 'x'));
  if v_msg is null then raise exception 'caso 7b: el encargado de Adhesivos no puede decidir uno de Morteros'; end if;
  perform pg_temp.act(enc_m);
  perform public.rec_decidir(d, 'aprobado', 'Falla confirmada en línea de envasado.');
  if (select estado from public.rec_reclamos where id = d) <> 'aprobado' then raise exception 'caso 7c: debía quedar aprobado'; end if;

  -- ── (8) planta: derivar a calidad/producción sin planta resuelta falla con mensaje claro; con planta explícita pasa ──
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', b, 'calidad'));   -- b no tiene producto → sin planta
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 8a: derivar a calidad sin planta debía fallar con mensaje de planta, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', b, 'produccion'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 8b: derivar a producción sin planta debía fallar, dio %', v_msg; end if;
  if (select estado from public.rec_reclamos where id = b) <> 'ingresado' then raise exception 'caso 8c: el intento fallido movió el reclamo'; end if;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L, %L)', b, 'produccion', 'lunar'));
  if v_msg is null or v_msg !~* 'planta' then raise exception 'caso 8d: planta inválida debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', b, 'marketing'));
  if v_msg is null or v_msg !~* 'área' then raise exception 'caso 8e: área inválida debía fallar, dio %', v_msg; end if;
  perform public.rec_derivar(b, 'logistica');   -- logística no lleva planta
  select * into r from public.rec_reclamos where id = b;
  if r.estado <> 'derivado' or r.area_destino <> 'logistica' or r.planta_destino is not null then raise exception 'caso 8f: derivación a logística inesperada: %', to_jsonb(r); end if;
  perform public.rec_derivar(b, 'produccion', 'adhesivos');   -- re-derivar con planta explícita (corregida a mano)
  select * into r from public.rec_reclamos where id = b;
  if r.area_destino <> 'produccion' or r.planta_destino <> 'adhesivos' then raise exception 'caso 8g: re-derivación inesperada: %', to_jsonb(r); end if;
  if pg_temp.hist(b) <> 'creado:->ingresado,derivado:ingresado>derivado,derivado:derivado>derivado' then raise exception 'caso 8h: historia de re-derivación inesperada: %', pg_temp.hist(b); end if;

  -- ── (9) devolver: el encargado responde "no es mío" → vuelve a ingresado y limpia el destino ──
  perform pg_temp.act(enc_m);
  v_msg := pg_temp.falla(format('select public.rec_devolver(%L, %L)', b, 'no es de Morteros'));   -- b está en producción de Adhesivos
  if v_msg is null then raise exception 'caso 9a: el encargado de otra planta no puede devolver'; end if;
  perform pg_temp.act(enc_a);
  v_msg := pg_temp.falla(format('select public.rec_devolver(%L, %L)', b, '  '));
  if v_msg is null or v_msg !~* 'explica|motivo|nota' then raise exception 'caso 9b: devolver sin nota debía fallar, dio %', v_msg; end if;
  perform public.rec_devolver(b, 'Es un tema de despacho, no de producción.');
  select * into r from public.rec_reclamos where id = b;
  if r.estado <> 'ingresado' or r.area_destino is not null or r.planta_destino is not null or r.asesor_id is not null then raise exception 'caso 9c: devolución inesperada: %', to_jsonb(r); end if;
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_devolver(%L, %L)', b, 'x'));   -- ya está en ingresado y servicio al cliente no devuelve
  if v_msg is null then raise exception 'caso 9d: servicio al cliente no puede devolver'; end if;

  -- ── (10) verificación: solo calidad y solo desde derivado; reasignar asesor ──
  perform pg_temp.act(v1);
  e := public.rec_crear(cli, p_a, 'dano_transporte', 'Pallet golpeado', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(e, 'logistica');
  v_msg := pg_temp.falla(format('select public.rec_pedir_verificacion(%L, %L)', e, as1));
  if v_msg is null or v_msg !~* 'calidad' then raise exception 'caso 10a: pedir visita fuera de calidad debía fallar, dio %', v_msg; end if;
  perform pg_temp.act(v1);
  f := public.rec_crear(cli, p_a, 'calidad_producto', 'Adhesivo no pega', hoy);
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_pedir_verificacion(%L, %L)', f, as1));
  if v_msg is null then raise exception 'caso 10b: el vendedor no puede pedir visita'; end if;
  perform pg_temp.act(sc);
  perform public.rec_derivar(f, 'calidad');
  perform public.rec_pedir_verificacion(f, as1);
  v_msg := pg_temp.falla(format('select public.rec_pedir_verificacion(%L, %L)', f, as2));   -- ya está en verificación
  if v_msg is null or v_msg !~* 'ya cambió de estado' then raise exception 'caso 10c: pedir visita dos veces debía fallar por estado, dio %', v_msg; end if;
  perform pg_temp.act(as2);
  v_msg := pg_temp.falla(format('select public.rec_reasignar_asesor(%L, %L)', f, as2));   -- as2 no es el asesor actual
  if v_msg is null then raise exception 'caso 10d: un asesor ajeno no puede reasignar'; end if;
  perform pg_temp.act(as1);
  v_msg := pg_temp.falla(format('select public.rec_reasignar_asesor(%L, %L)', f, enc_m));   -- el nuevo no es asesor técnico
  if v_msg is null or v_msg !~* 'asesor' then raise exception 'caso 10e: reasignar a quien no es asesor debía fallar, dio %', v_msg; end if;
  perform public.rec_reasignar_asesor(f, as2);
  if (select asesor_id from public.rec_reclamos where id = f) <> as2 then raise exception 'caso 10f: asesor no reasignado'; end if;
  if pg_temp.hist(f) <> 'creado:->ingresado,derivado:ingresado>derivado,verificacion_pedida:derivado>en_verificacion,asesor_reasignado:en_verificacion>en_verificacion'
     then raise exception 'caso 10g: historia inesperada: %', pg_temp.hist(f); end if;
  -- re-derivar desde en_verificacion suelta al asesor
  perform pg_temp.act(sc);
  perform public.rec_derivar(f, 'comercial');
  select * into r from public.rec_reclamos where id = f;
  if r.estado <> 'derivado' or r.asesor_id is not null or r.area_destino <> 'comercial' then raise exception 'caso 10h: re-derivación desde verificación inesperada: %', to_jsonb(r); end if;

  -- ── (11) adjuntos: solo a un reclamo visible, ruta dentro de su carpeta y archivo ya subido ──
  v_ruta := a::text || '/foto1.jpg';
  insert into storage.objects (bucket_id, name) values ('reclamos', v_ruta), ('reclamos', c::text || '/otra.jpg');
  perform pg_temp.act(v1);
  g := public.rec_adjuntar(a, 'foto', v_ruta);
  if not exists (select 1 from public.rec_adjuntos where id = g and reclamo_id = a and tipo = 'foto' and ruta = v_ruta and subido_por = v1) then raise exception 'caso 11a: adjunto no registrado'; end if;
  if pg_temp.hist(a) not like '%,adjunto:aprobado>aprobado' then raise exception 'caso 11b: el adjunto debía dejar evento: %', pg_temp.hist(a); end if;
  v_msg := pg_temp.falla(format('select public.rec_adjuntar(%L, %L, %L)', a, 'foto', c::text || '/otra.jpg'));   -- ruta de otra carpeta
  if v_msg is null or v_msg !~* 'ruta|carpeta' then raise exception 'caso 11c: ruta fuera de la carpeta debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_adjuntar(%L, %L, %L)', a, 'foto', a::text || '/no-subido.jpg'));
  if v_msg is null or v_msg !~* 'archivo' then raise exception 'caso 11d: archivo no subido debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_adjuntar(%L, %L, %L)', a, 'video', v_ruta));
  if v_msg is null then raise exception 'caso 11e: tipo inválido debía fallar'; end if;
  perform pg_temp.act(sc);
  h := public.rec_crear(cli, null, 'atraso_despacho', 'Reclamo ingresado por servicio al cliente', hoy);   -- v1 no lo ve
  insert into storage.objects (bucket_id, name) values ('reclamos', h::text || '/x.jpg');
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_adjuntar(%L, %L, %L)', h, 'foto', h::text || '/x.jpg'));
  if v_msg is null then raise exception 'caso 11f: no se adjunta a un reclamo que no se puede ver'; end if;

  -- ── (12) permisos de ejecución: nada para anon; las funciones públicas sí para authenticated; las internas no ──
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_crear','rec_derivar','rec_devolver','rec_pedir_verificacion','rec_reasignar_asesor','rec_registrar_informe','rec_decidir','rec_adjuntar','rec_asesores');
  if v_n <> 9 then raise exception 'caso 12a: se esperaban 9 funciones públicas del flujo, hay %', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_crear','rec_derivar','rec_devolver','rec_pedir_verificacion','rec_reasignar_asesor','rec_registrar_informe','rec_decidir','rec_adjuntar','rec_asesores')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute') or not p.prosecdef);
  if v_n <> 0 then raise exception 'caso 12b: % funciones con permisos mal puestos (anon no, authenticated sí, security definer)', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('rec_bloquear', 'rec_mover') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
  if v_n <> 0 then raise exception 'caso 12c: las funciones internas del flujo no deben ser ejecutables por el cliente'; end if;
  -- humo con el rol real: un usuario autenticado ingresa un reclamo
  perform pg_temp.act(v1);
  set local role authenticated;
  perform public.rec_crear(cli, null, 'atraso_despacho', 'Prueba con rol authenticated', hoy);
  reset role;

  -- ── (13) lista de asesores para elegir (solo servicio al cliente / admin) ──
  perform pg_temp.act(sc);
  select count(*) into v_n from public.rec_asesores();
  if v_n <> 2 then raise exception 'caso 13a: servicio al cliente ve 2 asesores y ve %', v_n; end if;
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla('select * from public.rec_asesores()');
  if v_msg is null then raise exception 'caso 13b: el vendedor no ve la lista de asesores'; end if;

  -- ── (14) el administrador hace lo de servicio al cliente pero no decide sin alcance ──
  perform pg_temp.act(v1);
  g := public.rec_crear(cli, p_m, 'calidad_producto', 'Reclamo para admin', hoy);
  perform pg_temp.act(adm);
  perform public.rec_derivar(g, 'calidad');
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L)', g, 'aprobado', 'x'));
  if v_msg is null then raise exception 'caso 14a: el admin no decide sin alcance de asesor técnico'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
