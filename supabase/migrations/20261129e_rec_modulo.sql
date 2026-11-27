-- Reclamos, Tarea 6: el módulo "rec" en Usuarios y accesos.
-- admin_set_modulo y admin_usuarios no estaban versionadas en supabase/migrations (existían solo en la base):
-- esta migración reproduce COMPLETA su definición vigente (2026-11-27) y agrega solo lo de 'rec':
--   · admin_set_modulo: rama 'rec' → rec_usuarios(id, activo), sin rol (como Terreno);
--   · admin_usuarios: clave 'rec' en modulos con { activo, rol: null }.
-- Los alcances (rol, área, planta) NO se dan aquí: se asignan dentro de la app (rec_set_alcance).

create or replace function public.admin_set_modulo(p_id uuid, p_modulo text, p_activo boolean, p_rol text default null::text)
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
  elsif p_modulo = 'rec' then
    insert into public.rec_usuarios(id, activo) values (p_id, p_activo)
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
      'rec',   jsonb_build_object('activo', coalesce(rc.activo,false), 'rol', null),
      'cp',    jsonb_build_object('activo', coalesce(q.activo,false), 'rol', q.rol),
      'mtto',  jsonb_build_object('activo', coalesce(m.activo,false), 'rol', m.rol))
    || ra.j
  from public.profiles p
  left join public.crm_profiles c on c.id = p.id
  left join public.ent_usuarios e on e.id = p.id
  left join public.tur_usuarios t on t.id = p.id
  left join public.rt_usuarios r on r.id = p.id
  left join public.rec_usuarios rc on rc.id = p.id
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

-- Mismos permisos de ejecución que tenían (create or replace los conserva; se dejan explícitos).
revoke all on function public.admin_set_modulo(uuid, text, boolean, text) from public, anon;
revoke all on function public.admin_usuarios() from public, anon;
grant execute on function public.admin_set_modulo(uuid, text, boolean, text) to authenticated, service_role;
grant execute on function public.admin_usuarios() to authenticated, service_role;
