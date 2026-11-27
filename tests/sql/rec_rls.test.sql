-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 3: visibilidad por rol/área/planta (RLS) y bucket privado "reclamos".
-- La identidad se simula con request.jwt.claims sobre perfiles reales (solo como identidad); los alcances,
-- reclamos y archivos se crean dentro de la transacción y se deshacen con el rollback final.
-- Reclamos de prueba (descripcion = etiqueta): r01 de v1 | r02 cliente con vendedor v2 | r03 producción Morteros |
-- r04 producción Adhesivos | r05 logística creado por mix | r06 calidad Morteros sin asesor | r07 calidad Morteros asesor as1 |
-- r08 calidad Morteros asesor as2 | r09 calidad Pinturas asesor as2 | r10 calidad Cementos asesor as2.
do $$
declare
  u jsonb;            -- clave -> uuid del perfil que hace de cada actor
  adm uuid;
  uids uuid[];
  c1 uuid; c2 uuid;
  rid jsonb := '{}'::jsonb;   -- etiqueta -> id del reclamo
  v_exp jsonb;
  v_key text; v_val jsonb;
  v_got jsonb;
  v_n int;
  v_ok boolean;
  v_tot jsonb := '["r01","r02","r03","r04","r05","r06","r07","r08","r09","r10"]';
  v_otro uuid;
begin
  -- ── actores ──
  select array_agg(id order by id) into uids from (select id from public.profiles where activo and rol::text <> 'admin' order by id limit 14) t;
  if cardinality(uids) < 14 then raise exception 'faltan perfiles activos no admin para la prueba'; end if;
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  if adm is null then raise exception 'falta un administrador activo para la prueba'; end if;
  u := jsonb_build_object('otro', uids[1], 'sin', uids[2], 'v1', uids[3], 'v2', uids[4], 'enc_m', uids[5], 'enc_a', uids[6],
                          'mix', uids[7], 'as1', uids[8], 'as2', uids[9], 'ec_p', uids[10], 'ger', uids[11], 'sc', uids[12],
                          'inact', uids[13], 'enc_l', uids[14], 'adm', adm);
  v_otro := (u->>'otro')::uuid;

  -- acceso al módulo y alcances (todos menos 'sin' y el admin, que entra por su rol central)
  insert into public.rec_usuarios (id, activo) values
    ((u->>'v1')::uuid, true), ((u->>'v2')::uuid, true), ((u->>'enc_m')::uuid, true), ((u->>'enc_a')::uuid, true),
    ((u->>'mix')::uuid, true), ((u->>'as1')::uuid, true), ((u->>'as2')::uuid, true), ((u->>'ec_p')::uuid, true),
    ((u->>'ger')::uuid, true), ((u->>'sc')::uuid, true), ((u->>'inact')::uuid, false), ((u->>'enc_l')::uuid, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values
    ((u->>'enc_m')::uuid, 'encargado_area', 'produccion', 'morteros'),
    ((u->>'enc_a')::uuid, 'encargado_area', 'produccion', 'adhesivos'),
    ((u->>'mix')::uuid,   'encargado_area', 'produccion', 'morteros'),
    ((u->>'as1')::uuid,   'asesor_tecnico', null, null),
    ((u->>'as2')::uuid,   'asesor_tecnico', null, null),
    ((u->>'ec_p')::uuid,  'encargado_calidad', null, 'pinturas'),
    ((u->>'ger')::uuid,   'gerencia', null, null),
    ((u->>'sc')::uuid,    'servicio_cliente', null, null),
    ((u->>'inact')::uuid, 'servicio_cliente', null, null),   -- alcance guardado pero sin acceso al módulo
    ((u->>'enc_l')::uuid, 'encargado_area', 'logistica', null);

  -- ── reclamos ──
  select id into c1 from public.crm_clients order by id limit 1;
  select id into c2 from public.crm_clients order by id offset 1 limit 1;
  update public.crm_clients set sellers = '{}' where id = c1;
  update public.crm_clients set sellers = array[(u->>'v2')::uuid] where id = c2;   -- v2 es vendedor del cliente de r02

  insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por, estado, area_destino, planta_destino, asesor_id) values
    (c1, 'otro', 'r01', current_date, (u->>'v1')::uuid, 'ingresado', null, null, null),
    (c2, 'otro', 'r02', current_date, v_otro, 'ingresado', null, null, null),
    (c1, 'otro', 'r03', current_date, v_otro, 'derivado', 'produccion', 'morteros', null),
    (c1, 'otro', 'r04', current_date, v_otro, 'derivado', 'produccion', 'adhesivos', null),
    (c1, 'otro', 'r05', current_date, (u->>'mix')::uuid, 'derivado', 'logistica', null, null),
    (c1, 'otro', 'r06', current_date, v_otro, 'derivado', 'calidad', 'morteros', null),
    (c1, 'otro', 'r07', current_date, v_otro, 'en_verificacion', 'calidad', 'morteros', (u->>'as1')::uuid),
    (c1, 'otro', 'r08', current_date, v_otro, 'en_verificacion', 'calidad', 'morteros', (u->>'as2')::uuid),
    (c1, 'otro', 'r09', current_date, v_otro, 'en_verificacion', 'calidad', 'pinturas', (u->>'as2')::uuid),
    (c1, 'otro', 'r10', current_date, v_otro, 'en_verificacion', 'calidad', 'cementos', (u->>'as2')::uuid);
  select jsonb_object_agg(descripcion, id) into rid from public.rec_reclamos where descripcion like 'r__';

  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario) values
    ((rid->>'r03')::uuid, 'derivado', 'ingresado', 'derivado', v_otro),
    ((rid->>'r04')::uuid, 'derivado', 'ingresado', 'derivado', v_otro);
  insert into public.rec_adjuntos (reclamo_id, tipo, ruta, subido_por) values
    ((rid->>'r03')::uuid, 'foto', (rid->>'r03') || '/a.jpg', v_otro),
    ((rid->>'r04')::uuid, 'foto', (rid->>'r04') || '/b.jpg', v_otro);
  insert into storage.objects (bucket_id, name) values
    ('reclamos', (rid->>'r01') || '/a.jpg'),
    ('reclamos', (rid->>'r04') || '/b.jpg'),
    ('reclamos', 'basura/c.png');

  -- ── (1) quién ve qué en rec_reclamos ──
  v_exp := jsonb_build_object(
    'sin', '[]'::jsonb,                       -- sin acceso al módulo no ve ninguno
    'inact', '[]'::jsonb,                     -- acceso desactivado: su alcance de servicio al cliente no cuenta
    'v1', '["r01"]'::jsonb,                   -- vendedor: el que creó
    'v2', '["r02"]'::jsonb,                   -- vendedor: el de su cliente, no el ajeno
    'enc_m', '["r03"]'::jsonb,                -- producción Morteros: el de Morteros, no el de Adhesivos
    'enc_a', '["r04"]'::jsonb,                -- producción Adhesivos: no ve el de Morteros
    'enc_l', '["r05"]'::jsonb,                -- logística (sin planta): los de su área
    'mix', '["r03","r05"]'::jsonb,            -- vendedor implícito (r05, lo creó) + encargado Morteros (r03): la unión
    'as1', '["r06","r07"]'::jsonb,            -- calidad sin asesor + el asignado a él, no el de otro asesor
    'as2', '["r06","r08","r09","r10"]'::jsonb,
    'ec_p', '["r09"]'::jsonb,                 -- calidad de Pinturas, no la de Cementos ni la de Morteros
    'ger', v_tot, 'sc', v_tot, 'adm', v_tot  -- gerencia, servicio al cliente y admin ven todo
  );
  for v_key, v_val in select key, value from jsonb_each(v_exp) loop
    perform set_config('request.jwt.claims', json_build_object('sub', u->>v_key, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select coalesce(jsonb_agg(descripcion order by descripcion), '[]'::jsonb) into v_got from public.rec_reclamos;
    reset role;
    if v_got is distinct from v_val then raise exception 'caso 1 (%): esperado % y se vio %', v_key, v_val, v_got; end if;
  end loop;

  -- ── (2) la historia y los adjuntos siguen al reclamo ──
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'enc_m', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.rec_eventos; if v_n <> 1 then raise exception 'caso 2a: enc_m debía ver 1 evento y ve %', v_n; end if;
  select count(*) into v_n from public.rec_eventos where reclamo_id = (rid->>'r03')::uuid; if v_n <> 1 then raise exception 'caso 2b: el evento visible debía ser el de r03'; end if;
  select count(*) into v_n from public.rec_adjuntos; if v_n <> 1 then raise exception 'caso 2c: enc_m debía ver 1 adjunto y ve %', v_n; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'sin', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.rec_eventos; if v_n <> 0 then raise exception 'caso 2d: sin acceso no ve eventos'; end if;
  select count(*) into v_n from public.rec_adjuntos; if v_n <> 0 then raise exception 'caso 2e: sin acceso no ve adjuntos'; end if;
  reset role;

  -- ── (3) catálogos y accesos ──
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'v1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.rec_motivos; if v_n <> 7 then raise exception 'caso 3a: quien tiene acceso al módulo lee los 7 motivos, ve %', v_n; end if;
  select count(*) into v_n from public.rec_usuarios; if v_n <> 1 then raise exception 'caso 3b: cada persona lee solo su fila de rec_usuarios, ve %', v_n; end if;
  select count(*) into v_n from public.rec_alcances; if v_n <> 0 then raise exception 'caso 3c: v1 no tiene alcances guardados, ve %', v_n; end if;
  if public.rec_tengo_acceso() is not true then raise exception 'caso 3d: v1 tiene acceso al módulo'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'enc_m', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.rec_alcances; if v_n <> 1 then raise exception 'caso 3e: enc_m lee solo su propio alcance, ve %', v_n; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'sin', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.rec_motivos; if v_n <> 0 then raise exception 'caso 3f: sin acceso no lee motivos, ve %', v_n; end if;
  select count(*) into v_n from public.rec_usuarios; if v_n <> 0 then raise exception 'caso 3g: sin acceso no ve rec_usuarios'; end if;
  if public.rec_tengo_acceso() is not false then raise exception 'caso 3h: sin acceso no tiene acceso'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'inact', 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.rec_tengo_acceso() is not false then raise exception 'caso 3i: acceso desactivado no tiene acceso'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'adm', 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.rec_tengo_acceso() is not true then raise exception 'caso 3j: el admin central tiene acceso'; end if;
  select count(*) into v_n from public.rec_usuarios; if v_n <> 12 then raise exception 'caso 3k: el admin lee todos los rec_usuarios (12), ve %', v_n; end if;
  select count(*) into v_n from public.rec_alcances; if v_n <> 10 then raise exception 'caso 3l: el admin lee todos los alcances (10), ve %', v_n; end if;
  reset role;

  -- ── (4) el cliente nunca escribe en rec_* (ni siquiera servicio al cliente o el admin) ──
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'sc', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por) values (c1, 'otro', 'directo', current_date, (u->>'sc')::uuid);
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 4a: un insert directo en rec_reclamos debía fallar'; end if;
  v_ok := false;
  begin
    update public.rec_reclamos set descripcion = 'tocado';
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 4b: un update directo en rec_reclamos debía fallar'; end if;
  v_ok := false;
  begin
    insert into public.rec_eventos (reclamo_id, tipo, usuario) values ((rid->>'r03')::uuid, 'x', (u->>'sc')::uuid);
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 4c: un insert directo en rec_eventos debía fallar'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', u->>'adm', 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    delete from public.rec_reclamos;
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 4d: un delete directo en rec_reclamos debía fallar incluso al admin'; end if;
  v_ok := false;
  begin
    insert into public.rec_alcances (usuario_id, rol) values ((u->>'sin')::uuid, 'gerencia');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 4e: un insert directo en rec_alcances debía fallar incluso al admin'; end if;
  reset role;
  select count(*) into v_n from public.rec_reclamos where descripcion in ('directo', 'tocado'); if v_n <> 0 then raise exception 'caso 4f: quedaron escrituras directas'; end if;

  -- ── (5) bucket privado: lectura y subida solo en la carpeta de un reclamo visible ──
  select count(*) into v_n from storage.buckets where id = 'reclamos' and public = false and file_size_limit = 10485760
    and allowed_mime_types @> array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if v_n <> 1 then raise exception 'caso 5a: falta el bucket privado reclamos (10 MB, PDF e imágenes)'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u->>'v1', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from storage.objects where bucket_id = 'reclamos';
  if v_n <> 1 then raise exception 'caso 5b: v1 debía ver 1 archivo (el de r01) y ve %', v_n; end if;
  insert into storage.objects (bucket_id, name) values ('reclamos', (rid->>'r01') || '/nueva.jpg');   -- su propio reclamo: permitido
  v_ok := false;
  begin
    insert into storage.objects (bucket_id, name) values ('reclamos', (rid->>'r04') || '/intruso.jpg');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 5c: subir a la carpeta de un reclamo ajeno debía ser rechazado'; end if;
  v_ok := false;
  begin
    insert into storage.objects (bucket_id, name) values ('reclamos', 'basura/x.png');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 5d: subir fuera de una carpeta de reclamo debía ser rechazado'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', u->>'sin', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from storage.objects where bucket_id = 'reclamos';
  if v_n <> 0 then raise exception 'caso 5e: sin acceso al módulo no ve archivos, ve %', v_n; end if;
  v_ok := false;
  begin
    insert into storage.objects (bucket_id, name) values ('reclamos', (rid->>'r01') || '/z.jpg');
  exception when insufficient_privilege then v_ok := true; end;
  if not v_ok then raise exception 'caso 5f: sin acceso al módulo no sube archivos'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', u->>'sc', 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from storage.objects where bucket_id = 'reclamos';
  if v_n <> 3 then raise exception 'caso 5g: servicio al cliente ve los 3 archivos de carpetas de reclamo (no la carpeta basura), ve %', v_n; end if;
  reset role;

  raise exception 'OK_ROLLBACK';
end $$;
