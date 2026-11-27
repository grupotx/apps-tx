-- Reclamos, Tarea 3: visibilidad por rol/área/planta (RLS) y bucket privado "reclamos".
-- El cliente solo LEE: no hay políticas de escritura ni privilegios de escritura para authenticated;
-- toda escritura pasa por las funciones rec_* (security definer) de las Tareas 4 y 5.

-- ───────────────────────── Alcances de una persona ─────────────────────────
-- Incluye siempre el rol implícito 'vendedor' si la persona tiene acceso al módulo (rec_usuarios activo y perfil activo,
-- o administrador central), además de los alcances guardados. Una persona sin acceso (o con acceso desactivado) no tiene
-- ninguno, aunque conserve alcances guardados. Solo la usan las funciones de abajo y las RPC (no se expone al cliente).
create or replace function app.rec_alcances_de(p_uid uuid)
returns table(rol text, area text, planta text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'vendedor'::text, null::text, null::text
   where exists (select 1 from public.profiles p
                  where p.id = p_uid and p.activo
                    and (p.rol::text = 'admin' or exists (select 1 from public.rec_usuarios u where u.id = p.id and u.activo)))
  union all
  select a.rol, a.area, a.planta
    from public.rec_alcances a
    join public.rec_usuarios u on u.id = a.usuario_id and u.activo
    join public.profiles p on p.id = u.id and p.activo
   where a.usuario_id = p_uid
$$;
revoke all on function app.rec_alcances_de(uuid) from public, anon, authenticated;

-- ───────────────────────── ¿La persona logueada puede ver este reclamo? ─────────────────────────
--  · administrador central y gerencia: todos; servicio al cliente: todos
--  · vendedor (implícito): los que creó o cuyo cliente lo tiene en crm_clients.sellers
--  · asesor técnico: los de calidad asignados a él y los de calidad aún sin asesor
--  · encargado de área: los de su área (y de su planta si el área es calidad o producción)
--  · encargado de calidad: los de calidad de su planta
-- Un reclamo se asigna a un área y planta al derivarlo (area_destino / planta_destino); los aún sin derivar los ven
-- servicio al cliente, gerencia, admin y quien los creó.
create or replace function app.rec_puede_ver(p_reclamo uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  r record;
  a record;
begin
  if v_uid is null or p_reclamo is null then return false; end if;
  if app.tiene_rol(variadic array['admin']) then return true; end if;
  select x.creado_por, x.cliente_id, x.area_destino, x.planta_destino, x.asesor_id into r
    from public.rec_reclamos x where x.id = p_reclamo;
  if not found then return false; end if;
  for a in select * from app.rec_alcances_de(v_uid) loop
    case a.rol
      when 'gerencia', 'servicio_cliente' then
        return true;
      when 'vendedor' then
        if r.creado_por = v_uid
           or exists (select 1 from public.crm_clients c where c.id = r.cliente_id and v_uid = any(c.sellers)) then
          return true;
        end if;
      when 'asesor_tecnico' then
        if r.area_destino = 'calidad' and (r.asesor_id is null or r.asesor_id = v_uid) then return true; end if;
      when 'encargado_area' then
        if r.area_destino = a.area and (a.area not in ('calidad', 'produccion') or r.planta_destino = a.planta) then return true; end if;
      when 'encargado_calidad' then
        if r.area_destino = 'calidad' and r.planta_destino = a.planta then return true; end if;
      else
        null;
    end case;
  end loop;
  return false;
end
$$;
revoke all on function app.rec_puede_ver(uuid) from public, anon;
grant execute on function app.rec_puede_ver(uuid) to authenticated;

-- Para Storage: la primera carpeta de la ruta es el id del reclamo. Una ruta que no empiece por un uuid
-- se rechaza sin intentar el cast (un error ahí rompería cualquier consulta sobre storage.objects).
create or replace function app.rec_puede_ver_ruta(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_carpeta text := (storage.foldername(p_name))[1];
begin
  if v_carpeta is null or v_carpeta !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return app.rec_puede_ver(v_carpeta::uuid);
end
$$;
revoke all on function app.rec_puede_ver_ruta(text) from public, anon;
grant execute on function app.rec_puede_ver_ruta(text) to authenticated;

-- ───────────────────────── Políticas de lectura ─────────────────────────
drop policy if exists rec_reclamos_sel on public.rec_reclamos;
create policy rec_reclamos_sel on public.rec_reclamos for select to authenticated using (app.rec_puede_ver(id));

drop policy if exists rec_eventos_sel on public.rec_eventos;
create policy rec_eventos_sel on public.rec_eventos for select to authenticated using (app.rec_puede_ver(reclamo_id));

drop policy if exists rec_adjuntos_sel on public.rec_adjuntos;
create policy rec_adjuntos_sel on public.rec_adjuntos for select to authenticated using (app.rec_puede_ver(reclamo_id));

drop policy if exists rec_usuarios_sel on public.rec_usuarios;
create policy rec_usuarios_sel on public.rec_usuarios for select to authenticated
  using (id = (select auth.uid()) or app.tiene_rol(variadic array['admin']));

drop policy if exists rec_alcances_sel on public.rec_alcances;
create policy rec_alcances_sel on public.rec_alcances for select to authenticated
  using (usuario_id = (select auth.uid()) or app.tiene_rol(variadic array['admin']));

drop policy if exists rec_motivos_sel on public.rec_motivos;
create policy rec_motivos_sel on public.rec_motivos for select to authenticated using (app.rec_activo());

-- rec_folios: sin políticas (solo la toca rec_siguiente_folio).

-- ───────────────────────── Sin privilegios de escritura para el cliente ─────────────────────────
revoke all on public.rec_usuarios, public.rec_alcances, public.rec_motivos, public.rec_reclamos,
              public.rec_eventos, public.rec_adjuntos, public.rec_folios from anon;
revoke insert, update, delete, truncate, references, trigger on
  public.rec_usuarios, public.rec_alcances, public.rec_motivos, public.rec_reclamos,
  public.rec_eventos, public.rec_adjuntos from authenticated;
revoke all on public.rec_folios from authenticated;

-- ───────────────────────── Bucket privado "reclamos" ─────────────────────────
-- Archivos en <reclamo_id>/<nombre>. Se lee y se sube solo en la carpeta de un reclamo que la persona puede ver;
-- no hay política de update ni delete (un archivo no se pisa ni se borra desde el cliente).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reclamos', 'reclamos', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "reclamos leer" on storage.objects;
create policy "reclamos leer" on storage.objects for select to authenticated
  using (bucket_id = 'reclamos' and app.rec_puede_ver_ruta(name));

drop policy if exists "reclamos subir" on storage.objects;
create policy "reclamos subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'reclamos' and app.rec_puede_ver_ruta(name));
