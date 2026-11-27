-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, ajustes de la revisión independiente de la capa de datos:
--  · token de versión (p_version = actualizado_en) para que una acción sobre una pantalla vieja falle, incluso cuando
--    no cambia el estado (re-derivar, reasignar, informe) o cambió el destino;
--  · Calidad/Producción exigen producto; rec_actualizar completa producto y datos adicionales después del ingreso;
--  · rec_ve_todo (una sola evaluación por consulta en las políticas), planta que sigue a la familia del producto,
--    fecha de recepción de hasta un año atrás, adjuntos bloqueados en anulados, area_sugerida y alcance de calidad.
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
  sc uuid; sc2 uuid; v1 uuid; as1 uuid; as2 uuid; adm uuid;
  cli uuid; p_m text;
  hoy date := (now() at time zone 'America/Santiago')::date;
  a uuid; b uuid; c uuid; d uuid;
  tok timestamptz; tok2 timestamptz;
  v_msg text; v_n int; v_n2 int; r public.rec_reclamos; ev public.rec_eventos;
begin
  select array_agg(id order by id) into uids from (select id from public.profiles where activo and rol::text <> 'admin' order by id limit 6) t;
  if cardinality(uids) < 6 then raise exception 'faltan perfiles activos no admin para la prueba'; end if;
  sc := uids[1]; sc2 := uids[2]; v1 := uids[3]; as1 := uids[4]; as2 := uids[5];
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  insert into public.rec_usuarios (id, activo) values (sc, true), (sc2, true), (v1, true), (as1, true), (as2, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values
    (sc, 'servicio_cliente', null, null), (sc2, 'servicio_cliente', null, null),
    (as1, 'asesor_tecnico', null, null), (as2, 'asesor_tecnico', null, null);
  select id into cli from public.crm_clients order by id limit 1;
  select code into p_m from public.crm_products where planta = 'morteros' order by code limit 1;

  -- ── (1) token de versión: quien actúa con la pantalla vieja falla, aunque el estado no cambie ──
  perform pg_temp.act(v1);
  a := public.rec_crear(cli, null, 'atraso_despacho', 'El camión llegó tarde', hoy);
  select actualizado_en into tok from public.rec_reclamos where id = a;
  perform pg_temp.act(sc);
  perform public.rec_derivar(a, 'logistica', null, null, tok);
  perform pg_temp.act(sc2);
  select count(*) into v_n from public.rec_eventos where reclamo_id = a;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L, null, null, %L)', a, 'comercial', tok));
  if v_msg is null or v_msg !~* 'modificado' then raise exception 'caso 1a: derivar con el token viejo debía fallar con "modificado", dio %', v_msg; end if;
  select count(*) into v_n2 from public.rec_eventos where reclamo_id = a;
  if v_n2 <> v_n or (select area_destino from public.rec_reclamos where id = a) <> 'logistica' then raise exception 'caso 1b: el intento fallido escribió algo'; end if;
  select actualizado_en into tok2 from public.rec_reclamos where id = a;
  if tok2 is not distinct from tok then raise exception 'caso 1c: actualizado_en debía cambiar con la derivación'; end if;
  perform public.rec_derivar(a, 'comercial', null, null, tok2);
  perform public.rec_derivar(a, 'finanzas');
  if (select area_destino from public.rec_reclamos where id = a) <> 'finanzas' then raise exception 'caso 1d: sin token debía seguir funcionando'; end if;
  select actualizado_en into tok from public.rec_reclamos where id = a;
  perform pg_temp.act(v1);
  d := public.rec_crear(cli, null, 'otro', 'Reclamo para anular', hoy);
  perform pg_temp.act(sc);
  perform public.rec_anular(d, 'duplicado');
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L, null, null, %L)', d, 'comercial', tok));
  if v_msg is null or v_msg !~* 'ya cambió de estado' then raise exception 'caso 1e: un reclamo que cambió de estado falla con el estado real, dio %', v_msg; end if;

  perform pg_temp.act(v1);
  b := public.rec_crear(cli, p_m, 'calidad_producto', 'Falla de producto', hoy);
  perform pg_temp.act(sc);
  perform public.rec_derivar(b, 'calidad');
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_derivar(b, 'calidad', 'pinturas');
  perform pg_temp.act(as1);
  v_msg := pg_temp.falla(format('select public.rec_decidir(%L, %L, %L, %L)', b, 'aprobado', 'ok', tok));
  if v_msg is null or v_msg !~* 'modificado' then raise exception 'caso 1f: decidir con la pantalla vieja debía fallar, dio %', v_msg; end if;
  if (select estado from public.rec_reclamos where id = b) <> 'derivado' then raise exception 'caso 1g: el intento fallido movió el reclamo'; end if;
  perform pg_temp.act(sc);
  perform public.rec_pedir_verificacion(b, as1);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_reasignar_asesor(b, as2);
  perform pg_temp.act(as2);
  v_msg := pg_temp.falla(format('select public.rec_registrar_informe(%L, %L, null, %L)', b, 'informe con pantalla vieja', tok));
  if v_msg is null or v_msg !~* 'modificado' then raise exception 'caso 1h: informe con la pantalla vieja debía fallar, dio %', v_msg; end if;
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_registrar_informe(b, 'Informe con la pantalla al día', null, tok);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_decidir(b, 'rechazado', 'Dentro de tolerancia', tok);
  if (select estado from public.rec_reclamos where id = b) <> 'rechazado' then raise exception 'caso 1i: la decisión con el token vigente debía pasar'; end if;
  perform pg_temp.act(sc);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_definir_solucion(b, 'explicacion', 'x', 0, tok);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_comunicar(b, 'Mensaje', 'correo', tok);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  perform public.rec_cerrar(b, tok);
  perform pg_temp.act(adm);
  select actualizado_en into tok from public.rec_reclamos where id = b;
  v_msg := pg_temp.falla(format('select public.rec_reabrir(%L, %L, %L)', b, 'revisar', (tok - interval '1 minute')::text));
  if v_msg is null or v_msg !~* 'modificado' then raise exception 'caso 1j: reabrir con el token viejo debía fallar, dio %', v_msg; end if;
  perform public.rec_reabrir(b, 'Se revisa de nuevo', tok);
  if (select estado from public.rec_reclamos where id = b) <> 'ingresado' then raise exception 'caso 1k: reabrir con token vigente'; end if;

  -- ── (2) Calidad/Producción exigen producto ──
  perform pg_temp.act(v1);
  c := public.rec_crear(cli, null, 'otro', 'Sin producto', hoy);
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L)', c, 'calidad'));
  if v_msg is null or v_msg !~* 'producto' then raise exception 'caso 2a: derivar a calidad sin producto debía fallar con mensaje de producto, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_derivar(%L, %L, %L)', c, 'produccion', 'adhesivos'));
  if v_msg is null or v_msg !~* 'producto' then raise exception 'caso 2b: ni con planta explícita, dio %', v_msg; end if;
  perform public.rec_derivar(c, 'logistica');

  -- ── (3) rec_actualizar: producto y datos adicionales después del ingreso ──
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, %L)', c, p_m));
  if v_msg is null or v_msg !~* 'servicio al cliente' then raise exception 'caso 3a: el vendedor no completa datos, dio %', v_msg; end if;
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L)', c));
  if v_msg is null or v_msg !~* 'nada' then raise exception 'caso 3b: sin cambios debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, %L)', c, 'NO-EXISTE-XYZ'));
  if v_msg is null or v_msg !~* 'producto' then raise exception 'caso 3c: producto inexistente debía fallar, dio %', v_msg; end if;
  select actualizado_en into tok from public.rec_reclamos where id = c;
  perform public.rec_actualizar(c, p_m, '{"obra":"Torre A","lote":"L-12"}'::jsonb, tok);
  select * into r from public.rec_reclamos where id = c;
  if r.producto <> p_m or r.planta <> 'morteros' or r.producto_nombre is null or r.datos->>'obra' <> 'Torre A' or r.datos->>'lote' <> 'L-12' then raise exception 'caso 3d: producto/datos inesperados: %', to_jsonb(r); end if;
  if pg_temp.hist(c) not like '%,datos_actualizados:derivado>derivado' then raise exception 'caso 3e: historia inesperada: %', pg_temp.hist(c); end if;
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, null, %L, %L)', c, '{"x":"1"}', tok));
  if v_msg is null or v_msg !~* 'modificado' then raise exception 'caso 3f: token viejo debía fallar, dio %', v_msg; end if;
  perform public.rec_actualizar(c, null, '{"lote":"","contacto":"Juan"}'::jsonb);
  select * into r from public.rec_reclamos where id = c;
  if r.datos ? 'lote' or r.datos->>'contacto' <> 'Juan' or r.datos->>'obra' <> 'Torre A' then raise exception 'caso 3g: el dato vacío se quita y los demás se conservan: %', r.datos; end if;
  select * into ev from public.rec_eventos where reclamo_id = c and tipo = 'datos_actualizados' order by id desc limit 1;
  if ev.detalle->'datos_anteriores'->>'lote' <> 'L-12' then raise exception 'caso 3h: el evento debía guardar los datos anteriores: %', to_jsonb(ev); end if;
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, null, %L)', c, '[1]'));
  if v_msg is null or v_msg !~* 'objeto' then raise exception 'caso 3i: datos que no son objeto, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, null, %L)', c, jsonb_build_object('x', repeat('a', 9000))::text));
  if v_msg is null or v_msg !~* 'largos' then raise exception 'caso 3j: datos demasiado largos, dio %', v_msg; end if;
  perform public.rec_derivar(c, 'calidad');   -- ahora sí: tiene producto
  perform public.rec_pedir_verificacion(c, as1);
  perform pg_temp.act(as2);
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, null, %L)', c, '{"cantidad":"10"}'));
  if v_msg is null then raise exception 'caso 3k: otro asesor no completa datos'; end if;
  perform pg_temp.act(as1);
  perform public.rec_actualizar(c, null, '{"cantidad":"20 sacos"}'::jsonb);
  if (select datos->>'cantidad' from public.rec_reclamos where id = c) <> '20 sacos' then raise exception 'caso 3l: el asesor asignado completa datos'; end if;
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, %L)', c, p_m));
  if v_msg is null or v_msg !~* 'servicio al cliente' then raise exception 'caso 3m: el asesor no cambia el producto, dio %', v_msg; end if;
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_actualizar(%L, null, %L)', d, '{"x":"1"}'));   -- d está anulado
  if v_msg is null or v_msg !~* 'cerrado o anulado' then raise exception 'caso 3n: un anulado no se modifica, dio %', v_msg; end if;

  -- ── (4) rec_ve_todo en las políticas de lectura ──
  select count(*) into v_n from pg_policies where schemaname = 'public' and tablename in ('rec_reclamos', 'rec_eventos', 'rec_adjuntos') and qual like '%rec_ve_todo%';
  if v_n <> 3 then raise exception 'caso 4a: las 3 políticas de lectura deben usar rec_ve_todo, usan %', v_n; end if;
  if has_function_privilege('anon', 'app.rec_ve_todo()', 'execute') or not has_function_privilege('authenticated', 'app.rec_ve_todo()', 'execute') then raise exception 'caso 4b: permisos de rec_ve_todo'; end if;

  -- ── (5) la planta sigue a la familia mientras no se haya corregido a mano ──
  insert into public.crm_products (code, name, unit, family, price, min_qty, active) values ('TEST-AJ-1', 'Prueba 1', 'un', 'Morteros', 0, 0, true);
  update public.crm_products set family = 'Cemento' where code = 'TEST-AJ-1';
  if (select planta from public.crm_products where code = 'TEST-AJ-1') <> 'cementos' then raise exception 'caso 5a: la planta debía seguir a la familia'; end if;
  insert into public.crm_products (code, name, unit, family, price, min_qty, active, planta) values ('TEST-AJ-2', 'Prueba 2', 'un', 'Morteros', 0, 0, true, 'adhesivos');
  update public.crm_products set family = 'Cemento' where code = 'TEST-AJ-2';
  if (select planta from public.crm_products where code = 'TEST-AJ-2') <> 'adhesivos' then raise exception 'caso 5b: una planta corregida a mano se respeta'; end if;
  update public.crm_products set planta = 'pinturas' where code = 'TEST-AJ-1';
  if (select planta from public.crm_products where code = 'TEST-AJ-1') <> 'pinturas' then raise exception 'caso 5c: cambiar la planta a mano debe valer'; end if;

  -- ── (6) alcances: para Calidad se usa el rol de calidad, no encargado de área ──
  perform pg_temp.act(adm);
  v_msg := pg_temp.falla(format('select public.rec_set_alcance(%L, %L, %L, %L, true)', as1, 'encargado_area', 'calidad', 'morteros'));
  if v_msg is null or v_msg !~* 'encargado de calidad' then raise exception 'caso 6a: encargado_area de calidad debía rechazarse con mensaje claro, dio %', v_msg; end if;
  perform public.rec_set_alcance(as1, 'encargado_calidad', null, 'morteros', true);
  if not exists (select 1 from public.rec_alcances where usuario_id = as1 and rol = 'encargado_calidad' and planta = 'morteros') then raise exception 'caso 6b: encargado_calidad válido'; end if;

  -- ── (7) motivos con área sugerida ──
  perform public.rec_set_motivo('motivo_aj', 'Motivo de ajuste', false, 9, true, 'logistica');
  if (select area_sugerida from public.rec_motivos where id = 'motivo_aj') is distinct from 'logistica' then raise exception 'caso 7a: area_sugerida debía guardarse'; end if;
  v_msg := pg_temp.falla(format('select public.rec_set_motivo(%L, %L, false, 9, true, %L)', 'motivo_aj', 'Motivo de ajuste', 'marketing'));
  if v_msg is null or v_msg !~* 'área' then raise exception 'caso 7b: área inválida debía fallar, dio %', v_msg; end if;
  perform public.rec_set_motivo('motivo_aj', 'Motivo de ajuste', false, 9, true);
  if (select area_sugerida from public.rec_motivos where id = 'motivo_aj') is not null then raise exception 'caso 7c: sin área sugerida queda vacío'; end if;

  -- ── (8) fecha de recepción: hasta un año atrás ──
  perform pg_temp.act(v1);
  v_msg := pg_temp.falla(format('select public.rec_crear(%L, null, %L, %L, %L)', cli, 'atraso_despacho', 'Fecha antigua', hoy - 400));
  if v_msg is null or v_msg !~* 'año' then raise exception 'caso 8a: una fecha de hace más de un año debía fallar, dio %', v_msg; end if;
  perform public.rec_crear(cli, null, 'atraso_despacho', 'Fecha de hace 300 días', hoy - 300);

  -- ── (9) un anulado no admite archivos nuevos ──
  insert into storage.objects (bucket_id, name) values ('reclamos', d::text || '/x.jpg');
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.rec_adjuntar(%L, %L, %L)', d, 'foto', d::text || '/x.jpg'));
  if v_msg is null or v_msg !~* 'anulado' then raise exception 'caso 9a: adjuntar a un anulado debía fallar, dio %', v_msg; end if;

  -- ── (10) una sola versión de cada función (las firmas viejas se eliminaron) y permisos ──
  select count(*) into v_n from (
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('rec_derivar','rec_devolver','rec_pedir_verificacion','rec_reasignar_asesor','rec_registrar_informe','rec_decidir',
       'rec_definir_solucion','rec_comunicar','rec_cerrar','rec_corregir_compensacion','rec_anular','rec_reabrir','rec_set_motivo','rec_actualizar')
     group by p.proname having count(*) <> 1) t;
  if v_n <> 0 then raise exception 'caso 10a: % funciones con más de una firma', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'rec_mover';
  if v_n <> 1 then raise exception 'caso 10b: app.rec_mover debía tener una sola firma, tiene %', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_derivar','rec_devolver','rec_pedir_verificacion','rec_reasignar_asesor','rec_registrar_informe','rec_decidir',
       'rec_definir_solucion','rec_comunicar','rec_cerrar','rec_corregir_compensacion','rec_anular','rec_reabrir','rec_set_motivo','rec_actualizar')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute') or not p.prosecdef);
  if v_n <> 0 then raise exception 'caso 10c: % funciones con permisos mal puestos', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('rec_mover', 'rec_bloquear') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
  if v_n <> 0 then raise exception 'caso 10d: las funciones internas no deben ser ejecutables por el cliente'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
