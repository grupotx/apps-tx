-- Reclamos, Tarea 4: motor del flujo — ingreso, derivación, verificación y decisión.
-- Cada función pública es security definer (set search_path = ''), valida rol/alcance con auth.uid(), bloquea la fila del
-- reclamo con "for update", revalida el estado bajo ese bloqueo y deja un evento en rec_eventos por cada paso.
-- Si el estado cambió mientras tanto, falla con "El reclamo ya cambió de estado: está en <estado>" y no escribe nada.
-- El cliente no ejecuta las funciones internas (app.*); ni anon ninguna.

-- ───────────────────────── Internas ─────────────────────────
create or replace function app.rec_estado_txt(p_estado text)
returns text language sql immutable set search_path = ''
as $$
  select case p_estado
    when 'ingresado' then 'Ingresado' when 'derivado' then 'Derivado' when 'en_verificacion' then 'En verificación'
    when 'aprobado' then 'Aprobado' when 'rechazado' then 'Rechazado' when 'solucion_definida' then 'Solución definida'
    when 'comunicado' then 'Comunicado al cliente' when 'cerrado' then 'Cerrado' when 'anulado' then 'Anulado'
    else coalesce(p_estado, '') end
$$;

-- Servicio al cliente (o administrador central): hace lo mismo en el flujo.
create or replace function app.rec_es_servicio()
returns boolean language sql stable security definer set search_path = ''
as $$
  select app.tiene_rol(variadic array['admin'])
      or exists (select 1 from app.rec_alcances_de(auth.uid()) a where a.rol = 'servicio_cliente')
$$;

create or replace function app.rec_exigir_acceso()
returns void language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not app.rec_activo() then
    raise exception 'No tienes acceso al módulo de Reclamos.';
  end if;
end
$$;

-- Bloquea y devuelve el reclamo (se mantiene hasta el fin de la transacción).
create or replace function app.rec_bloquear(p_id uuid)
returns public.rec_reclamos language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  select * into r from public.rec_reclamos where id = p_id for update;
  if not found then raise exception 'El reclamo no existe.'; end if;
  return r;
end
$$;

-- Quién decide: calidad → asesor técnico (el asignado, o cualquiera si aún no hay asesor);
-- otras áreas → el encargado de esa área (y de esa planta si el área es calidad o producción).
-- Servicio al cliente, el administrador, el encargado de calidad y la gerencia no deciden por su rol.
create or replace function app.rec_puede_decidir(r public.rec_reclamos)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or r.area_destino is null then return false; end if;
  if r.area_destino = 'calidad' then
    return exists (select 1 from app.rec_alcances_de(v_uid) a where a.rol = 'asesor_tecnico')
       and (r.asesor_id is null or r.asesor_id = v_uid);
  end if;
  return exists (select 1 from app.rec_alcances_de(v_uid) a
                  where a.rol = 'encargado_area' and a.area = r.area_destino
                    and (r.area_destino <> 'produccion' or a.planta = r.planta_destino));
end
$$;

-- La transición: valida el estado esperado bajo bloqueo, cambia el estado y escribe el evento.
create or replace function app.rec_mover(p_id uuid, p_desde text[], p_a text, p_tipo text, p_nota text, p_detalle jsonb)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_estado text;
begin
  select estado into v_estado from public.rec_reclamos where id = p_id for update;
  if not found then raise exception 'El reclamo no existe.'; end if;
  if not (v_estado = any (p_desde)) then
    raise exception 'El reclamo ya cambió de estado: está en %.', app.rec_estado_txt(v_estado);
  end if;
  update public.rec_reclamos set estado = p_a where id = p_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario, nota, detalle)
    values (p_id, p_tipo, v_estado, p_a, auth.uid(), nullif(btrim(coalesce(p_nota, '')), ''), p_detalle);
end
$$;

revoke all on function app.rec_estado_txt(text) from public, anon, authenticated;
revoke all on function app.rec_es_servicio() from public, anon, authenticated;
revoke all on function app.rec_exigir_acceso() from public, anon, authenticated;
revoke all on function app.rec_bloquear(uuid) from public, anon, authenticated;
revoke all on function app.rec_puede_decidir(public.rec_reclamos) from public, anon, authenticated;
revoke all on function app.rec_mover(uuid, text[], text, text, text, jsonb) from public, anon, authenticated;

-- ───────────────────────── Ingreso ─────────────────────────
-- Vendedor (cliente visible para él: lectura de clientes del CRM, hoy abierta a vendedor/técnico/supervisor/admin),
-- servicio al cliente (cualquier cliente) o administrador. Exige producto si el motivo lo requiere; la planta sale del producto.
create or replace function public.rec_crear(
  p_cliente_id uuid, p_producto text, p_motivo text, p_descripcion text, p_fecha_recepcion date, p_datos jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  m public.rec_motivos;
  v_prod text := nullif(btrim(coalesce(p_producto, '')), '');
  v_planta text;
  v_datos jsonb := coalesce(p_datos, '{}'::jsonb);
  v_id uuid;
begin
  perform app.rec_exigir_acceso();
  if p_cliente_id is null or not exists (select 1 from public.crm_clients where id = p_cliente_id) then
    raise exception 'El cliente no existe.';
  end if;
  if not (app.rec_es_servicio() or public.crm_can_see_client(p_cliente_id)
          or app.tiene_rol(variadic array['vendedor', 'tecnico', 'supervisor', 'admin'])) then
    raise exception 'No puedes ingresar reclamos de este cliente.';
  end if;
  select * into m from public.rec_motivos where id = p_motivo and activo;
  if not found then raise exception 'El motivo elegido no existe o está inactivo.'; end if;
  if m.requiere_producto and v_prod is null then raise exception 'Este motivo exige indicar el producto.'; end if;
  if v_prod is not null then
    select p.planta into v_planta from public.crm_products p where p.code = v_prod;
    if not found then raise exception 'El producto indicado no existe.'; end if;
  end if;
  if nullif(btrim(coalesce(p_descripcion, '')), '') is null then raise exception 'Escribe la descripción del reclamo.'; end if;
  if p_fecha_recepcion is null then raise exception 'Indica la fecha de recepción.'; end if;
  if p_fecha_recepcion > (now() at time zone 'America/Santiago')::date then
    raise exception 'La fecha de recepción no puede ser futura.';
  end if;
  if jsonb_typeof(v_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
  if length(v_datos::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;

  insert into public.rec_reclamos (cliente_id, producto, planta, motivo, descripcion, fecha_recepcion, datos, creado_por)
    values (p_cliente_id, v_prod, v_planta, m.id, btrim(p_descripcion), p_fecha_recepcion, v_datos, v_uid)
    returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario) values (v_id, 'creado', null, 'ingresado', v_uid);
  return v_id;
end
$$;

-- ───────────────────────── Derivación ─────────────────────────
-- Servicio al cliente o admin; desde ingresado, derivado o en_verificacion (re-derivar). Calidad y producción exigen planta
-- (la del reclamo por defecto, corregible); re-derivar suelta al asesor y el informe (queda en el detalle del evento).
create or replace function public.rec_derivar(p_id uuid, p_area text, p_planta text default null, p_nota text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_planta text;
  v_det jsonb;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede derivar un reclamo.'; end if;
  if p_area is null or p_area not in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial') then
    raise exception 'El área elegida no es válida.';
  end if;
  if p_planta is not null and p_planta not in ('pinturas', 'morteros', 'adhesivos', 'cementos') then
    raise exception 'La planta elegida no es válida.';
  end if;
  if p_area in ('calidad', 'produccion') then
    v_planta := coalesce(p_planta, r.planta);
    if v_planta is null then
      raise exception 'Este reclamo no tiene planta (su producto no la define o el motivo no lleva producto): indica la planta para derivarlo a %.',
        case p_area when 'calidad' then 'Calidad' else 'Producción' end;
    end if;
  end if;
  v_det := jsonb_build_object('area', p_area, 'planta', v_planta);
  if r.area_destino is not null then
    v_det := v_det || jsonb_build_object('area_anterior', r.area_destino, 'planta_anterior', r.planta_destino);
  end if;
  if r.estado = 'en_verificacion' then
    v_det := v_det || jsonb_build_object('asesor_anterior', r.asesor_id, 'informe_anterior', r.informe);
  end if;
  perform app.rec_mover(p_id, array['ingresado', 'derivado', 'en_verificacion'], 'derivado', 'derivado', p_nota, v_det);
  update public.rec_reclamos
     set area_destino = p_area, planta_destino = v_planta, asesor_id = null, informe = null, visita_registro_id = null
   where id = p_id;
end
$$;

-- El encargado del área (o el asesor técnico en calidad) responde "no es mío": vuelve a ingresado y se limpia el destino.
create or replace function public.rec_devolver(p_id uuid, p_nota text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_puede_decidir(r) then
    raise exception 'Solo quien responde por el área del reclamo puede devolverlo.';
  end if;
  if nullif(btrim(coalesce(p_nota, '')), '') is null then raise exception 'Explica por qué no corresponde a tu área.'; end if;
  perform app.rec_mover(p_id, array['derivado'], 'ingresado', 'devuelto', p_nota,
    jsonb_build_object('area_anterior', r.area_destino, 'planta_anterior', r.planta_destino));
  update public.rec_reclamos set area_destino = null, planta_destino = null, asesor_id = null where id = p_id;
end
$$;

-- ───────────────────────── Verificación (solo calidad) ─────────────────────────
create or replace function public.rec_pedir_verificacion(p_id uuid, p_asesor uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede pedir una visita técnica.'; end if;
  if r.area_destino is distinct from 'calidad' then raise exception 'Solo los reclamos de calidad pueden pedir una visita técnica.'; end if;
  if p_asesor is null or not exists (select 1 from app.rec_alcances_de(p_asesor) a where a.rol = 'asesor_tecnico') then
    raise exception 'La persona elegida no es asesor técnico.';
  end if;
  perform app.rec_mover(p_id, array['derivado'], 'en_verificacion', 'verificacion_pedida', null, jsonb_build_object('asesor', p_asesor));
  update public.rec_reclamos set asesor_id = p_asesor where id = p_id;
end
$$;

create or replace function public.rec_reasignar_asesor(p_id uuid, p_asesor uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_uid uuid := auth.uid();
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not (app.rec_es_servicio()
          or (r.asesor_id = v_uid and exists (select 1 from app.rec_alcances_de(v_uid) a where a.rol = 'asesor_tecnico'))) then
    raise exception 'Solo servicio al cliente o el asesor asignado pueden reasignar el reclamo.';
  end if;
  if p_asesor is null or not exists (select 1 from app.rec_alcances_de(p_asesor) a where a.rol = 'asesor_tecnico') then
    raise exception 'La persona elegida no es asesor técnico.';
  end if;
  perform app.rec_mover(p_id, array['en_verificacion'], 'en_verificacion', 'asesor_reasignado', null,
    jsonb_build_object('de', r.asesor_id, 'a', p_asesor));
  update public.rec_reclamos set asesor_id = p_asesor where id = p_id;
end
$$;

create or replace function public.rec_registrar_informe(p_id uuid, p_texto text, p_visita_registro_id uuid default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_uid uuid := auth.uid();
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not (r.asesor_id = v_uid and exists (select 1 from app.rec_alcances_de(v_uid) a where a.rol = 'asesor_tecnico')) then
    raise exception 'Solo el asesor técnico asignado puede registrar el informe.';
  end if;
  if nullif(btrim(coalesce(p_texto, '')), '') is null then raise exception 'Escribe el informe de calidad.'; end if;
  if p_visita_registro_id is not null and not exists (select 1 from public.registros where id = p_visita_registro_id) then
    raise exception 'La visita indicada no existe.';
  end if;
  perform app.rec_mover(p_id, array['en_verificacion'], 'en_verificacion', 'informe', null,
    jsonb_build_object('registro', p_visita_registro_id, 'informe_anterior', r.informe));
  update public.rec_reclamos
     set informe = btrim(p_texto), visita_registro_id = coalesce(p_visita_registro_id, visita_registro_id)
   where id = p_id;
end
$$;

-- ───────────────────────── Decisión ─────────────────────────
-- Calidad: asesor técnico (el asignado, o cualquiera si no hay) desde derivado o en_verificacion (haya o no visita).
-- Otras áreas: encargado de esa área (y planta) desde derivado. Razones obligatorias.
create or replace function public.rec_decidir(p_id uuid, p_decision text, p_razones text)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_puede_decidir(r) then
    raise exception 'No tienes permiso para decidir este reclamo: decide el asesor técnico en calidad, o el encargado del área (y planta) en las demás.';
  end if;
  if p_decision is null or p_decision not in ('aprobado', 'rechazado') then raise exception 'La decisión debe ser aprobado o rechazado.'; end if;
  if nullif(btrim(coalesce(p_razones, '')), '') is null then raise exception 'Escribe las razones de la decisión.'; end if;
  perform app.rec_mover(p_id,
    case when r.area_destino = 'calidad' then array['derivado', 'en_verificacion'] else array['derivado'] end,
    p_decision, 'decidido', p_razones, null);
  update public.rec_reclamos
     set decision = p_decision, razones = btrim(p_razones), decidido_por = auth.uid(), decidido_en = now()
   where id = p_id;
end
$$;

-- ───────────────────────── Adjuntos ─────────────────────────
-- Registra un archivo ya subido a reclamos/<id>/… por quien puede ver el reclamo; es idempotente por ruta.
create or replace function public.rec_adjuntar(p_id uuid, p_tipo text, p_ruta text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_id uuid;
begin
  perform app.rec_exigir_acceso();
  if not app.rec_puede_ver(p_id) then raise exception 'No tienes acceso a este reclamo.'; end if;
  if p_tipo is null or p_tipo not in ('foto', 'informe', 'otro') then raise exception 'El tipo de adjunto no es válido.'; end if;
  if p_ruta is null or left(p_ruta, length(p_id::text) + 1) <> p_id::text || '/' or position('..' in p_ruta) > 0 then
    raise exception 'La ruta del archivo debe estar dentro de la carpeta del reclamo.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'reclamos' and name = p_ruta) then
    raise exception 'El archivo todavía no está subido.';
  end if;
  r := app.rec_bloquear(p_id);
  select a.id into v_id from public.rec_adjuntos a where a.reclamo_id = p_id and a.ruta = p_ruta;
  if found then return v_id; end if;
  insert into public.rec_adjuntos (reclamo_id, tipo, ruta, subido_por) values (p_id, p_tipo, p_ruta, auth.uid()) returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario, nota, detalle)
    values (p_id, 'adjunto', r.estado, r.estado, auth.uid(), p_tipo, jsonb_build_object('ruta', p_ruta));
  return v_id;
end
$$;

-- ───────────────────────── Asesores técnicos (para elegir uno al pedir la visita) ─────────────────────────
create or replace function public.rec_asesores()
returns table(id uuid, nombre text) language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.rec_exigir_acceso();
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede ver la lista de asesores.'; end if;
  return query
    select p.id, coalesce(nullif(btrim(p.nombre), ''), p.email)
      from public.rec_alcances a
      join public.rec_usuarios u on u.id = a.usuario_id and u.activo
      join public.profiles p on p.id = u.id and p.activo
     where a.rol = 'asesor_tecnico'
     order by 2;
end
$$;

-- ───────────────────────── Permisos de ejecución ─────────────────────────
revoke all on function public.rec_crear(uuid, text, text, text, date, jsonb) from public, anon;
revoke all on function public.rec_derivar(uuid, text, text, text) from public, anon;
revoke all on function public.rec_devolver(uuid, text) from public, anon;
revoke all on function public.rec_pedir_verificacion(uuid, uuid) from public, anon;
revoke all on function public.rec_reasignar_asesor(uuid, uuid) from public, anon;
revoke all on function public.rec_registrar_informe(uuid, text, uuid) from public, anon;
revoke all on function public.rec_decidir(uuid, text, text) from public, anon;
revoke all on function public.rec_adjuntar(uuid, text, text) from public, anon;
revoke all on function public.rec_asesores() from public, anon;
grant execute on function public.rec_crear(uuid, text, text, text, date, jsonb) to authenticated;
grant execute on function public.rec_derivar(uuid, text, text, text) to authenticated;
grant execute on function public.rec_devolver(uuid, text) to authenticated;
grant execute on function public.rec_pedir_verificacion(uuid, uuid) to authenticated;
grant execute on function public.rec_reasignar_asesor(uuid, uuid) to authenticated;
grant execute on function public.rec_registrar_informe(uuid, text, uuid) to authenticated;
grant execute on function public.rec_decidir(uuid, text, text) to authenticated;
grant execute on function public.rec_adjuntar(uuid, text, text) to authenticated;
grant execute on function public.rec_asesores() to authenticated;
