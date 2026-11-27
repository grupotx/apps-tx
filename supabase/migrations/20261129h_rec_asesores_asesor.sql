-- Reclamos (Tarea 8): un asesor técnico también puede ver la lista de asesores, porque puede reasignar su propio
-- reclamo a otro asesor (rec_reasignar_asesor). Antes solo la veía servicio al cliente/admin.
create or replace function public.rec_asesores()
returns table(id uuid, nombre text) language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.rec_exigir_acceso();
  if not (app.rec_es_servicio()
          or exists (select 1 from app.rec_alcances_de(auth.uid()) a where a.rol = 'asesor_tecnico')) then
    raise exception 'Solo servicio al cliente o un asesor técnico pueden ver la lista de asesores.';
  end if;
  return query
    select p.id, coalesce(nullif(btrim(p.nombre), ''), p.email)
      from public.rec_alcances a
      join public.rec_usuarios u on u.id = a.usuario_id and u.activo
      join public.profiles p on p.id = u.id and p.activo
     where a.rol = 'asesor_tecnico'
     order by 2;
end
$$;
revoke all on function public.rec_asesores() from public, anon;
grant execute on function public.rec_asesores() to authenticated;
