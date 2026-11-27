-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 1: esquema base (tablas rec_*), planta por producto (crm_products.planta +
-- rec_planta_de_familia + disparador), motivos iniciales, folio y RLS habilitada.
-- Corre con el rol de la conexión (no simula usuarios): las políticas se prueban en rec_rls.test.sql.
do $$
declare
  v_cli uuid;
  v_usr uuid;
  v_n int;
  v_f1 text; v_f2 text;
  v_planta text;
  v_ok boolean;
begin
  -- (1) familia -> planta
  if public.rec_planta_de_familia('PINTURAS · GALVAPLUS') is distinct from 'pinturas' then raise exception 'caso 1a: PINTURAS · GALVAPLUS debía ser pinturas'; end if;
  if public.rec_planta_de_familia('Pinturas') is distinct from 'pinturas' then raise exception 'caso 1b: Pinturas debía ser pinturas'; end if;
  if public.rec_planta_de_familia('CERAMICOS') is distinct from 'adhesivos' then raise exception 'caso 1c: CERAMICOS debía ser adhesivos'; end if;
  if public.rec_planta_de_familia('ACCESORIOS') is distinct from 'adhesivos' then raise exception 'caso 1d: ACCESORIOS debía ser adhesivos'; end if;
  if public.rec_planta_de_familia('MORT BAS') is distinct from 'morteros' then raise exception 'caso 1e: MORT BAS debía ser morteros'; end if;
  if public.rec_planta_de_familia('GRANELES') is distinct from 'morteros' then raise exception 'caso 1f: GRANELES debía ser morteros'; end if;
  if public.rec_planta_de_familia('Cemento') is distinct from 'cementos' then raise exception 'caso 1g: Cemento debía ser cementos'; end if;
  if public.rec_planta_de_familia('S&B') is distinct from 'adhesivos' then raise exception 'caso 1h: S&B debía ser adhesivos'; end if;
  if public.rec_planta_de_familia('  mort rep ') is distinct from 'morteros' then raise exception 'caso 1i: espacios/mayúsculas deben ignorarse'; end if;
  if public.rec_planta_de_familia(null) is distinct from 'adhesivos' then raise exception 'caso 1j: familia nula cae en adhesivos'; end if;

  -- (2) todos los productos tienen planta y coincide con su familia
  select count(*) into v_n from public.crm_products where planta is null;
  if v_n <> 0 then raise exception 'caso 2a: % productos sin planta', v_n; end if;
  select count(*) into v_n from public.crm_products where planta is distinct from public.rec_planta_de_familia(family);
  if v_n <> 0 then raise exception 'caso 2b: % productos con planta distinta de la de su familia', v_n; end if;

  -- (3) producto nuevo sin planta -> la de su familia (también si viene vacía)
  insert into public.crm_products (code, name, unit, family, price, min_qty, active)
    values ('TEST-REC-1', 'Producto de prueba', 'un', 'Morteros', 0, 0, true);
  select planta into v_planta from public.crm_products where code = 'TEST-REC-1';
  if v_planta is distinct from 'morteros' then raise exception 'caso 3a: planta esperada morteros, quedó %', v_planta; end if;
  insert into public.crm_products (code, name, unit, family, price, min_qty, active, planta)
    values ('TEST-REC-2', 'Producto de prueba 2', 'un', 'Cemento', 0, 0, true, '');
  select planta into v_planta from public.crm_products where code = 'TEST-REC-2';
  if v_planta is distinct from 'cementos' then raise exception 'caso 3b: planta vacía debía rellenarse con cementos, quedó %', v_planta; end if;
  -- una planta corregida a mano se respeta
  insert into public.crm_products (code, name, unit, family, price, min_qty, active, planta)
    values ('TEST-REC-3', 'Producto de prueba 3', 'un', 'Morteros', 0, 0, true, 'adhesivos');
  select planta into v_planta from public.crm_products where code = 'TEST-REC-3';
  if v_planta is distinct from 'adhesivos' then raise exception 'caso 3c: la planta explícita debía respetarse, quedó %', v_planta; end if;

  -- (4) planta inválida rechazada por CHECK
  v_ok := false;
  begin
    insert into public.crm_products (code, name, unit, family, price, min_qty, active, planta)
      values ('TEST-REC-4', 'Producto de prueba 4', 'un', 'Morteros', 0, 0, true, 'otra');
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'caso 4: planta otra debía ser rechazada por CHECK'; end if;

  -- (5) fecha futura y compensación negativa rechazadas por la base
  select id into v_cli from public.crm_clients order by id limit 1;
  select id into v_usr from public.profiles where activo order by id limit 1;
  if v_cli is null or v_usr is null then raise exception 'faltan un cliente y un perfil activo para la prueba'; end if;

  insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por)
    values (v_cli, 'otro', 'reclamo válido de prueba', current_date, v_usr);

  v_ok := false;
  begin
    insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por)
      values (v_cli, 'otro', 'fecha futura', current_date + 1, v_usr);
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'caso 5a: fecha_recepcion futura debía ser rechazada'; end if;

  v_ok := false;
  begin
    insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por, compensacion)
      values (v_cli, 'otro', 'compensación negativa', current_date, v_usr, -1);
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'caso 5b: compensacion negativa debía ser rechazada'; end if;

  v_ok := false;
  begin
    insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por, estado)
      values (v_cli, 'otro', 'estado inválido', current_date, v_usr, 'inventado');
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'caso 5c: estado inválido debía ser rechazado'; end if;

  v_ok := false;
  begin
    insert into public.rec_reclamos (cliente_id, motivo, descripcion, fecha_recepcion, creado_por, area_destino, planta_destino)
      values (v_cli, 'otro', 'planta inválida', current_date, v_usr, 'calidad', 'otra');
  exception when check_violation then v_ok := true; end;
  if not v_ok then raise exception 'caso 5d: planta_destino inválida debía ser rechazada'; end if;

  -- el folio se asigna solo y es único
  select folio into v_f1 from public.rec_reclamos where descripcion = 'reclamo válido de prueba';
  if v_f1 !~ '^REC-[0-9]{4}-[0-9]{4}$' then raise exception 'caso 5e: folio por defecto con formato inesperado: %', v_f1; end if;

  -- (6) motivos iniciales
  select count(*) into v_n from public.rec_motivos where activo;
  if v_n <> 7 then raise exception 'caso 6a: se esperaban 7 motivos activos, hay %', v_n; end if;
  select count(*) into v_n from public.rec_motivos where requiere_producto;
  if v_n <> 3 then raise exception 'caso 6b: se esperaban 3 motivos que exigen producto, hay %', v_n; end if;
  select count(*) into v_n from public.rec_motivos
    where requiere_producto and id in ('calidad_producto', 'producto_equivocado_faltante', 'dano_transporte');
  if v_n <> 3 then raise exception 'caso 6c: los motivos con producto deben ser calidad_producto, producto_equivocado_faltante y dano_transporte'; end if;

  -- (7) folio REC-<año>-NNNN, correlativo y sin repetirse
  v_f1 := public.rec_siguiente_folio();
  v_f2 := public.rec_siguiente_folio();
  if v_f1 !~ '^REC-[0-9]{4}-[0-9]{4}$' then raise exception 'caso 7a: formato de folio inesperado: %', v_f1; end if;
  if v_f1 = v_f2 then raise exception 'caso 7b: dos llamadas seguidas repitieron el folio %', v_f1; end if;
  if substr(v_f1, 5, 4)::int <> extract(year from (now() at time zone 'America/Santiago'))::int then
    raise exception 'caso 7c: el año del folio % no es el año actual (Chile)', v_f1;
  end if;
  if substr(v_f2, 10)::int <> substr(v_f1, 10)::int + 1 then raise exception 'caso 7d: los folios % y % no son correlativos', v_f1, v_f2; end if;

  -- (8) RLS habilitada en todas las tablas rec_*
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname in
      ('rec_usuarios','rec_alcances','rec_motivos','rec_reclamos','rec_eventos','rec_adjuntos','rec_folios');
  if v_n <> 7 then raise exception 'caso 8a: se esperaban 7 tablas rec_*, hay %', v_n; end if;
  select count(*) into v_n from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'rec\_%' and not c.relrowsecurity;
  if v_n <> 0 then raise exception 'caso 8b: % tablas rec_* sin RLS habilitada', v_n; end if;

  -- el módulo: sin sesión nadie tiene acceso
  if public.rec_tengo_acceso() is not distinct from true then raise exception 'caso 9: rec_tengo_acceso() sin sesión debía ser falso'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
