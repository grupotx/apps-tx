-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Reclamos, Tarea 6: el módulo en Usuarios y accesos (admin_set_modulo / admin_usuarios con la clave 'rec').
-- Identidad simulada con request.jwt.claims sobre perfiles reales; todo se deshace con el rollback final.
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
  adm uuid; objetivo uuid; otro uuid;
  v_msg text; v_n int; v_j jsonb;
begin
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  select id into objetivo from public.profiles where activo and rol::text <> 'admin' order by id limit 1;
  select id into otro from public.profiles where activo and rol::text <> 'admin' and id <> objetivo order by id limit 1;
  if adm is null or objetivo is null or otro is null then raise exception 'faltan perfiles para la prueba'; end if;

  -- ── (1) un administrador da y quita el acceso al módulo ──
  perform pg_temp.act(objetivo);
  if public.rec_tengo_acceso() is not false then raise exception 'caso 1a: antes de darle acceso no debía tenerlo'; end if;
  perform pg_temp.act(adm);
  perform public.admin_set_modulo(objetivo, 'rec', true, null);
  if not exists (select 1 from public.rec_usuarios where id = objetivo and activo) then raise exception 'caso 1b: debía quedar la fila activa en rec_usuarios'; end if;
  perform pg_temp.act(objetivo);
  if public.rec_tengo_acceso() is not true then raise exception 'caso 1c: con el acceso dado, rec_tengo_acceso() debía ser true'; end if;
  perform pg_temp.act(adm);
  perform public.admin_set_modulo(objetivo, 'rec', false, null);
  if not exists (select 1 from public.rec_usuarios where id = objetivo and not activo) then raise exception 'caso 1d: debía quedar desactivada'; end if;
  perform pg_temp.act(objetivo);
  if public.rec_tengo_acceso() is not false then raise exception 'caso 1e: desactivada, rec_tengo_acceso() debía ser false'; end if;
  perform pg_temp.act(adm);
  perform public.admin_set_modulo(objetivo, 'rec', true, null);   -- reactivar la misma fila no duplica
  select count(*) into v_n from public.rec_usuarios where id = objetivo;
  if v_n <> 1 then raise exception 'caso 1f: debía haber una sola fila, hay %', v_n; end if;

  -- ── (2) quien no es admin no puede ──
  perform pg_temp.act(otro);
  v_msg := pg_temp.falla(format('select public.admin_set_modulo(%L, %L, true, null)', otro, 'rec'));
  if v_msg is null or v_msg !~* 'sin permiso' then raise exception 'caso 2a: un no admin debía recibir "sin permiso", dio %', v_msg; end if;

  -- ── (3) admin_usuarios() expone la clave rec en modulos ──
  perform pg_temp.act(adm);
  select modulos->'rec' into v_j from public.admin_usuarios() where id = objetivo;
  if v_j is distinct from '{"rol": null, "activo": true}'::jsonb then raise exception 'caso 3a: modulos->rec de la persona con acceso: %', v_j; end if;
  select modulos->'rec' into v_j from public.admin_usuarios() where id = otro;
  if v_j is distinct from '{"rol": null, "activo": false}'::jsonb then raise exception 'caso 3b: modulos->rec de quien no tiene acceso: %', v_j; end if;
  select count(*) into v_n from public.admin_usuarios() u where not (u.modulos ? 'rec');
  if v_n <> 0 then raise exception 'caso 3c: % personas sin la clave rec', v_n; end if;
  perform pg_temp.act(otro);
  select count(*) into v_n from public.admin_usuarios();
  if v_n <> 0 then raise exception 'caso 3d: un no admin no ve la lista de usuarios, ve %', v_n; end if;

  -- ── (4) las ramas existentes siguen funcionando ──
  perform pg_temp.act(adm);
  perform public.admin_set_modulo(objetivo, 'mtto', true, 'lector');
  if not exists (select 1 from public.mtto_usuarios where id = objetivo and activo and rol = 'lector') then raise exception 'caso 4a: rama mtto'; end if;
  perform public.admin_set_modulo(objetivo, 'rt', true, null);
  if not exists (select 1 from public.rt_usuarios where id = objetivo and activo) then raise exception 'caso 4b: rama rt'; end if;
  perform public.admin_set_modulo(objetivo, 'crm', true, 'vendedor');
  if not exists (select 1 from public.crm_profiles where id = objetivo and active) then raise exception 'caso 4c: rama crm'; end if;
  perform public.admin_set_modulo(objetivo, 'rep_resumen', true, null);
  if not exists (select 1 from public.rep_acceso where id = objetivo and modulo = 'resumen' and activo) then raise exception 'caso 4d: rama rep_'; end if;
  select modulos->'mtto' into v_j from public.admin_usuarios() where id = objetivo;
  if (v_j->>'activo')::boolean is not true or v_j->>'rol' <> 'lector' then raise exception 'caso 4e: admin_usuarios mtto: %', v_j; end if;
  select modulos->'rep_resumen' into v_j from public.admin_usuarios() where id = objetivo;
  if (v_j->>'activo')::boolean is not true then raise exception 'caso 4f: admin_usuarios rep_resumen: %', v_j; end if;
  v_msg := pg_temp.falla(format('select public.admin_set_modulo(%L, %L, true, null)', objetivo, 'inexistente'));
  if v_msg is null or v_msg !~* 'módulo desconocido' then raise exception 'caso 4g: un módulo desconocido debía fallar, dio %', v_msg; end if;
  v_msg := pg_temp.falla(format('select public.admin_set_modulo(%L, %L, true, %L)', objetivo, 'mtto', 'jefe'));
  if v_msg is null or v_msg !~* 'rol inválido' then raise exception 'caso 4h: rol inválido en mtto debía fallar, dio %', v_msg; end if;

  -- ── (5) permisos de ejecución sin cambios: anon no; authenticated sí ──
  select count(*) into v_n from pg_proc p where p.oid in ('public.admin_set_modulo(uuid,text,boolean,text)'::regprocedure, 'public.admin_usuarios()'::regprocedure)
    and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute') or not p.prosecdef);
  if v_n <> 0 then raise exception 'caso 5a: permisos de admin_set_modulo/admin_usuarios cambiaron'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
