-- Reclamos, Tarea 7 (prerrequisito de lectura): nombres para mostrar a quien solo tiene el módulo Reclamos.
-- Por RLS, quien no tiene CRM ni rol Silos no lee crm_clients, crm_products ni profiles; sin esto la bandeja y el
-- ingreso quedarían sin nombres. Todo es de solo lectura y solo para usuarios del módulo (app.rec_exigir_acceso()):
--   · rec_reclamos.cliente_nombre / producto_nombre: copia del nombre al ingresar (estable y visible para cualquiera
--     que pueda ver el reclamo);
--   · rec_buscar_clientes(q): búsqueda para el ingreso (servicio al cliente y quien lee clientes en el CRM/Silos);
--   · rec_productos(): catálogo activo con su planta (sin precios);
--   · rec_nombres(ids): nombre de personas del módulo (no expone perfiles ajenos al módulo).

alter table public.rec_reclamos add column if not exists cliente_nombre text, add column if not exists producto_nombre text;

-- rec_crear: igual que en la Tarea 4, más la copia de los nombres.
create or replace function public.rec_crear(
  p_cliente_id uuid, p_producto text, p_motivo text, p_descripcion text, p_fecha_recepcion date, p_datos jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  m public.rec_motivos;
  v_prod text := nullif(btrim(coalesce(p_producto, '')), '');
  v_planta text;
  v_cli_nombre text;
  v_prod_nombre text;
  v_datos jsonb := coalesce(p_datos, '{}'::jsonb);
  v_id uuid;
begin
  perform app.rec_exigir_acceso();
  select coalesce(nullif(btrim(c.name), ''), c.razon) into v_cli_nombre from public.crm_clients c where c.id = p_cliente_id;
  if p_cliente_id is null or not found then raise exception 'El cliente no existe.'; end if;
  if not (app.rec_es_servicio() or public.crm_can_see_client(p_cliente_id)
          or app.tiene_rol(variadic array['vendedor', 'tecnico', 'supervisor', 'admin'])) then
    raise exception 'No puedes ingresar reclamos de este cliente.';
  end if;
  select * into m from public.rec_motivos where id = p_motivo and activo;
  if not found then raise exception 'El motivo elegido no existe o está inactivo.'; end if;
  if m.requiere_producto and v_prod is null then raise exception 'Este motivo exige indicar el producto.'; end if;
  if v_prod is not null then
    select p.planta, p.name into v_planta, v_prod_nombre from public.crm_products p where p.code = v_prod;
    if not found then raise exception 'El producto indicado no existe.'; end if;
  end if;
  if nullif(btrim(coalesce(p_descripcion, '')), '') is null then raise exception 'Escribe la descripción del reclamo.'; end if;
  if p_fecha_recepcion is null then raise exception 'Indica la fecha de recepción.'; end if;
  if p_fecha_recepcion > (now() at time zone 'America/Santiago')::date then
    raise exception 'La fecha de recepción no puede ser futura.';
  end if;
  if jsonb_typeof(v_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
  if length(v_datos::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;

  insert into public.rec_reclamos (cliente_id, cliente_nombre, producto, producto_nombre, planta, motivo, descripcion, fecha_recepcion, datos, creado_por)
    values (p_cliente_id, v_cli_nombre, v_prod, v_prod_nombre, v_planta, m.id, btrim(p_descripcion), p_fecha_recepcion, v_datos, v_uid)
    returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario) values (v_id, 'creado', null, 'ingresado', v_uid);
  return v_id;
end
$$;

create or replace function public.rec_buscar_clientes(p_q text)
returns table(id uuid, nombre text, razon text, rut text, comuna text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_todos boolean;
begin
  perform app.rec_exigir_acceso();
  if length(v_q) < 2 then return; end if;
  v_todos := app.rec_es_servicio() or app.tiene_rol(variadic array['vendedor', 'tecnico', 'supervisor', 'admin']);
  return query
    select c.id, coalesce(nullif(btrim(c.name), ''), c.razon), c.razon, c.rut, c.comuna
      from public.crm_clients c
     where (strpos(lower(coalesce(c.name, '')), v_q) > 0 or strpos(lower(coalesce(c.razon, '')), v_q) > 0
            or strpos(lower(coalesce(c.rut, '')), v_q) > 0 or strpos(lower(coalesce(c.codigo_sap, '')), v_q) > 0)
       and (v_todos or public.crm_can_see_client(c.id))
     order by 2
     limit 20;
end
$$;

create or replace function public.rec_productos()
returns table(code text, nombre text, familia text, planta text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.rec_exigir_acceso();
  return query select p.code, p.name, p.family, p.planta from public.crm_products p where p.active order by p.name;
end
$$;

create or replace function public.rec_nombres(p_ids uuid[])
returns table(id uuid, nombre text)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.rec_exigir_acceso();
  if cardinality(coalesce(p_ids, '{}'::uuid[])) > 200 then raise exception 'Demasiados ids (máximo 200).'; end if;
  return query
    select p.id, coalesce(nullif(btrim(p.nombre), ''), split_part(p.email, '@', 1))
      from public.profiles p
     where p.id = any (coalesce(p_ids, '{}'::uuid[]))
       and (p.rol::text = 'admin' or exists (select 1 from public.rec_usuarios u where u.id = p.id));
end
$$;

revoke all on function public.rec_crear(uuid, text, text, text, date, jsonb) from public, anon;
revoke all on function public.rec_buscar_clientes(text) from public, anon;
revoke all on function public.rec_productos() from public, anon;
revoke all on function public.rec_nombres(uuid[]) from public, anon;
grant execute on function public.rec_crear(uuid, text, text, text, date, jsonb) to authenticated;
grant execute on function public.rec_buscar_clientes(text) to authenticated;
grant execute on function public.rec_productos() to authenticated;
grant execute on function public.rec_nombres(uuid[]) to authenticated;
