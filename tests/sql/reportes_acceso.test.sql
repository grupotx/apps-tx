-- Correr con execute_sql (después de aplicar 20261129_reportes_acceso.sql): debe terminar con
-- "OK_ROLLBACK" (no deja datos). Cualquier otro error = prueba fallida.
-- Acceso a Reportes TX por módulos: rep_acceso / rep_accesos (cerradas), rep_mis_modulos(),
-- rep_registrar_acceso() y la extensión de admin_set_modulo / admin_usuarios con los 8 módulos rep_*.
-- Cuentas: zz.prueba.crm pasa a admin SOLO dentro de esta transacción (se revierte al final);
-- zz.prueba.vendedor (usr) recibe los módulos; zz.prueba.logistica (nad) no es admin. Como
-- admin_usuarios() oculta las cuentas zz.*, esa parte se prueba con un admin real que solo lee la
-- lista y se da a sí mismo dos módulos rep_* (todo se revierte al final).
do $$
declare
  adm uuid; usr uuid; nad uuid; vis uuid;
  fantasma uuid := gen_random_uuid();
  claves_rep text[] := array['rep_resumen','rep_comercial','rep_logistica','rep_produccion',
                             'rep_estado_planta','rep_rrhh','rep_finanzas','rep_costos'];
  claves_old text[] := array['silos','crm','ent','tur','rt','cp','mtto'];
  k text; mods text[]; ok boolean; n int; n0 int; antes jsonb; despues jsonb; fila jsonb; t timestamptz;
begin
  select id into adm from public.profiles where email = 'zz.prueba.crm@grupotx.cl';
  select id into usr from public.profiles where email = 'zz.prueba.vendedor@grupotx.cl';
  select id into nad from public.profiles where email = 'zz.prueba.logistica@grupotx.cl';
  select id into vis from public.profiles where activo and rol::text = 'admin' and email not like 'zz.%' order by id limit 1;
  if adm is null or usr is null or nad is null or vis is null then
    raise exception 'faltan las cuentas zz.prueba.{crm,vendedor,logistica} o un admin real para la prueba';
  end if;
  update public.profiles set rol = 'admin', activo = true where id = adm;      -- solo dentro de la transacción
  update public.profiles set rol = 'pendiente', activo = true where id = nad;  -- no admin
  update public.profiles set activo = true where id = usr;

  -- ===== 0) Estructura: tablas cerradas, funciones definer y permisos =====
  assert (select relrowsecurity from pg_class where oid = 'public.rep_acceso'::regclass), 'RLS activa en rep_acceso';
  assert (select relrowsecurity from pg_class where oid = 'public.rep_accesos'::regclass), 'RLS activa en rep_accesos';
  assert (select count(*) from pg_policies where schemaname = 'public' and tablename in ('rep_acceso','rep_accesos')) = 0,
    'rep_acceso y rep_accesos no deben tener políticas';
  assert not (has_table_privilege('authenticated', 'public.rep_acceso', 'select,insert,update,delete')
           or has_table_privilege('anon', 'public.rep_acceso', 'select,insert,update,delete')
           or has_table_privilege('authenticated', 'public.rep_accesos', 'select,insert,update,delete')
           or has_table_privilege('anon', 'public.rep_accesos', 'select,insert,update,delete')),
    'anon/authenticated no deben tener permisos directos sobre las tablas rep_*';
  assert has_function_privilege('authenticated', 'public.rep_mis_modulos()', 'execute')
     and has_function_privilege('authenticated', 'public.rep_registrar_acceso(text)', 'execute'), 'authenticated ejecuta las funciones rep_*';
  assert not (has_function_privilege('anon', 'public.rep_mis_modulos()', 'execute')
           or has_function_privilege('anon', 'public.rep_registrar_acceso(text)', 'execute')), 'anon/public no ejecutan las funciones rep_*';
  assert (select count(*) from pg_proc where oid in ('public.rep_mis_modulos()'::regprocedure, 'public.rep_registrar_acceso(text)'::regprocedure)
            and prosecdef and proconfig = array['search_path=""']) = 2, 'funciones rep_* security definer con search_path vacío';
  ok := false;
  begin
    insert into public.rep_acceso (id, modulo, activo) values (usr, 'foo', true);
  exception when check_violation then ok := true;
  end;
  assert ok, 'modulo fuera de la lista debe violar el CHECK';

  -- ===== 1) Admin activa dos módulos: rep_mis_modulos() = {comercial,estado-planta}; apagar uno =====
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_modulo(usr, 'rep_comercial', true);
  perform public.admin_set_modulo(usr, 'rep_estado_planta', true);
  perform public.admin_set_modulo(usr, 'rep_comercial', true);  -- idempotente: no duplica la fila
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  mods := public.rep_mis_modulos();
  assert mods = array['comercial','estado-planta'], 'caso 1: se esperaba {comercial,estado-planta}, llegó ' || mods::text;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_set_modulo(usr, 'rep_comercial', false);
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  mods := public.rep_mis_modulos();
  assert mods = array['estado-planta'], 'caso 1b: al apagar rep_comercial se esperaba {estado-planta}, llegó ' || mods::text;
  reset role;
  assert (select array_agg(modulo order by modulo) from public.rep_acceso where id = usr) = array['comercial','estado_planta'],
    'caso 1c: rep_acceso guarda la clave sin prefijo rep_ y con guion bajo, una fila por módulo';
  assert (select activo from public.rep_acceso where id = usr and modulo = 'comercial') = false, 'caso 1d: comercial queda en activo=false';

  -- ===== 2) rep_costos es independiente de los demás módulos =====
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_modulo(nad, 'rep_costos', true);
  perform set_config('request.jwt.claims', json_build_object('sub', nad, 'role', 'authenticated')::text, true);
  mods := public.rep_mis_modulos();
  assert mods = array['costos'], 'caso 2: activar rep_costos no debe activar nada más, llegó ' || mods::text;
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  assert public.rep_mis_modulos() = array['estado-planta'], 'caso 2b: activar a otro usuario no cambia los módulos de usr';
  -- los 8 módulos se activan uno a uno y salen con su nombre de ruta (estado_planta -> estado-planta)
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  foreach k in array claves_rep loop
    perform public.admin_set_modulo(nad, k, true);
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', nad, 'role', 'authenticated')::text, true);
  mods := public.rep_mis_modulos();
  assert mods @> array['resumen','comercial','logistica','produccion','estado-planta','rrhh','finanzas','costos']
     and mods <@ array['resumen','comercial','logistica','produccion','estado-planta','rrhh','finanzas','costos'],
    'caso 2c: los 8 módulos activos deben salir con guion, llegó ' || mods::text;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform public.admin_set_modulo(nad, 'rep_costos', false);
  perform set_config('request.jwt.claims', json_build_object('sub', nad, 'role', 'authenticated')::text, true);
  mods := public.rep_mis_modulos();
  assert array_length(mods, 1) = 7 and not ('costos' = any(mods)), 'caso 2d: apagar rep_costos deja los otros 7 intactos, llegó ' || mods::text;

  -- ===== 3) Permisos y módulos desconocidos =====
  reset role;
  select count(*) into n0 from public.rep_acceso where id = usr;
  perform set_config('request.jwt.claims', json_build_object('sub', nad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin
    perform public.admin_set_modulo(usr, 'rep_resumen', true);
  exception when others then
    assert sqlerrm = 'sin permiso', 'caso 3: un no-admin debe recibir "sin permiso", llegó: ' || sqlerrm;
    ok := true;
  end;
  assert ok, 'caso 3: un no-admin no debe poder llamar admin_set_modulo';
  assert (select count(*) from public.admin_usuarios()) = 0, 'caso 3b: un no-admin no ve la lista de usuarios (comportamiento previo)';

  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  foreach k in array array['rep_foo','rep_','rep_Resumen','rep_estado-planta','repcomercial','foo'] loop
    ok := false;
    begin
      perform public.admin_set_modulo(usr, k, true);
    exception when others then
      assert sqlerrm = 'módulo desconocido', 'caso 3c: ' || k || ' debe fallar con "módulo desconocido", llegó: ' || sqlerrm;
      ok := true;
    end;
    assert ok, 'caso 3c: ' || k || ' no debe aceptarse';
  end loop;
  ok := false;
  begin
    perform public.admin_set_modulo(fantasma, 'rep_resumen', true);
  exception when others then
    assert sqlerrm = 'usuario no existe', 'caso 3d: usuario inexistente, llegó: ' || sqlerrm;
    ok := true;
  end;
  assert ok, 'caso 3d: debe seguir validando que el usuario existe';
  reset role;
  select count(*) into n from public.rep_acceso where id = usr;
  assert n = n0, 'caso 3e: ninguna llamada fallida debe escribir en rep_acceso (antes ' || n0 || ', ahora ' || n || ')';
  assert not exists (select 1 from public.rep_acceso where id = fantasma or (id = usr and modulo = 'resumen')), 'caso 3e: nada escrito';

  -- ===== 4) Cuenta desactivada, sin perfil o sin sesión: lista vacía =====
  update public.profiles set activo = false where id = usr;
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.rep_mis_modulos() = '{}'::text[], 'caso 4: con profiles.activo = false debe devolver {}';
  perform set_config('request.jwt.claims', json_build_object('sub', fantasma, 'role', 'authenticated')::text, true);
  assert public.rep_mis_modulos() = '{}'::text[], 'caso 4b: sin perfil debe devolver {}';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  assert public.rep_mis_modulos() = '{}'::text[], 'caso 4c: sin sub en el JWT debe devolver {}';
  reset role;
  update public.profiles set activo = true where id = usr;
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.rep_mis_modulos() = array['estado-planta'], 'caso 4d: al reactivar la cuenta vuelven sus módulos';

  -- ===== 5) rep_registrar_acceso: solo con el módulo; inserta exactamente 1 fila =====
  ok := false;
  begin
    perform public.rep_registrar_acceso('rrhh');
  exception when others then
    assert sqlerrm = 'sin acceso', 'caso 5: sin el módulo debe fallar con "sin acceso", llegó: ' || sqlerrm;
    ok := true;
  end;
  assert ok, 'caso 5: rrhh sin el módulo debe fallar';
  foreach k in array array['comercial','estado_planta','Estado-Planta',''] loop  -- comercial: apagado; el resto: nombre mal escrito
    ok := false;
    begin
      perform public.rep_registrar_acceso(k);
    exception when others then ok := sqlerrm = 'sin acceso';
    end;
    assert ok, 'caso 5b: la vista "' || k || '" no debe registrarse';
  end loop;
  ok := false;
  begin
    perform public.rep_registrar_acceso(null);
  exception when others then ok := sqlerrm = 'sin acceso';
  end;
  assert ok, 'caso 5c: vista null no debe registrarse';
  reset role;
  assert (select count(*) from public.rep_accesos where id = usr) = 0, 'caso 5d: los intentos fallidos no insertan filas';
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_modulo(usr, 'rep_rrhh', true);
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  perform public.rep_registrar_acceso('rrhh');
  reset role;
  assert (select count(*) from public.rep_accesos where id = usr) = 1, 'caso 5e: con el módulo inserta exactamente 1 fila';
  select count(*), max(fecha) into n, t from public.rep_accesos where id = usr and vista = 'rrhh';
  assert n = 1 and t between now() - interval '1 minute' and now() + interval '1 minute', 'caso 5f: fila (usr, rrhh, fecha de hoy)';
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.rep_registrar_acceso('estado-planta');
  reset role;
  assert (select count(*) from public.rep_accesos where id = usr) = 2, 'caso 5g: la vista estado-planta registra 1 fila más';

  -- ===== 6) anon y authenticated no tocan las tablas ni llaman a las funciones sin permiso =====
  perform set_config('request.jwt.claims', json_build_object('sub', usr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin perform 1 from public.rep_acceso; exception when insufficient_privilege then ok := true; end;
  assert ok, 'caso 6: authenticated no debe leer rep_acceso';
  ok := false;
  begin insert into public.rep_accesos (id, vista) values (usr, 'resumen'); exception when insufficient_privilege then ok := true; end;
  assert ok, 'caso 6b: authenticated no debe escribir en rep_accesos';
  reset role;
  set local role anon;
  ok := false;
  begin perform public.rep_mis_modulos(); exception when insufficient_privilege then ok := true; end;
  assert ok, 'caso 6c: anon no debe ejecutar rep_mis_modulos';
  reset role;

  -- ===== 7) admin_usuarios(): 8 claves rep_* nuevas y las 7 de antes sin cambios =====
  perform set_config('request.jwt.claims', json_build_object('sub', vis, 'role', 'authenticated')::text, true);
  set local role authenticated;
  antes := (select jsonb_agg(to_jsonb(u)) from public.admin_usuarios() u);
  perform public.admin_set_modulo(vis, 'rep_finanzas', true);
  perform public.admin_set_modulo(vis, 'rep_costos', true);
  despues := (select jsonb_agg(to_jsonb(u)) from public.admin_usuarios() u);
  reset role;
  assert jsonb_array_length(antes) > 0 and jsonb_array_length(despues) = jsonb_array_length(antes), 'caso 7: misma cantidad de usuarios antes y después';
  assert not exists (select 1 from jsonb_array_elements(despues) e where (e->>'email') like 'zz.%'), 'caso 7b: sigue ocultando las cuentas zz.*';
  for fila in select e from jsonb_array_elements(despues) e loop
    assert (fila->'modulos') ?& (claves_old || claves_rep), 'caso 7c: faltan claves en modulos de ' || (fila->>'email');
    assert (select count(*) from jsonb_object_keys(fila->'modulos')) = 15, 'caso 7c: modulos debe tener exactamente 15 claves';
    foreach k in array claves_rep loop
      assert (select count(*) from jsonb_object_keys(fila->'modulos'->k)) = 2
         and jsonb_typeof(fila->'modulos'->k->'activo') = 'boolean'
         and jsonb_typeof(fila->'modulos'->k->'rol') = 'null', 'caso 7d: ' || k || ' debe ser {activo, rol: null}';
      assert (fila->'modulos'->k->>'activo')::boolean
             = coalesce((select a.activo from public.rep_acceso a where a.id = (fila->>'id')::uuid and a.modulo = substr(k, 5)), false),
        'caso 7e: ' || k || ' no coincide con rep_acceso para ' || (fila->>'email');
    end loop;
  end loop;
  select e into fila from jsonb_array_elements(despues) e where (e->>'id')::uuid = vis;
  assert (fila->'modulos'->'rep_finanzas'->>'activo')::boolean and (fila->'modulos'->'rep_costos'->>'activo')::boolean
     and not (fila->'modulos'->'rep_resumen'->>'activo')::boolean, 'caso 7f: rep_finanzas y rep_costos activos, rep_resumen no';
  -- las 7 claves de antes: iguales antes/después del cambio de rep_* ...
  assert (select jsonb_agg((e->'modulos') - claves_rep order by o) from jsonb_array_elements(antes) with ordinality t(e, o))
       = (select jsonb_agg((e->'modulos') - claves_rep order by o) from jsonb_array_elements(despues) with ordinality t(e, o)),
    'caso 7g: las 7 claves de antes no deben cambiar (ni su orden de filas)';
  -- ... e iguales a lo que da la fórmula original (silos, crm, ent, tur, rt, cp, mtto) desde las tablas base
  select count(*) into n
  from jsonb_array_elements(despues) e
  join public.profiles p on p.id = (e->>'id')::uuid
  left join public.crm_profiles c on c.id = p.id
  left join public.ent_usuarios en on en.id = p.id
  left join public.tur_usuarios tu on tu.id = p.id
  left join public.rt_usuarios r on r.id = p.id
  left join public.cp_usuarios q on q.id = p.id
  left join public.mtto_usuarios m on m.id = p.id
  where (e->'modulos') - claves_rep is distinct from jsonb_build_object(
      'silos', jsonb_build_object('activo', p.activo and p.rol::text <> 'pendiente', 'rol', p.rol::text),
      'crm',   jsonb_build_object('activo', coalesce(c.active,false), 'rol', c.role),
      'ent',   jsonb_build_object('activo', coalesce(en.activo,false) and coalesce(en.rol,'pendiente') <> 'pendiente', 'rol', en.rol),
      'tur',   jsonb_build_object('activo', coalesce(tu.activo,false), 'rol', tu.rol),
      'rt',    jsonb_build_object('activo', coalesce(r.activo,false), 'rol', null),
      'cp',    jsonb_build_object('activo', coalesce(q.activo,false), 'rol', q.rol),
      'mtto',  jsonb_build_object('activo', coalesce(m.activo,false), 'rol', m.rol));
  assert n = 0, 'caso 7h: ' || n || ' usuarios con las 7 claves de antes distintas de la fórmula original';

  -- ===== 8) Las ramas existentes de admin_set_modulo siguen igual (rt, mtto, cp y su validación de rol) =====
  select count(*) into n0 from public.cp_usuarios where id = usr and activo;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.admin_set_modulo(usr, 'rt', true);
  perform public.admin_set_modulo(usr, 'mtto', true, 'lector');
  ok := false;
  begin
    perform public.admin_set_modulo(usr, 'cp', true, 'rol-que-no-existe');
  exception when others then
    assert sqlerrm = 'rol inválido para Choque de precios', 'caso 8: mensaje de cp, llegó: ' || sqlerrm;
    ok := true;
  end;
  assert ok, 'caso 8: cp con rol inválido debe seguir fallando';
  reset role;
  assert (select activo from public.rt_usuarios where id = usr), 'caso 8b: rt activado en rt_usuarios';
  assert (select activo and rol = 'lector' from public.mtto_usuarios where id = usr), 'caso 8c: mtto activado con rol lector';
  assert (select count(*) from public.cp_usuarios where id = usr and activo) = n0, 'caso 8d: el cp fallido no cambió cp_usuarios';

  raise exception 'OK_ROLLBACK';
end $$;
