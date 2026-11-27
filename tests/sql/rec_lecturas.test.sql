-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 7 (prerrequisito de lectura): quien tiene solo el módulo Reclamos no lee crm_clients, crm_products ni
-- profiles por RLS; la app necesita nombres para mostrar. rec_buscar_clientes / rec_productos / rec_nombres los entregan
-- (solo a usuarios del módulo) y rec_crear guarda una copia del nombre del cliente y del producto en el reclamo.
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

do $$
declare
  pend uuid; pend2 uuid; vend uuid; ajeno uuid; adm uuid;
  cli uuid; cli_nombre text; p_code text; p_nombre text;
  v_n int; v_msg text; v_id uuid; r public.rec_reclamos; v_j jsonb;
  hoy date := (now() at time zone 'America/Santiago')::date;
begin
  select id into pend from public.profiles where activo and rol::text = 'pendiente' order by id limit 1;
  select id into pend2 from public.profiles where activo and rol::text = 'pendiente' and id <> pend order by id limit 1;
  select id into vend from public.profiles where activo and rol::text = 'vendedor' order by id limit 1;
  select id into ajeno from public.profiles where activo and rol::text = 'vendedor' and id <> vend order by id limit 1;
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  if pend is null or pend2 is null or vend is null or ajeno is null or adm is null then raise exception 'faltan perfiles (2 pendientes, 2 vendedores, 1 admin) para la prueba'; end if;
  insert into public.rec_usuarios (id, activo) values (pend, true), (pend2, true), (vend, true);
  insert into public.rec_alcances (usuario_id, rol, area, planta) values
    (pend, 'servicio_cliente', null, null),            -- solo módulo, sin CRM ni Silos, pero servicio al cliente
    (pend2, 'encargado_area', 'logistica', null);      -- solo módulo y sin poder ingresar reclamos
  select id, coalesce(nullif(btrim(name), ''), razon) into cli, cli_nombre from public.crm_clients where length(coalesce(name, '')) >= 6 order by id limit 1;
  select code, name into p_code, p_nombre from public.crm_products order by code limit 1;

  -- ── (0) la premisa: por RLS, quien solo tiene el módulo no ve clientes ni productos ──
  perform pg_temp.act(pend);
  set local role authenticated;
  select count(*) into v_n from public.crm_clients;
  if v_n <> 0 then reset role; raise exception 'caso 0a: se esperaba que un usuario solo-módulo no lea crm_clients por RLS y lee % filas (cambió el sistema; revisar la capa de lectura)', v_n; end if;
  select count(*) into v_n from public.crm_products;
  if v_n <> 0 then reset role; raise exception 'caso 0b: se esperaba que un usuario solo-módulo no lea crm_products por RLS y lee %', v_n; end if;
  reset role;

  -- ── (1) buscar clientes: servicio al cliente ve todos; un encargado sin permiso de ingreso no; mínimo 2 letras ──
  perform pg_temp.act(pend);
  set local role authenticated;
  select count(*) into v_n from public.rec_buscar_clientes(cli_nombre) where id = cli and nombre = cli_nombre;
  reset role;
  if v_n <> 1 then raise exception 'caso 1a: servicio al cliente debía encontrar el cliente por su nombre, encontró %', v_n; end if;
  select count(*) into v_n from public.rec_buscar_clientes('a');
  if v_n <> 0 then raise exception 'caso 1b: con menos de 2 letras no devuelve nada, devolvió %', v_n; end if;
  select count(*) into v_n from public.rec_buscar_clientes(cli_nombre);
  if v_n > 20 then raise exception 'caso 1c: tope de 20 resultados, devolvió %', v_n; end if;
  perform pg_temp.act(vend);
  select count(*) into v_n from public.rec_buscar_clientes(cli_nombre) where id = cli;
  if v_n <> 1 then raise exception 'caso 1d: un vendedor (rol Silos) también busca clientes, encontró %', v_n; end if;
  perform pg_temp.act(pend2);
  select count(*) into v_n from public.rec_buscar_clientes(cli_nombre);
  if v_n <> 0 then raise exception 'caso 1e: quien no puede ingresar reclamos no busca clientes, encontró %', v_n; end if;
  perform pg_temp.act(ajeno);
  v_msg := pg_temp.falla(format('select * from public.rec_buscar_clientes(%L)', cli_nombre));
  if v_msg is null or v_msg !~* 'acceso' then raise exception 'caso 1f: sin acceso al módulo debía fallar, dio %', v_msg; end if;

  -- ── (2) productos: catálogo activo para cualquier usuario del módulo (con su planta) ──
  perform pg_temp.act(pend2);
  select count(*) into v_n from public.rec_productos();
  if v_n <> (select count(*) from public.crm_products where active) then raise exception 'caso 2a: debía devolver los productos activos, devolvió %', v_n; end if;
  if exists (select 1 from public.rec_productos() p where p.planta is null or p.planta not in ('pinturas', 'morteros', 'adhesivos', 'cementos')) then raise exception 'caso 2b: todos con planta válida'; end if;
  perform pg_temp.act(ajeno);
  v_msg := pg_temp.falla('select * from public.rec_productos()');
  if v_msg is null or v_msg !~* 'acceso' then raise exception 'caso 2c: sin acceso al módulo debía fallar, dio %', v_msg; end if;

  -- ── (3) nombres de personas: solo de quienes están en el módulo (o admin), nunca de cualquier perfil ──
  perform pg_temp.act(pend2);
  select count(*) into v_n from public.rec_nombres(array[pend, vend, adm, ajeno]);
  if v_n <> 3 then raise exception 'caso 3a: debía devolver 3 nombres (pend, vend y admin; no el ajeno), devolvió %', v_n; end if;
  if exists (select 1 from public.rec_nombres(array[ajeno])) then raise exception 'caso 3b: un perfil fuera del módulo no se expone'; end if;
  if exists (select 1 from public.rec_nombres(array[pend]) n where n.nombre is null or btrim(n.nombre) = '') then raise exception 'caso 3c: el nombre no puede venir vacío'; end if;
  perform pg_temp.act(ajeno);
  v_msg := pg_temp.falla(format('select * from public.rec_nombres(array[%L]::uuid[])', pend));
  if v_msg is null or v_msg !~* 'acceso' then raise exception 'caso 3d: sin acceso al módulo debía fallar, dio %', v_msg; end if;
  perform pg_temp.act(pend2);
  v_msg := pg_temp.falla(format('select * from public.rec_nombres(array(select gen_random_uuid() from generate_series(1, 300)))'));
  if v_msg is null then raise exception 'caso 3e: más de 200 ids debía fallar'; end if;

  -- ── (4) rec_crear guarda el nombre del cliente y del producto (copia estable que cualquiera con acceso al reclamo ve) ──
  perform pg_temp.act(pend);
  v_id := public.rec_crear(cli, p_code, 'calidad_producto', 'Reclamo de prueba de lectura', hoy);
  select * into r from public.rec_reclamos where id = v_id;
  if r.cliente_nombre is distinct from cli_nombre then raise exception 'caso 4a: cliente_nombre esperado %, quedó %', cli_nombre, r.cliente_nombre; end if;
  if r.producto_nombre is distinct from p_nombre then raise exception 'caso 4b: producto_nombre esperado %, quedó %', p_nombre, r.producto_nombre; end if;
  v_id := public.rec_crear(cli, null, 'atraso_despacho', 'Sin producto', hoy);
  select * into r from public.rec_reclamos where id = v_id;
  if r.producto_nombre is not null then raise exception 'caso 4c: sin producto no hay nombre de producto'; end if;

  -- ── (5) permisos de ejecución: anon no, authenticated sí, security definer ──
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('rec_buscar_clientes', 'rec_productos', 'rec_nombres', 'rec_crear')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute') or not p.prosecdef);
  if v_n <> 0 then raise exception 'caso 5a: % funciones con permisos mal puestos', v_n; end if;

  raise exception 'OK_ROLLBACK';
end $$;
