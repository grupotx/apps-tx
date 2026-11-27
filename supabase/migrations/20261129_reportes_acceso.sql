-- Reportes TX (reportes.grouptx.app): acceso por módulos, administrado desde el módulo Usuarios del portal.
-- Cada persona ve en Reportes solo los módulos que el admin le active (interruptor, sin rol):
--   rep_resumen, rep_comercial, rep_logistica, rep_produccion, rep_estado_planta, rep_rrhh, rep_finanzas
--   y rep_costos ("Ver costos y márgenes"). En rep_acceso.modulo se guardan SIN el prefijo rep_ y con
--   guion bajo (estado_planta); rep_mis_modulos() los entrega como nombre de ruta (estado-planta).
-- Sin ningún módulo activo, o con la cuenta desactivada (profiles.activo), no se ve nada.
-- Las dos tablas nuevas quedan con RLS activa y SIN políticas: solo las funciones security definer
-- de abajo (y service_role) las tocan, como el resto de las tablas internas del portal.
-- Es producción compartida con 7 módulos: admin_set_modulo y admin_usuarios solo AGREGAN lo de rep_*
-- (todas las ramas, claves y filtros existentes quedan idénticos). Reversa al final del archivo.

-- 1) Tabla de permisos: una fila por (persona, módulo).
create table if not exists public.rep_acceso (
  id uuid not null references public.profiles(id) on delete cascade,
  modulo text not null check (modulo in ('resumen','comercial','logistica','produccion','estado_planta','rrhh','finanzas','costos')),
  activo boolean not null default false,
  primary key (id, modulo)
);
alter table public.rep_acceso enable row level security;
revoke all on public.rep_acceso from anon, authenticated;

-- 2) Auditoría: quién abrió qué vista y cuándo (la escribe rep_registrar_acceso).
create table if not exists public.rep_accesos (
  id uuid not null,
  vista text not null,
  fecha timestamptz not null default now()
);
alter table public.rep_accesos enable row level security;
revoke all on public.rep_accesos from anon, authenticated;

-- 3) Módulos activos de quien llama, como nombres de ruta (estado_planta -> estado-planta), ordenados.
--    {} si la cuenta está desactivada (profiles.activo), no tiene perfil o no hay sesión.
create or replace function public.rep_mis_modulos()
returns text[]
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(array_agg(replace(a.modulo, '_', '-') order by a.modulo), '{}'::text[])
  from public.rep_acceso a
  join public.profiles p on p.id = a.id
  where a.id = auth.uid() and a.activo and p.activo
$$;

revoke all on function public.rep_mis_modulos() from public, anon;
grant execute on function public.rep_mis_modulos() to authenticated;

-- 4) Registra que quien llama abrió una vista, solo si esa vista está entre sus módulos.
create or replace function public.rep_registrar_acceso(p_vista text)
returns void
language plpgsql
security definer
set search_path to ''
as $$
begin
  if p_vista is null or not (p_vista = any(public.rep_mis_modulos())) then
    raise exception 'sin acceso';
  end if;
  insert into public.rep_accesos(id, vista) values (auth.uid(), p_vista);
end $$;

revoke all on function public.rep_registrar_acceso(text) from public, anon;
grant execute on function public.rep_registrar_acceso(text) to authenticated;

-- 5) admin_set_modulo: igual que antes + una rama para rep_<módulo> (solo interruptor, sin rol).
--    Cualquier rep_<otro> cae en 'módulo desconocido'. Las ramas silos/crm/ent/tur/rt/cp/mtto no cambian.
create or replace function public.admin_set_modulo(p_id uuid, p_modulo text, p_activo boolean, p_rol text default null)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare pr public.profiles%rowtype;
begin
  if not app.tiene_rol(variadic array['admin']) then raise exception 'sin permiso'; end if;
  select * into pr from public.profiles where id = p_id;
  if not found then raise exception 'usuario no existe'; end if;
  if p_modulo = 'silos' then
    if p_id = auth.uid() and (not p_activo or coalesce(p_rol,'admin') <> 'admin') then raise exception 'no puedes quitarte el rol de administrador'; end if;
    if p_activo then
      if p_rol not in ('vendedor','tecnico','supervisor','admin') then raise exception 'rol inválido para Silos'; end if;
      update public.profiles set rol = p_rol::public.rol_t where id = p_id;
    else
      update public.profiles set rol = 'pendiente'::public.rol_t where id = p_id;
    end if;
  elsif p_modulo = 'crm' then
    if p_activo and p_rol not in ('vendedor','supervisor','admin','gerencia') then raise exception 'rol inválido para CRM'; end if;
    insert into public.crm_profiles(id, name, email, role, active)
      values (p_id, coalesce(pr.nombre, split_part(pr.email,'@',1)), pr.email, coalesce(p_rol,'vendedor'), p_activo)
      on conflict (id) do update set active = excluded.active, role = case when p_rol is not null then p_rol else public.crm_profiles.role end;
  elsif p_modulo = 'ent' then
    if p_activo and p_rol not in ('chofer','logistica','admin','cliente') then raise exception 'rol inválido para Entregas'; end if;
    insert into public.ent_usuarios(id, email, nombre, rol, activo)
      values (p_id, pr.email, coalesce(pr.nombre, split_part(pr.email,'@',1)), case when p_activo then p_rol else 'pendiente' end, p_activo)
      on conflict (id) do update set activo = excluded.activo, rol = case when p_activo then p_rol else 'pendiente' end;
  elsif p_modulo = 'tur' then
    if p_activo and p_rol not in ('editor','lector','admin') then raise exception 'rol inválido para Turnos'; end if;
    insert into public.tur_usuarios(id, email, nombre, rol, activo)
      values (p_id, pr.email, coalesce(pr.nombre, split_part(pr.email,'@',1)), coalesce(p_rol,'lector'), p_activo)
      on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.tur_usuarios.rol end;
  elsif p_modulo = 'rt' then
    insert into public.rt_usuarios(id, activo) values (p_id, p_activo)
      on conflict (id) do update set activo = excluded.activo;
  elsif p_modulo = 'cp' then
    if p_activo and p_rol not in ('editor','lector') then raise exception 'rol inválido para Choque de precios'; end if;
    insert into public.cp_usuarios(id, rol, activo) values (p_id, coalesce(p_rol,'lector'), p_activo)
      on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.cp_usuarios.rol end;
  elsif p_modulo = 'mtto' then
    if p_activo and p_rol not in ('editor','lector') then raise exception 'rol inválido para Mantención'; end if;
    insert into public.mtto_usuarios(id, rol, activo) values (p_id, coalesce(p_rol,'lector'), p_activo)
      on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.mtto_usuarios.rol end;
  elsif p_modulo like 'rep\_%' then
    if substr(p_modulo, 5) not in ('resumen','comercial','logistica','produccion','estado_planta','rrhh','finanzas','costos') then raise exception 'módulo desconocido'; end if;
    insert into public.rep_acceso(id, modulo, activo) values (p_id, substr(p_modulo, 5), p_activo)
      on conflict (id, modulo) do update set activo = excluded.activo;
  else raise exception 'módulo desconocido';
  end if;
end $function$;

-- 6) admin_usuarios: igual que antes + las 8 claves rep_* en modulos, cada una { activo, rol: null }
--    (sin fila en rep_acceso = activo false). Mismas filas, mismo filtro (oculta zz.*) y mismo orden.
create or replace function public.admin_usuarios()
returns table(id uuid, nombre text, email text, cargo text, cuenta_activa boolean, creado timestamp with time zone, modulos jsonb)
language sql
stable security definer
set search_path to ''
as $function$
  select p.id, p.nombre, p.email, p.cargo, p.activo, p.created_at,
    jsonb_build_object(
      'silos', jsonb_build_object('activo', p.activo and p.rol::text <> 'pendiente', 'rol', p.rol::text),
      'crm',   jsonb_build_object('activo', coalesce(c.active,false), 'rol', c.role),
      'ent',   jsonb_build_object('activo', coalesce(e.activo,false) and coalesce(e.rol,'pendiente') <> 'pendiente', 'rol', e.rol),
      'tur',   jsonb_build_object('activo', coalesce(t.activo,false), 'rol', t.rol),
      'rt',    jsonb_build_object('activo', coalesce(r.activo,false), 'rol', null),
      'cp',    jsonb_build_object('activo', coalesce(q.activo,false), 'rol', q.rol),
      'mtto',  jsonb_build_object('activo', coalesce(m.activo,false), 'rol', m.rol))
    || ra.j
  from public.profiles p
  left join public.crm_profiles c on c.id = p.id
  left join public.ent_usuarios e on e.id = p.id
  left join public.tur_usuarios t on t.id = p.id
  left join public.rt_usuarios r on r.id = p.id
  left join public.cp_usuarios q on q.id = p.id
  left join public.mtto_usuarios m on m.id = p.id
  left join lateral (
    select jsonb_object_agg('rep_' || k.modulo, jsonb_build_object('activo', coalesce(a.activo,false), 'rol', null)) as j
    from (values ('resumen'),('comercial'),('logistica'),('produccion'),('estado_planta'),('rrhh'),('finanzas'),('costos')) as k(modulo)
    left join public.rep_acceso a on a.id = p.id and a.modulo = k.modulo
  ) ra on true
  where app.tiene_rol(variadic array['admin']) and p.email not like 'zz.%'
  order by p.activo desc, p.nombre nulls last, p.email
$function$;

-- ============================================================================================
-- REVERSA (no se ejecuta; copiar y correr en este orden si hubiera que deshacer esta migración).
-- Primero se restauran las dos funciones a su definición de ANTES de esta migración y después se
-- borra lo nuevo (los permisos de rep_acceso se pierden; las funciones restauradas no los usan).
--
-- CREATE OR REPLACE FUNCTION public.admin_set_modulo(p_id uuid, p_modulo text, p_activo boolean, p_rol text DEFAULT NULL::text)
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO ''
-- AS $function$
-- declare pr public.profiles%rowtype;
-- begin
--   if not app.tiene_rol(variadic array['admin']) then raise exception 'sin permiso'; end if;
--   select * into pr from public.profiles where id = p_id;
--   if not found then raise exception 'usuario no existe'; end if;
--   if p_modulo = 'silos' then
--     if p_id = auth.uid() and (not p_activo or coalesce(p_rol,'admin') <> 'admin') then raise exception 'no puedes quitarte el rol de administrador'; end if;
--     if p_activo then
--       if p_rol not in ('vendedor','tecnico','supervisor','admin') then raise exception 'rol inválido para Silos'; end if;
--       update public.profiles set rol = p_rol::public.rol_t where id = p_id;
--     else
--       update public.profiles set rol = 'pendiente'::public.rol_t where id = p_id;
--     end if;
--   elsif p_modulo = 'crm' then
--     if p_activo and p_rol not in ('vendedor','supervisor','admin','gerencia') then raise exception 'rol inválido para CRM'; end if;
--     insert into public.crm_profiles(id, name, email, role, active)
--       values (p_id, coalesce(pr.nombre, split_part(pr.email,'@',1)), pr.email, coalesce(p_rol,'vendedor'), p_activo)
--       on conflict (id) do update set active = excluded.active, role = case when p_rol is not null then p_rol else public.crm_profiles.role end;
--   elsif p_modulo = 'ent' then
--     if p_activo and p_rol not in ('chofer','logistica','admin','cliente') then raise exception 'rol inválido para Entregas'; end if;
--     insert into public.ent_usuarios(id, email, nombre, rol, activo)
--       values (p_id, pr.email, coalesce(pr.nombre, split_part(pr.email,'@',1)), case when p_activo then p_rol else 'pendiente' end, p_activo)
--       on conflict (id) do update set activo = excluded.activo, rol = case when p_activo then p_rol else 'pendiente' end;
--   elsif p_modulo = 'tur' then
--     if p_activo and p_rol not in ('editor','lector','admin') then raise exception 'rol inválido para Turnos'; end if;
--     insert into public.tur_usuarios(id, email, nombre, rol, activo)
--       values (p_id, pr.email, coalesce(pr.nombre, split_part(pr.email,'@',1)), coalesce(p_rol,'lector'), p_activo)
--       on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.tur_usuarios.rol end;
--   elsif p_modulo = 'rt' then
--     insert into public.rt_usuarios(id, activo) values (p_id, p_activo)
--       on conflict (id) do update set activo = excluded.activo;
--   elsif p_modulo = 'cp' then
--     if p_activo and p_rol not in ('editor','lector') then raise exception 'rol inválido para Choque de precios'; end if;
--     insert into public.cp_usuarios(id, rol, activo) values (p_id, coalesce(p_rol,'lector'), p_activo)
--       on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.cp_usuarios.rol end;
--   elsif p_modulo = 'mtto' then
--     if p_activo and p_rol not in ('editor','lector') then raise exception 'rol inválido para Mantención'; end if;
--     insert into public.mtto_usuarios(id, rol, activo) values (p_id, coalesce(p_rol,'lector'), p_activo)
--       on conflict (id) do update set activo = excluded.activo, rol = case when p_rol is not null then p_rol else public.mtto_usuarios.rol end;
--   else raise exception 'módulo desconocido';
--   end if;
-- end $function$;
--
-- CREATE OR REPLACE FUNCTION public.admin_usuarios()
--  RETURNS TABLE(id uuid, nombre text, email text, cargo text, cuenta_activa boolean, creado timestamp with time zone, modulos jsonb)
--  LANGUAGE sql
--  STABLE SECURITY DEFINER
--  SET search_path TO ''
-- AS $function$
--   select p.id, p.nombre, p.email, p.cargo, p.activo, p.created_at,
--     jsonb_build_object(
--       'silos', jsonb_build_object('activo', p.activo and p.rol::text <> 'pendiente', 'rol', p.rol::text),
--       'crm',   jsonb_build_object('activo', coalesce(c.active,false), 'rol', c.role),
--       'ent',   jsonb_build_object('activo', coalesce(e.activo,false) and coalesce(e.rol,'pendiente') <> 'pendiente', 'rol', e.rol),
--       'tur',   jsonb_build_object('activo', coalesce(t.activo,false), 'rol', t.rol),
--       'rt',    jsonb_build_object('activo', coalesce(r.activo,false), 'rol', null),
--       'cp',    jsonb_build_object('activo', coalesce(q.activo,false), 'rol', q.rol),
--       'mtto',  jsonb_build_object('activo', coalesce(m.activo,false), 'rol', m.rol))
--   from public.profiles p
--   left join public.crm_profiles c on c.id = p.id
--   left join public.ent_usuarios e on e.id = p.id
--   left join public.tur_usuarios t on t.id = p.id
--   left join public.rt_usuarios r on r.id = p.id
--   left join public.cp_usuarios q on q.id = p.id
--   left join public.mtto_usuarios m on m.id = p.id
--   where app.tiene_rol(variadic array['admin']) and p.email not like 'zz.%'
--   order by p.activo desc, p.nombre nulls last, p.email
-- $function$;
--
-- drop function if exists public.rep_registrar_acceso(text);
-- drop function if exists public.rep_mis_modulos();
-- drop table if exists public.rep_accesos;
-- drop table if exists public.rep_acceso;
