-- Entregas modo offline (fase 1): hora real del evento (p_at) e idempotencia del cierre.
-- p_at es opcional (default null): la app publicada que no lo envía sigue funcionando.

-- Hora informada por el celular, aceptada solo dentro de [now()-72h, now()+10min]; si no, now().
create or replace function app.ent_hora_valida(p timestamptz)
returns timestamptz
language sql
stable
set search_path to ''
as $$
  select case
    when p is not null and p between now() - interval '72 hours' and now() + interval '10 minutes' then p
    else now()
  end
$$;
revoke all on function app.ent_hora_valida(timestamptz) from public, anon, authenticated;

drop function if exists public.ent_marcar_llegada(uuid, text, double precision, double precision, double precision);
drop function if exists public.ent_cerrar_entrega(uuid, text, text[], text, text, text, text, text, text, double precision, double precision, jsonb);

create function public.ent_marcar_llegada(p_guia uuid, p_patente text, p_lat double precision, p_lng double precision, p_precision double precision, p_at timestamptz default null)
 returns public.ent_entregas
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare g public.ent_guias; u public.ent_usuarios; e public.ent_entregas;
begin
  select * into u from public.ent_usuarios where id = auth.uid() and activo and rol in ('chofer','admin');
  if not found then raise exception 'Usuario no habilitado como chofer'; end if;
  select * into g from public.ent_guias where id = p_guia for update;
  if not found or g.chofer_id is distinct from auth.uid() then raise exception 'Guía no asignada a este chofer'; end if;
  if g.estado not in ('asignada','en_destino') then raise exception 'La guía ya fue cerrada'; end if;
  if coalesce(trim(p_patente),'') = '' then raise exception 'Debe ingresar la patente'; end if;
  select * into e from public.ent_entregas where guia_id = g.id;
  if not found then
    insert into public.ent_entregas (guia_id, chofer_id, chofer_nombre, patente, llegada_at, llegada_lat, llegada_lng, llegada_precision_m, distancia_destino_m)
    values (g.id, u.id, u.nombre, upper(trim(p_patente)), app.ent_hora_valida(p_at), p_lat, p_lng, p_precision, app.ent_distancia_m(p_lat, p_lng, g.dest_lat, g.dest_lng))
    returning * into e;
  end if;
  update public.ent_guias set estado = 'en_destino' where id = g.id and estado = 'asignada';
  if p_lat is not null then
    insert into public.ent_posiciones (chofer_id, patente, lat, lng, precision_m, fuente) values (u.id, upper(trim(p_patente)), p_lat, p_lng, p_precision, 'celular');
  end if;
  return e;
end $function$;

create function public.ent_cerrar_entrega(p_guia uuid, p_resultado text, p_fotos text[], p_receptor_nombre text, p_receptor_rut text, p_receptor_cargo text, p_receptor_telefono text, p_firma_path text, p_observacion text, p_lat double precision, p_lng double precision, p_devoluciones jsonb default '[]'::jsonb, p_at timestamptz default null)
 returns public.ent_entregas
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare g public.ent_guias; e public.ent_entregas; d jsonb; p public.ent_productos;
begin
  select * into g from public.ent_guias where id = p_guia for update;
  if not found or g.chofer_id is distinct from auth.uid() then raise exception 'Guía no asignada a este chofer'; end if;
  -- Reintento del mismo cierre (misma firma): devolver la fila existente sin tocar nada.
  if g.estado in ('entregada','entregada_con_devolucion','rechazada') then
    select * into e from public.ent_entregas where guia_id = g.id;
    if found and e.firma_path is not distinct from p_firma_path and coalesce(p_firma_path,'') <> '' then return e; end if;
    raise exception 'La guía ya fue cerrada';
  end if;
  if g.estado <> 'en_destino' then raise exception 'Primero debe marcar la llegada (estado actual: %)', g.estado; end if;
  if p_resultado not in ('entregada','entregada_con_devolucion','rechazada') then raise exception 'Resultado inválido'; end if;
  if coalesce(array_length(p_fotos,1),0) = 0 then raise exception 'Debe adjuntar al menos una foto'; end if;
  if coalesce(trim(p_receptor_nombre),'') = '' then raise exception 'Falta el nombre de quien recibe'; end if;
  if coalesce(p_firma_path,'') = '' then raise exception 'Falta la firma'; end if;
  if p_resultado = 'entregada_con_devolucion' and jsonb_array_length(coalesce(p_devoluciones,'[]'::jsonb)) = 0 then
    raise exception 'Debe detallar los productos devueltos'; end if;

  update public.ent_entregas set fotos = p_fotos, receptor_nombre = trim(p_receptor_nombre), receptor_rut = p_receptor_rut,
    receptor_cargo = p_receptor_cargo, receptor_telefono = p_receptor_telefono, firma_path = p_firma_path,
    observacion = p_observacion, resultado = p_resultado, cierre_at = app.ent_hora_valida(p_at), cierre_lat = p_lat, cierre_lng = p_lng
  where guia_id = g.id returning * into e;

  for d in select * from jsonb_array_elements(coalesce(p_devoluciones,'[]'::jsonb)) loop
    select * into p from public.ent_productos where codigo = d->>'codigo';
    if not found then raise exception 'Producto % no existe', d->>'codigo'; end if;
    if coalesce(d->>'motivo','') = '' then raise exception 'Falta motivo de devolución para %', p.codigo; end if;
    insert into public.ent_devoluciones (entrega_id, guia_id, producto_codigo, producto_descripcion, cantidad, unidad, motivo, comentario)
    values (e.id, g.id, p.codigo, p.descripcion, (d->>'cantidad')::numeric, p.unidad, d->>'motivo', nullif(d->>'comentario',''));
  end loop;

  update public.ent_guias set estado = p_resultado where id = g.id;
  return e;
end $function$;

-- Mismos permisos que tenían las firmas anteriores: postgres (dueño), authenticated, service_role.
revoke all on function public.ent_marcar_llegada(uuid, text, double precision, double precision, double precision, timestamptz) from public, anon;
revoke all on function public.ent_cerrar_entrega(uuid, text, text[], text, text, text, text, text, text, double precision, double precision, jsonb, timestamptz) from public, anon;
grant execute on function public.ent_marcar_llegada(uuid, text, double precision, double precision, double precision, timestamptz) to authenticated, service_role;
grant execute on function public.ent_cerrar_entrega(uuid, text, text[], text, text, text, text, text, text, double precision, double precision, jsonb, timestamptz) to authenticated, service_role;
