-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos: varios productos por reclamo (lista `productos`, hasta 10) y quién reclama (vendedor del perfil o cliente):
--  · rec_crear / rec_actualizar con la lista y el reclamante, mismos mensajes que reclamos-core.js;
--  · rec_vendedores (lista para elegir), admin_set_telefono y admin_usuarios con teléfono;
--  · la derivación elige una planta cualquiera; permisos de ejecución y RLS sin cambios.
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

-- Mensaje de error de rec_crear con descripción y fecha válidas (null si no falla).
create or replace function pg_temp.fc(p_cli uuid, p_prods text[], p_motivo text, p_rec jsonb) returns text language plpgsql as $$
begin
  perform public.rec_crear(p_cli, p_prods, p_motivo, 'Prueba', (now() at time zone 'America/Santiago')::date, '{}'::jsonb, p_rec);
  return null;
exception when others then
  return sqlerrm;
end $$;

-- Mensaje de error de rec_actualizar (null si no falla).
create or replace function pg_temp.fa(p_id uuid, p_prods text[], p_datos jsonb, p_version timestamptz, p_rec jsonb) returns text language plpgsql as $$
begin
  perform public.rec_actualizar(p_id, p_prods, p_datos, p_version, p_rec);
  return null;
exception when others then
  return sqlerrm;
end $$;

create or replace function pg_temp.espera(p_caso text, p_obtenido text, p_esperado text) returns void language plpgsql as $$
begin
  if p_obtenido is distinct from p_esperado then
    raise exception 'caso %: se esperaba «%», dio «%»', p_caso, p_esperado, p_obtenido;
  end if;
end $$;

do $$
declare
  uids uuid[]; vids uuid[];
  sc uuid; as1 uuid; sin uuid; adm uuid; vend uuid; vend_inact uuid; vend_sn uuid;
  cli uuid; p_a text; p_p text; p_m text; once text[];
  hoy date := (now() at time zone 'America/Santiago')::date;
  rc jsonb := '{"tipo":"cliente","nombre":"Persona de prueba","telefono":"+56 9 1234 5678"}'::jsonb;
  pf public.profiles;
  a uuid; b uuid; c uuid; tok timestamptz; tok2 timestamptz;
  v_msg text; v_n int; v_txt text; v_arr text[]; v_arr2 text[];
  r public.rec_reclamos; ev public.rec_eventos;
  conflicto text := 'El reclamo fue modificado por otra persona mientras lo mirabas. Actualiza la pantalla y revisa antes de continuar.';
  tel_mal text := 'El teléfono debe tener al menos 7 dígitos.';
  vend_mal text := 'El vendedor elegido no existe o no está activo.';
begin
  select array_agg(id order by id) into uids from (
    select id from public.profiles where activo and rol::text = 'pendiente' and id not in (select id from public.rec_usuarios) order by id limit 3) t;
  select array_agg(id order by id) into vids from (
    select id from public.profiles where activo and rol::text = 'vendedor' and email not like 'zz.%' and id not in (select id from public.rec_usuarios) order by id limit 3) t;
  if cardinality(uids) < 3 or cardinality(vids) < 3 then raise exception 'faltan perfiles activos (pendientes y vendedores) para la prueba'; end if;
  sc := uids[1]; as1 := uids[2]; sin := uids[3];
  vend := vids[1]; vend_inact := vids[2]; vend_sn := vids[3];
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  insert into public.rec_usuarios (id, activo) values (sc, true), (as1, true), (vend, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values (sc, 'servicio_cliente', null, null), (as1, 'asesor_tecnico', null, null);
  update public.profiles set activo = false where id = vend_inact;
  update public.profiles set nombre = null where id = vend_sn;
  -- un cliente que no es de la cartera del vendedor (para la prueba de RLS)
  select id into cli from public.crm_clients where not (vend = any(coalesce(sellers, '{}'))) order by id limit 1;
  select code into p_a from public.crm_products where planta = 'adhesivos' order by code limit 1;
  select code into p_p from public.crm_products where planta = 'pinturas' order by code limit 1;
  select code into p_m from public.crm_products where planta = 'morteros' order by code limit 1;
  select array_agg(code order by code) into once from (select code from public.crm_products order by code limit 11) t;

  -- ── (1) rec_crear con dos productos de plantas distintas ──
  perform pg_temp.act(sc);
  a := public.rec_crear(cli, array[p_a, p_p], 'calidad_producto', 'Dos productos', hoy, '{}'::jsonb, rc);
  select * into r from public.rec_reclamos where id = a;
  if jsonb_typeof(r.productos) <> 'array' or jsonb_array_length(r.productos) <> 2 then raise exception 'caso 1a: productos debía tener 2 elementos: %', r.productos; end if;
  if exists (select 1 from jsonb_array_elements(r.productos) e where not (e ? 'code' and e ? 'nombre' and e ? 'planta')) then
    raise exception 'caso 1b: cada producto lleva code/nombre/planta: %', r.productos;
  end if;
  if r.productos->0->>'code' <> p_a or r.productos->0->>'planta' <> 'adhesivos'
     or r.productos->1->>'code' <> p_p or r.productos->1->>'planta' <> 'pinturas'
     or r.productos->1->>'nombre' is distinct from (select name from public.crm_products where code = p_p) then
    raise exception 'caso 1c: contenido u orden de productos inesperado: %', r.productos;
  end if;
  if r.producto <> p_a or r.planta <> 'adhesivos' or r.producto_nombre is distinct from (select name from public.crm_products where code = p_a) then
    raise exception 'caso 1d: producto/producto_nombre/planta deben ser los del primero: % % %', r.producto, r.producto_nombre, r.planta;
  end if;
  c := public.rec_crear(cli, array['   ', null, ' ' || p_m || ' ', ''], 'calidad_producto', 'Con blancos', hoy, '{}'::jsonb, rc);
  select * into r from public.rec_reclamos where id = c;
  if jsonb_array_length(r.productos) <> 1 or r.producto <> p_m or r.planta <> 'morteros' then
    raise exception 'caso 1e: los elementos en blanco se descartan y los códigos se recortan: %', r.productos;
  end if;
  c := public.rec_crear(cli, null, 'atraso_despacho', 'Sin productos', hoy, '{}'::jsonb, rc);
  select * into r from public.rec_reclamos where id = c;
  if r.productos <> '[]'::jsonb or r.producto is not null or r.planta is not null then raise exception 'caso 1f: sin productos queda la lista vacía: %', to_jsonb(r); end if;

  -- ── (2) errores de rec_crear ──
  perform pg_temp.espera('2a', pg_temp.fc(cli, once, 'otro', rc), 'Máximo 10 productos por reclamo.');
  perform pg_temp.espera('2b', pg_temp.fc(cli, array[p_a, ' ' || p_a || ' '], 'otro', rc), 'Hay productos repetidos.');
  perform pg_temp.espera('2c', pg_temp.fc(cli, array[p_a, 'NO-EXISTE-XYZ'], 'otro', rc), 'El producto indicado no existe.');
  perform pg_temp.espera('2d', pg_temp.fc(cli, null, 'calidad_producto', rc), 'Este motivo exige indicar el producto.');
  perform pg_temp.espera('2e', pg_temp.fc(cli, '{}', 'calidad_producto', rc), 'Este motivo exige indicar el producto.');
  perform pg_temp.espera('2f', pg_temp.fc(cli, null, 'otro', null), 'Indica quién reclama: vendedor o cliente.');
  perform pg_temp.espera('2g', pg_temp.fc(cli, null, 'otro', '{"tipo":"otro","nombre":"X"}'), 'Indica quién reclama: vendedor o cliente.');
  perform pg_temp.espera('2h', pg_temp.fc(cli, null, 'otro', '{"tipo":"cliente","nombre":"   ","telefono":"+56 9 1234 5678"}'), 'Escribe el nombre de quien reclama.');
  perform pg_temp.espera('2i', pg_temp.fc(cli, null, 'otro', '{"tipo":"cliente","nombre":"Ana","correo":"  ","telefono":""}'), 'Indica un correo o un teléfono de contacto.');
  perform pg_temp.espera('2j', pg_temp.fc(cli, null, 'otro', '{"tipo":"cliente","nombre":"Ana","correo":"ana@cliente"}'), 'El correo no tiene un formato válido.');
  perform pg_temp.espera('2k', pg_temp.fc(cli, null, 'otro', '{"tipo":"cliente","nombre":"Ana","telefono":"123"}'), tel_mal);
  perform pg_temp.espera('2l', pg_temp.fc(cli, null, 'otro', '{"tipo":"cliente","nombre":"Ana","telefono":"12345678x"}'), tel_mal);
  perform pg_temp.espera('2m', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'vendedor', 'id', gen_random_uuid())), vend_mal);
  perform pg_temp.espera('2n', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'vendedor', 'id', vend_inact)), vend_mal);
  perform pg_temp.espera('2o', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'vendedor', 'id', adm)), vend_mal);
  perform pg_temp.espera('2p', pg_temp.fc(cli, null, 'otro', '{"tipo":"vendedor","id":"no-es-uuid"}'), vend_mal);
  perform pg_temp.espera('2q', pg_temp.fc(cli, null, 'otro', '{"tipo":"vendedor"}'), vend_mal);
  perform pg_temp.espera('2r', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'vendedor', 'id', vend, 'telefono', '12')), tel_mal);

  -- ── (3) reclamante válido ──
  update public.profiles set telefono = '+56 2 2345 6789' where id = vend;
  select * into pf from public.profiles where id = vend;
  c := public.rec_crear(cli, null, 'otro', 'Vendedor con teléfono propio', hoy, '{}'::jsonb,
    jsonb_build_object('tipo', 'vendedor', 'id', vend, 'nombre', 'Otro nombre', 'correo', 'otro@x.cl', 'telefono', '  +56 9 8765 4321 '));
  select * into r from public.rec_reclamos where id = c;
  if r.reclamante_tipo <> 'vendedor' or r.reclamante_id <> vend
     or r.reclamante_nombre is distinct from coalesce(nullif(btrim(pf.nombre), ''), pf.email)
     or r.reclamante_correo is distinct from pf.email or r.reclamante_telefono <> '+56 9 8765 4321' then
    raise exception 'caso 3a: nombre y correo salen del perfil y el teléfono de la petición gana: %', to_jsonb(r);
  end if;
  c := public.rec_crear(cli, null, 'otro', 'Vendedor sin teléfono en la petición', hoy, '{}'::jsonb, jsonb_build_object('tipo', 'vendedor', 'id', vend, 'telefono', '  '));
  if (select reclamante_telefono from public.rec_reclamos where id = c) is distinct from '+56 2 2345 6789' then raise exception 'caso 3b: sin teléfono usa el del perfil'; end if;
  c := public.rec_crear(cli, null, 'otro', 'Vendedor sin nombre', hoy, '{}'::jsonb, jsonb_build_object('tipo', 'vendedor', 'id', vend_sn));
  select * into r from public.rec_reclamos where id = c;
  if r.reclamante_nombre is distinct from (select email from public.profiles where id = vend_sn) or r.reclamante_telefono is not null then
    raise exception 'caso 3c: perfil sin nombre usa el correo, y sin teléfono queda vacío: %', to_jsonb(r);
  end if;
  c := public.rec_crear(cli, null, 'otro', 'Cliente', hoy, '{}'::jsonb,
    jsonb_build_object('tipo', 'cliente', 'id', vend, 'nombre', '  Ana Pérez ', 'correo', ' ana@cliente.cl ', 'telefono', ''));
  select * into r from public.rec_reclamos where id = c;
  if r.reclamante_tipo <> 'cliente' or r.reclamante_id is not null or r.reclamante_nombre <> 'Ana Pérez'
     or r.reclamante_correo <> 'ana@cliente.cl' or r.reclamante_telefono is not null then
    raise exception 'caso 3d: cliente guarda los datos recortados y sin id: %', to_jsonb(r);
  end if;

  -- ── (3b) espacios Unicode: igual que trim() y \s de JS (reclamos-core.js) ──
  c := public.rec_crear(cli, null, 'otro', 'Teléfono con NNBSP', hoy, '{}'::jsonb,
    jsonb_build_object('tipo', 'cliente', 'nombre', chr(12288) || 'Ana' || chr(8195), 'telefono', '+56 9 1234 5678' || chr(8239)));
  select * into r from public.rec_reclamos where id = c;
  if r.reclamante_telefono is distinct from '+56 9 1234 5678' or r.reclamante_nombre is distinct from 'Ana' then
    raise exception 'caso 3e: U+202F, U+3000 y U+2003 se recortan como en JS: %', to_jsonb(r);
  end if;
  c := public.rec_crear(cli, null, 'otro', 'Teléfono con BOM', hoy, '{}'::jsonb,
    jsonb_build_object('tipo', 'cliente', 'nombre', 'Ana', 'telefono', chr(65279) || '+56 9 1234 5678'));
  if (select reclamante_telefono from public.rec_reclamos where id = c) is distinct from '+56 9 1234 5678' then raise exception 'caso 3f: U+FEFF se recorta'; end if;
  perform pg_temp.espera('3g', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'cliente', 'nombre', chr(12288), 'telefono', '+56 9 1234 5678')),
    'Escribe el nombre de quien reclama.');
  perform pg_temp.espera('3h', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'cliente', 'nombre', 'Ana', 'correo', chr(8195) || chr(65279))),
    'Indica un correo o un teléfono de contacto.');
  perform pg_temp.espera('3i', pg_temp.fc(cli, array[p_a, chr(160) || p_a || chr(160)], 'otro', rc), 'Hay productos repetidos.');
  perform pg_temp.espera('3j', pg_temp.fc(cli, array[p_a, p_a || chr(65279)], 'otro', rc), 'Hay productos repetidos.');
  c := public.rec_crear(cli, array[chr(8239) || p_a || chr(65279)], 'calidad_producto', 'Código con espacios Unicode', hoy, '{}'::jsonb, rc);
  if (select producto from public.rec_reclamos where id = c) is distinct from p_a then raise exception 'caso 3k: el código se recorta como en JS'; end if;
  -- correo: \s de JS incluye U+FEFF y U+3000 pero no U+0085
  perform pg_temp.espera('3l', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'cliente', 'nombre', 'Ana', 'correo', 'ana' || chr(65279) || 'x@cliente.cl')),
    'El correo no tiene un formato válido.');
  perform pg_temp.espera('3m', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'cliente', 'nombre', 'Ana', 'correo', 'ana' || chr(12288) || 'x@cliente.cl')),
    'El correo no tiene un formato válido.');
  perform pg_temp.espera('3n', pg_temp.fc(cli, null, 'otro', jsonb_build_object('tipo', 'cliente', 'nombre', 'Ana', 'correo', 'ana' || chr(133) || 'x@cliente.cl')), null);

  -- ── (4) rec_actualizar ──
  select actualizado_en into tok from public.rec_reclamos where id = a;
  perform public.rec_actualizar(a, array[p_p, p_m], null, tok, null);
  select * into r from public.rec_reclamos where id = a;
  if jsonb_array_length(r.productos) <> 2 or r.productos->0->>'code' <> p_p or r.productos->1->>'code' <> p_m
     or r.producto <> p_p or r.planta <> 'pinturas' or r.producto_nombre is distinct from (select name from public.crm_products where code = p_p) then
    raise exception 'caso 4a: la lista se reemplaza y el primero manda: %', to_jsonb(r);
  end if;
  select * into ev from public.rec_eventos where reclamo_id = a and tipo = 'datos_actualizados' order by id desc limit 1;
  if ev.detalle->'productos_anteriores'->0->>'code' <> p_a or jsonb_array_length(ev.detalle->'productos_anteriores') <> 2
     or ev.detalle->'productos_nuevos'->0->>'code' <> p_p or jsonb_array_length(ev.detalle->'productos_nuevos') <> 2 then
    raise exception 'caso 4b: el evento guarda productos anteriores y nuevos: %', ev.detalle;
  end if;
  perform pg_temp.espera('4c', pg_temp.fa(a, '{}', null, null, null), 'Indica al menos un producto.');
  perform pg_temp.espera('4d', pg_temp.fa(a, array['  '], null, null, null), 'Indica al menos un producto.');
  perform pg_temp.espera('4e', pg_temp.fa(a, null, null, null, null), 'No hay nada que actualizar.');
  perform pg_temp.espera('4f', pg_temp.fa(a, array[p_a], null, tok, null), conflicto);
  perform pg_temp.espera('4g', pg_temp.fa(a, null, null, null, '{"tipo":"cliente","nombre":"Ana"}'), 'Indica un correo o un teléfono de contacto.');
  perform public.rec_actualizar(a, null, null, null, jsonb_build_object('tipo', 'vendedor', 'id', vend));
  select * into r from public.rec_reclamos where id = a;
  if r.reclamante_tipo <> 'vendedor' or r.reclamante_id <> vend or r.reclamante_telefono <> '+56 2 2345 6789' or r.producto <> p_p then
    raise exception 'caso 4h: servicio cambia el reclamante sin tocar los productos: %', to_jsonb(r);
  end if;
  select * into ev from public.rec_eventos where reclamo_id = a and tipo = 'datos_actualizados' order by id desc limit 1;
  if ev.detalle->'reclamante_anterior'->>'tipo' <> 'cliente' or ev.detalle->'reclamante_anterior'->>'nombre' <> 'Persona de prueba'
     or ev.detalle->'reclamante_anterior'->>'telefono' <> '+56 9 1234 5678' then
    raise exception 'caso 4i: el evento guarda el reclamante anterior: %', ev.detalle;
  end if;
  perform public.rec_derivar(a, 'calidad', 'pinturas');
  perform public.rec_pedir_verificacion(a, as1);
  perform pg_temp.act(as1);
  perform public.rec_actualizar(a, null, '{"lote":"L-1"}'::jsonb, null, null);
  if (select datos->>'lote' from public.rec_reclamos where id = a) <> 'L-1' then raise exception 'caso 4j: el asesor asignado completa datos'; end if;
  perform pg_temp.espera('4k', pg_temp.fa(a, array[p_a], null, null, null), 'Solo servicio al cliente puede cambiar el producto.');
  perform pg_temp.espera('4l', pg_temp.fa(a, null, null, null, rc), 'Solo servicio al cliente puede cambiar los datos del reclamante.');
  if pg_temp.hist(a) not like 'creado:->ingresado,datos_actualizados:ingresado>ingresado,datos_actualizados:ingresado>ingresado,derivado:ingresado>derivado,%' then
    raise exception 'caso 4m: historia inesperada: %', pg_temp.hist(a);
  end if;

  -- ── (5) rec_vendedores ──
  perform pg_temp.act(sc);
  select count(*) into v_n from (
    (select id from public.rec_vendedores() except select id from public.profiles where activo and rol::text = 'vendedor')
    union all
    (select id from public.profiles where activo and rol::text = 'vendedor' except select id from public.rec_vendedores())) t;
  if v_n <> 0 then raise exception 'caso 5a: rec_vendedores debe traer exactamente los vendedores activos (% diferencias)', v_n; end if;
  if exists (select 1 from public.rec_vendedores() where id in (adm, sc, vend_inact)) then raise exception 'caso 5b: no debe traer admin, pendientes ni inactivos'; end if;
  select array_agg(coalesce(t.nombre, t.email) order by t.o) into v_arr from public.rec_vendedores() with ordinality t(id, nombre, email, telefono, o);
  select array_agg(coalesce(p.nombre, p.email) order by coalesce(p.nombre, p.email)) into v_arr2 from public.profiles p where p.activo and p.rol::text = 'vendedor';
  if v_arr is distinct from v_arr2 then raise exception 'caso 5c: rec_vendedores debe venir ordenado por nombre (o correo)'; end if;
  if (select telefono from public.rec_vendedores() where id = vend) is distinct from '+56 2 2345 6789' then raise exception 'caso 5d: rec_vendedores incluye el teléfono'; end if;
  perform pg_temp.act(sin);
  v_msg := pg_temp.falla('select * from public.rec_vendedores()');
  perform pg_temp.espera('5e', v_msg, 'No tienes acceso al módulo de Reclamos.');

  -- ── (6) admin_set_telefono y admin_usuarios ──
  perform pg_temp.act(sc);
  v_msg := pg_temp.falla(format('select public.admin_set_telefono(%L, %L)', vend, '+56 9 1111 2222'));
  if v_msg is null then raise exception 'caso 6a: un no-admin no cambia teléfonos'; end if;
  if (select telefono from public.profiles where id = vend) <> '+56 2 2345 6789' then raise exception 'caso 6b: el intento fallido escribió'; end if;
  perform pg_temp.act(adm);
  perform public.admin_set_telefono(vend, '');
  if (select telefono from public.profiles where id = vend) is not null then raise exception 'caso 6c: vacío guarda null'; end if;
  perform pg_temp.espera('6d', pg_temp.falla(format('select public.admin_set_telefono(%L, %L)', vend, 'abc')), tel_mal);
  perform pg_temp.espera('6e', pg_temp.falla(format('select public.admin_set_telefono(%L, %L)', vend, '12345')), tel_mal);
  perform public.admin_set_telefono(vend, '  +56 9 1234 5678 ');
  if (select telefono from public.profiles where id = vend) is distinct from '+56 9 1234 5678' then raise exception 'caso 6f: teléfono recortado'; end if;
  if (select u.telefono from public.admin_usuarios() u where u.id = vend) is distinct from '+56 9 1234 5678' then raise exception 'caso 6g: admin_usuarios trae el teléfono'; end if;
  select array_to_string(proargnames, ',') into v_txt from pg_proc where oid = 'public.admin_usuarios()'::regprocedure;
  if v_txt not like 'id,nombre,email,cargo,telefono,%' then raise exception 'caso 6h: telefono va después de cargo: %', v_txt; end if;

  -- ── (7) derivar un reclamo con productos de varias plantas: la planta se elige ──
  perform pg_temp.act(sc);
  b := public.rec_crear(cli, array[p_p, p_a], 'calidad_producto', 'Pinturas y adhesivos', hoy, '{}'::jsonb, rc);
  perform public.rec_derivar(b, 'calidad', 'pinturas');
  if (select planta_destino from public.rec_reclamos where id = b) <> 'pinturas' then raise exception 'caso 7a: planta_destino pinturas'; end if;
  perform public.rec_derivar(b, 'calidad', 'adhesivos');
  if (select planta_destino from public.rec_reclamos where id = b) <> 'adhesivos' then raise exception 'caso 7b: planta_destino adhesivos'; end if;

  -- ── (8) permisos y RLS ──
  select count(*) into v_n from unnest(array[
      'public.rec_crear(uuid,text[],text,text,date,jsonb,jsonb)', 'public.rec_actualizar(uuid,text[],jsonb,timestamptz,jsonb)',
      'public.rec_vendedores()', 'public.admin_set_telefono(uuid,text)', 'public.admin_usuarios()']) f(sig)
   where has_function_privilege('anon', f.sig, 'execute') or not has_function_privilege('authenticated', f.sig, 'execute')
      or not (select prosecdef from pg_proc where oid = f.sig::regprocedure);
  if v_n <> 0 then raise exception 'caso 8a: % funciones nuevas con permisos mal puestos', v_n; end if;
  select count(*) into v_n from (
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('rec_crear', 'rec_actualizar', 'rec_vendedores', 'admin_set_telefono', 'admin_usuarios')
     group by p.proname having count(*) <> 1) t;
  if v_n <> 0 then raise exception 'caso 8b: % funciones con más de una firma', v_n; end if;
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname in ('rec_txt', 'rec_normalizar_telefono', 'rec_normalizar_productos', 'rec_normalizar_reclamante')
     and not (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'));
  if v_n <> 4 then raise exception 'caso 8c: los 4 ayudantes internos deben existir y no ser ejecutables por el cliente (% ok)', v_n; end if;
  -- a es de un cliente ajeno al vendedor, lo creó servicio y no es de su área: ser el reclamante no le da acceso.
  if (select reclamante_id from public.rec_reclamos where id = a) <> vend then raise exception 'caso 8d: preparación'; end if;
  perform pg_temp.act(vend);
  set local role authenticated;
  select count(*) into v_n from public.rec_reclamos where id = a;
  reset role;
  if v_n <> 0 then raise exception 'caso 8e: el vendedor reclamante no debe ver un reclamo ajeno (ve %)', v_n; end if;
  perform pg_temp.act(sc);
  set local role authenticated;
  select count(*) into v_n from public.rec_reclamos where id = a and productos <> '[]'::jsonb and reclamante_nombre is not null;
  reset role;
  if v_n <> 1 then raise exception 'caso 8f: servicio al cliente ve el reclamo y las columnas nuevas'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
