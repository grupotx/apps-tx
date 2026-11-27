-- Reclamos: ajustes de la revisión independiente de la capa de datos (Tareas 1-6).
--  1. Token de versión: cada acción acepta `p_version` (= rec_reclamos.actualizado_en tal como lo vio quien abrió la
--     pantalla). Si el reclamo se modificó después, falla ("fue modificado por otra persona…") aunque el estado sea el
--     mismo (re-derivar, reasignar asesor, informe) o haya cambiado el destino. Sin token funciona como antes.
--     actualizado_en pasa a clock_timestamp() para que distinga cambios dentro de una misma transacción.
--  2. Calidad y Producción exigen producto (spec); rec_actualizar completa producto y "datos adicionales" después del ingreso.
--  3. rec_ve_todo: gerencia/servicio al cliente/admin se evalúan una sola vez por consulta en las políticas de lectura.
--  4. La planta del producto sigue a su familia mientras nadie la haya corregido a mano.
--  5. Fecha de recepción de hasta un año atrás; rec_adjuntar no acepta archivos en anulados; área sugerida en motivos;
--     para Calidad se asigna "encargado de calidad", no "encargado de área".
-- Las firmas nuevas llevan `p_version timestamptz default null` al final; se eliminan las firmas viejas para no dejar
-- sobrecargas ambiguas para PostgREST.

-- ───────────────────────── Versión del reclamo ─────────────────────────
create or replace function public.rec_reclamos_touch()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.actualizado_en := clock_timestamp();
  return new;
end
$$;

drop function if exists app.rec_mover(uuid, text[], text, text, text, jsonb);
create or replace function app.rec_mover(p_id uuid, p_desde text[], p_a text, p_tipo text, p_nota text, p_detalle jsonb, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_estado text;
  v_act timestamptz;
begin
  select estado, actualizado_en into v_estado, v_act from public.rec_reclamos where id = p_id for update;
  if not found then raise exception 'El reclamo no existe.'; end if;
  if not (v_estado = any (p_desde)) then
    raise exception 'El reclamo ya cambió de estado: está en %.', app.rec_estado_txt(v_estado);
  end if;
  if p_version is not null and v_act is distinct from p_version then
    raise exception 'El reclamo fue modificado por otra persona mientras lo mirabas. Actualiza la pantalla y revisa antes de continuar.';
  end if;
  update public.rec_reclamos set estado = p_a where id = p_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario, nota, detalle)
    values (p_id, p_tipo, v_estado, p_a, auth.uid(), nullif(btrim(coalesce(p_nota, '')), ''), p_detalle);
end
$$;
revoke all on function app.rec_mover(uuid, text[], text, text, text, jsonb, timestamptz) from public, anon, authenticated;

-- ───────────────────────── Ingreso: fecha de hasta un año atrás ─────────────────────────
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
  v_hoy date := (now() at time zone 'America/Santiago')::date;
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
  if p_fecha_recepcion > v_hoy then raise exception 'La fecha de recepción no puede ser futura.'; end if;
  if p_fecha_recepcion < v_hoy - 365 then raise exception 'La fecha de recepción tiene más de un año de antigüedad; revísala.'; end if;
  if jsonb_typeof(v_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
  if length(v_datos::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;

  insert into public.rec_reclamos (cliente_id, cliente_nombre, producto, producto_nombre, planta, motivo, descripcion, fecha_recepcion, datos, creado_por)
    values (p_cliente_id, v_cli_nombre, v_prod, v_prod_nombre, v_planta, m.id, btrim(p_descripcion), p_fecha_recepcion, v_datos, v_uid)
    returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario) values (v_id, 'creado', null, 'ingresado', v_uid);
  return v_id;
end
$$;

-- ───────────────────────── Completar producto y datos adicionales ─────────────────────────
-- Servicio al cliente/admin (producto y datos, en cualquier estado salvo cerrado/anulado) y el asesor asignado mientras
-- verifica (solo datos). Los datos se mezclan con los existentes; un valor vacío quita la clave. El evento guarda lo anterior.
create or replace function public.rec_actualizar(p_id uuid, p_producto text default null, p_datos jsonb default null, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_uid uuid := auth.uid();
  v_sc boolean;
  v_asesor boolean;
  v_prod text := nullif(btrim(coalesce(p_producto, '')), '');
  v_planta text;
  v_prod_nombre text;
  v_merged jsonb;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  v_sc := app.rec_es_servicio();
  v_asesor := r.estado = 'en_verificacion' and r.asesor_id = v_uid
              and exists (select 1 from app.rec_alcances_de(v_uid) a where a.rol = 'asesor_tecnico');
  if not (v_sc or v_asesor) then
    raise exception 'Solo servicio al cliente, o el asesor asignado durante la verificación, pueden completar los datos del reclamo.';
  end if;
  if r.estado in ('cerrado', 'anulado') then raise exception 'Un reclamo cerrado o anulado no se puede modificar.'; end if;
  if v_prod is not null and not v_sc then raise exception 'Solo servicio al cliente puede cambiar el producto.'; end if;
  if v_prod is null and p_datos is null then raise exception 'No hay nada que actualizar.'; end if;
  if v_prod is not null then
    select p.planta, p.name into v_planta, v_prod_nombre from public.crm_products p where p.code = v_prod;
    if not found then raise exception 'El producto indicado no existe.'; end if;
  end if;
  v_merged := r.datos;
  if p_datos is not null then
    if jsonb_typeof(p_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_merged
      from jsonb_each(r.datos || p_datos) e
     where e.value <> '""'::jsonb and e.value <> 'null'::jsonb;
    if length(v_merged::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;
  end if;
  perform app.rec_mover(p_id,
    array['ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado'],
    r.estado, 'datos_actualizados', null,
    jsonb_build_object('producto_anterior', r.producto, 'producto_nuevo', v_prod, 'datos_anteriores', r.datos), p_version);
  update public.rec_reclamos
     set producto = coalesce(v_prod, producto),
         producto_nombre = case when v_prod is not null then v_prod_nombre else producto_nombre end,
         planta = case when v_prod is not null then v_planta else planta end,
         datos = v_merged
   where id = p_id;
end
$$;

-- ───────────────────────── Derivación y verificación (con versión) ─────────────────────────
drop function if exists public.rec_derivar(uuid, text, text, text);
create or replace function public.rec_derivar(p_id uuid, p_area text, p_planta text default null, p_nota text default null, p_version timestamptz default null)
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
    if r.producto is null then
      raise exception 'Un reclamo de % necesita el producto (de él sale la planta): complétalo antes de derivarlo.',
        case p_area when 'calidad' then 'Calidad' else 'Producción' end;
    end if;
    v_planta := coalesce(p_planta, r.planta);
    if v_planta is null then
      raise exception 'Este reclamo no tiene planta: indica la planta para derivarlo a %.',
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
  perform app.rec_mover(p_id, array['ingresado', 'derivado', 'en_verificacion'], 'derivado', 'derivado', p_nota, v_det, p_version);
  update public.rec_reclamos
     set area_destino = p_area, planta_destino = v_planta, asesor_id = null, informe = null, visita_registro_id = null
   where id = p_id;
end
$$;

drop function if exists public.rec_devolver(uuid, text);
create or replace function public.rec_devolver(p_id uuid, p_nota text, p_version timestamptz default null)
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
    jsonb_build_object('area_anterior', r.area_destino, 'planta_anterior', r.planta_destino), p_version);
  update public.rec_reclamos set area_destino = null, planta_destino = null, asesor_id = null where id = p_id;
end
$$;

drop function if exists public.rec_pedir_verificacion(uuid, uuid);
create or replace function public.rec_pedir_verificacion(p_id uuid, p_asesor uuid, p_version timestamptz default null)
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
  perform app.rec_mover(p_id, array['derivado'], 'en_verificacion', 'verificacion_pedida', null, jsonb_build_object('asesor', p_asesor), p_version);
  update public.rec_reclamos set asesor_id = p_asesor where id = p_id;
end
$$;

drop function if exists public.rec_reasignar_asesor(uuid, uuid);
create or replace function public.rec_reasignar_asesor(p_id uuid, p_asesor uuid, p_version timestamptz default null)
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
    jsonb_build_object('de', r.asesor_id, 'a', p_asesor), p_version);
  update public.rec_reclamos set asesor_id = p_asesor where id = p_id;
end
$$;

drop function if exists public.rec_registrar_informe(uuid, text, uuid);
create or replace function public.rec_registrar_informe(p_id uuid, p_texto text, p_visita_registro_id uuid default null, p_version timestamptz default null)
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
    jsonb_build_object('registro', p_visita_registro_id, 'informe_anterior', r.informe), p_version);
  update public.rec_reclamos
     set informe = btrim(p_texto), visita_registro_id = coalesce(p_visita_registro_id, visita_registro_id)
   where id = p_id;
end
$$;

drop function if exists public.rec_decidir(uuid, text, text);
create or replace function public.rec_decidir(p_id uuid, p_decision text, p_razones text, p_version timestamptz default null)
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
    p_decision, 'decidido', p_razones, null, p_version);
  update public.rec_reclamos
     set decision = p_decision, razones = btrim(p_razones), decidido_por = auth.uid(), decidido_en = now()
   where id = p_id;
end
$$;

-- ───────────────────────── Solución, comunicación, cierre, anular, reabrir (con versión) ─────────────────────────
drop function if exists public.rec_definir_solucion(uuid, text, text, bigint);
create or replace function public.rec_definir_solucion(p_id uuid, p_tipo text, p_detalle text, p_compensacion bigint, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede definir la solución.'; end if;
  if p_tipo is null or p_tipo not in ('nota_credito', 'reposicion', 'descuento', 'devolucion', 'asesoria', 'explicacion') then
    raise exception 'El tipo de solución no es válido.';
  end if;
  if p_compensacion is null then raise exception 'Indica el monto de la compensación (0 si no hay).'; end if;
  if p_compensacion < 0 then raise exception 'La compensación no puede ser negativa.'; end if;
  if p_tipo = 'explicacion' and p_compensacion > 0 then
    raise exception 'Una explicación sin compensación no puede llevar monto.';
  end if;
  perform app.rec_mover(p_id, array['aprobado', 'rechazado'], 'solucion_definida', 'solucion_definida', null,
    jsonb_build_object('solucion_tipo', p_tipo, 'compensacion', p_compensacion), p_version);
  update public.rec_reclamos
     set solucion_tipo = p_tipo, solucion_detalle = nullif(btrim(coalesce(p_detalle, '')), ''), compensacion = p_compensacion
   where id = p_id;
end
$$;

drop function if exists public.rec_comunicar(uuid, text, text);
create or replace function public.rec_comunicar(p_id uuid, p_mensaje text, p_canal text default null, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_canal text := nullif(btrim(coalesce(p_canal, '')), '');
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede registrar la comunicación al cliente.'; end if;
  if nullif(btrim(coalesce(p_mensaje, '')), '') is null then raise exception 'Escribe el mensaje que se comunicó al cliente.'; end if;
  if v_canal is not null and length(v_canal) > 40 then raise exception 'El canal es demasiado largo (máximo 40 caracteres).'; end if;
  perform app.rec_mover(p_id, array['solucion_definida'], 'comunicado', 'comunicado', null, jsonb_build_object('canal', v_canal), p_version);
  update public.rec_reclamos
     set mensaje_cliente = btrim(p_mensaje), canal = v_canal, comunicado_por = auth.uid(), comunicado_en = now()
   where id = p_id;
end
$$;

drop function if exists public.rec_cerrar(uuid);
create or replace function public.rec_cerrar(p_id uuid, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede cerrar un reclamo.'; end if;
  perform app.rec_mover(p_id, array['comunicado'], 'cerrado', 'cerrado', null, null, p_version);
  update public.rec_reclamos set cerrado_en = now() where id = p_id;
end
$$;

drop function if exists public.rec_corregir_compensacion(uuid, bigint, text);
create or replace function public.rec_corregir_compensacion(p_id uuid, p_monto bigint, p_motivo text, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede corregir la compensación.'; end if;
  if r.estado = 'anulado' then raise exception 'Un reclamo anulado no se puede modificar.'; end if;
  if r.estado not in ('solucion_definida', 'comunicado', 'cerrado') then
    raise exception 'La compensación se define al registrar la solución; aún no hay una que corregir.';
  end if;
  if r.estado = 'cerrado' and not app.tiene_rol(variadic array['admin']) then
    raise exception 'Después del cierre solo un administrador puede corregir la compensación.';
  end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then raise exception 'Explica el motivo de la corrección.'; end if;
  if p_monto is null then raise exception 'Indica el monto de la compensación.'; end if;
  if p_monto < 0 then raise exception 'La compensación no puede ser negativa.'; end if;
  if r.solucion_tipo = 'explicacion' and p_monto > 0 then
    raise exception 'Una explicación sin compensación no puede llevar monto.';
  end if;
  if p_monto = r.compensacion then raise exception 'El monto no cambió.'; end if;
  perform app.rec_mover(p_id, array['solucion_definida', 'comunicado', 'cerrado'], r.estado, 'compensacion_corregida', p_motivo,
    jsonb_build_object('monto_anterior', r.compensacion, 'monto_nuevo', p_monto), p_version);
  update public.rec_reclamos set compensacion = p_monto where id = p_id;
end
$$;

drop function if exists public.rec_anular(uuid, text);
create or replace function public.rec_anular(p_id uuid, p_motivo text, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede anular un reclamo.'; end if;
  if r.estado = 'cerrado' then raise exception 'Un reclamo cerrado no se puede anular; pide a un administrador que lo reabra.'; end if;
  if r.estado = 'anulado' then raise exception 'El reclamo ya está anulado.'; end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then raise exception 'Explica el motivo de la anulación.'; end if;
  perform app.rec_mover(p_id,
    array['ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado'],
    'anulado', 'anulado', p_motivo, jsonb_build_object('estado_anterior', r.estado), p_version);
end
$$;

drop function if exists public.rec_reabrir(uuid, text);
create or replace function public.rec_reabrir(p_id uuid, p_motivo text, p_version timestamptz default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_det jsonb;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.tiene_rol(variadic array['admin']) then raise exception 'Solo un administrador puede reabrir un reclamo.'; end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then raise exception 'Explica el motivo de la reapertura.'; end if;
  v_det := jsonb_build_object(
    'estado_anterior', r.estado, 'decision', r.decision, 'razones', r.razones, 'decidido_por', r.decidido_por, 'decidido_en', r.decidido_en,
    'solucion_tipo', r.solucion_tipo, 'solucion_detalle', r.solucion_detalle, 'compensacion', r.compensacion,
    'mensaje_cliente', r.mensaje_cliente, 'canal', r.canal, 'comunicado_por', r.comunicado_por, 'comunicado_en', r.comunicado_en,
    'cerrado_en', r.cerrado_en, 'area_destino', r.area_destino, 'planta_destino', r.planta_destino, 'asesor_id', r.asesor_id,
    'informe', r.informe, 'visita_registro_id', r.visita_registro_id);
  perform app.rec_mover(p_id, array['cerrado', 'anulado'], 'ingresado', 'reabierto', p_motivo, v_det, p_version);
  update public.rec_reclamos
     set decision = null, razones = null, decidido_por = null, decidido_en = null,
         solucion_tipo = null, solucion_detalle = null, compensacion = null,
         mensaje_cliente = null, canal = null, comunicado_por = null, comunicado_en = null, cerrado_en = null,
         area_destino = null, planta_destino = null, asesor_id = null, informe = null, visita_registro_id = null
   where id = p_id;
end
$$;

-- ───────────────────────── Adjuntos: no en anulados ─────────────────────────
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
  if r.estado = 'anulado' then raise exception 'Un reclamo anulado no admite nuevos archivos.'; end if;
  select a.id into v_id from public.rec_adjuntos a where a.reclamo_id = p_id and a.ruta = p_ruta;
  if found then return v_id; end if;
  insert into public.rec_adjuntos (reclamo_id, tipo, ruta, subido_por) values (p_id, p_tipo, p_ruta, auth.uid()) returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario, nota, detalle)
    values (p_id, 'adjunto', r.estado, r.estado, auth.uid(), p_tipo, jsonb_build_object('ruta', p_ruta));
  return v_id;
end
$$;

-- ───────────────────────── Alcances y motivos ─────────────────────────
create or replace function public.rec_set_alcance(p_usuario uuid, p_rol text, p_area text, p_planta text, p_activo boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_n int;
begin
  perform app.rec_exigir_acceso();
  if not app.tiene_rol(variadic array['admin']) then raise exception 'Solo un administrador puede cambiar los alcances.'; end if;
  if p_activo is null then raise exception 'Indica si el alcance se activa o se quita.'; end if;
  if p_rol is null or p_rol not in ('servicio_cliente', 'asesor_tecnico', 'encargado_area', 'encargado_calidad', 'gerencia') then
    raise exception 'El rol no es válido.';
  end if;
  if p_area is not null and p_area not in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial') then
    raise exception 'El área elegida no es válida.';
  end if;
  if p_planta is not null and p_planta not in ('pinturas', 'morteros', 'adhesivos', 'cementos') then
    raise exception 'La planta elegida no es válida.';
  end if;
  if p_rol = 'encargado_area' then
    if p_area is null then raise exception 'El encargado de área necesita un área.'; end if;
    if p_area = 'calidad' then
      raise exception 'Para Calidad asigna el rol «Encargado de calidad de planta» (informado) o «Asesor técnico» (decide), no «Encargado de área».';
    end if;
    if p_area = 'produccion' and p_planta is null then raise exception 'El área % exige una planta.', p_area; end if;
    if p_area <> 'produccion' and p_planta is not null then raise exception 'El área % no lleva planta.', p_area; end if;
  elsif p_rol = 'encargado_calidad' then
    if p_area is not null then raise exception 'El encargado de calidad no lleva área.'; end if;
    if p_planta is null then raise exception 'El encargado de calidad necesita una planta.'; end if;
  elsif p_area is not null or p_planta is not null then
    raise exception 'Este rol no lleva área ni planta.';
  end if;
  if not exists (select 1 from public.rec_usuarios where id = p_usuario) then
    raise exception 'La persona no tiene acceso al módulo de Reclamos (actívalo primero en Usuarios).';
  end if;

  if p_activo then
    insert into public.rec_alcances (usuario_id, rol, area, planta) values (p_usuario, p_rol, p_area, p_planta)
      on conflict on constraint rec_alcances_unico do nothing;
  else
    delete from public.rec_alcances
     where usuario_id = p_usuario and rol = p_rol and area is not distinct from p_area and planta is not distinct from p_planta;
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.rec_accesos_log (tipo, accion, usuario, objetivo)
      values ('alcance', case when p_activo then 'alta' else 'baja' end, auth.uid(),
              jsonb_build_object('usuario', p_usuario, 'rol', p_rol, 'area', p_area, 'planta', p_planta));
  end if;
end
$$;

drop function if exists public.rec_set_motivo(text, text, boolean, int, boolean);
create or replace function public.rec_set_motivo(p_id text, p_nombre text, p_requiere_producto boolean, p_orden int, p_activo boolean, p_area_sugerida text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_nuevo boolean;
  v_area text := nullif(btrim(coalesce(p_area_sugerida, '')), '');
begin
  perform app.rec_exigir_acceso();
  if not app.tiene_rol(variadic array['admin']) then raise exception 'Solo un administrador puede cambiar los motivos.'; end if;
  if p_id is null or p_id !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'El identificador del motivo debe usar minúsculas, números y guion bajo (2 a 41 caracteres, empezando por letra).';
  end if;
  if nullif(btrim(coalesce(p_nombre, '')), '') is null then raise exception 'Escribe el nombre del motivo.'; end if;
  if v_area is not null and v_area not in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial') then
    raise exception 'El área sugerida no es válida.';
  end if;
  v_nuevo := not exists (select 1 from public.rec_motivos where id = p_id);
  insert into public.rec_motivos (id, nombre, requiere_producto, area_sugerida, orden, activo)
    values (p_id, btrim(p_nombre), coalesce(p_requiere_producto, false), v_area, coalesce(p_orden, 0), coalesce(p_activo, true))
    on conflict (id) do update
      set nombre = excluded.nombre, requiere_producto = excluded.requiere_producto, area_sugerida = excluded.area_sugerida,
          orden = excluded.orden, activo = excluded.activo;
  insert into public.rec_accesos_log (tipo, accion, usuario, objetivo)
    values ('motivo', case when v_nuevo then 'alta' else 'cambio' end, auth.uid(),
            jsonb_build_object('id', p_id, 'nombre', btrim(p_nombre), 'requiere_producto', coalesce(p_requiere_producto, false),
                               'area_sugerida', v_area, 'orden', coalesce(p_orden, 0), 'activo', coalesce(p_activo, true)));
end
$$;

-- ───────────────────────── Lectura: rec_ve_todo ─────────────────────────
create or replace function app.rec_ve_todo()
returns boolean language sql stable security definer set search_path = ''
as $$
  select app.tiene_rol(variadic array['admin'])
      or exists (select 1 from app.rec_alcances_de(auth.uid()) a where a.rol in ('gerencia', 'servicio_cliente'))
$$;
revoke all on function app.rec_ve_todo() from public, anon;
grant execute on function app.rec_ve_todo() to authenticated;

drop policy if exists rec_reclamos_sel on public.rec_reclamos;
create policy rec_reclamos_sel on public.rec_reclamos for select to authenticated
  using ((select app.rec_ve_todo()) or app.rec_puede_ver(id));
drop policy if exists rec_eventos_sel on public.rec_eventos;
create policy rec_eventos_sel on public.rec_eventos for select to authenticated
  using ((select app.rec_ve_todo()) or app.rec_puede_ver(reclamo_id));
drop policy if exists rec_adjuntos_sel on public.rec_adjuntos;
create policy rec_adjuntos_sel on public.rec_adjuntos for select to authenticated
  using ((select app.rec_ve_todo()) or app.rec_puede_ver(reclamo_id));

-- ───────────────────────── La planta sigue a la familia del producto ─────────────────────────
-- Si cambia la familia y la planta seguía siendo la que correspondía a la familia anterior (nadie la corrigió a mano),
-- se recalcula. Una planta corregida a mano se respeta.
create or replace function public.crm_products_planta_fill()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.planta is null or btrim(new.planta) = '' then
    new.planta := public.rec_planta_de_familia(new.family);
  elsif tg_op = 'UPDATE' and new.family is distinct from old.family
        and new.planta is not distinct from old.planta
        and old.planta = public.rec_planta_de_familia(old.family) then
    new.planta := public.rec_planta_de_familia(new.family);
  end if;
  return new;
end
$$;

-- ───────────────────────── Permisos de ejecución ─────────────────────────
revoke all on function public.rec_crear(uuid, text, text, text, date, jsonb) from public, anon;
revoke all on function public.rec_actualizar(uuid, text, jsonb, timestamptz) from public, anon;
revoke all on function public.rec_derivar(uuid, text, text, text, timestamptz) from public, anon;
revoke all on function public.rec_devolver(uuid, text, timestamptz) from public, anon;
revoke all on function public.rec_pedir_verificacion(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.rec_reasignar_asesor(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.rec_registrar_informe(uuid, text, uuid, timestamptz) from public, anon;
revoke all on function public.rec_decidir(uuid, text, text, timestamptz) from public, anon;
revoke all on function public.rec_definir_solucion(uuid, text, text, bigint, timestamptz) from public, anon;
revoke all on function public.rec_comunicar(uuid, text, text, timestamptz) from public, anon;
revoke all on function public.rec_cerrar(uuid, timestamptz) from public, anon;
revoke all on function public.rec_corregir_compensacion(uuid, bigint, text, timestamptz) from public, anon;
revoke all on function public.rec_anular(uuid, text, timestamptz) from public, anon;
revoke all on function public.rec_reabrir(uuid, text, timestamptz) from public, anon;
revoke all on function public.rec_adjuntar(uuid, text, text) from public, anon;
revoke all on function public.rec_set_alcance(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.rec_set_motivo(text, text, boolean, int, boolean, text) from public, anon;
grant execute on function public.rec_crear(uuid, text, text, text, date, jsonb) to authenticated;
grant execute on function public.rec_actualizar(uuid, text, jsonb, timestamptz) to authenticated;
grant execute on function public.rec_derivar(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function public.rec_devolver(uuid, text, timestamptz) to authenticated;
grant execute on function public.rec_pedir_verificacion(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.rec_reasignar_asesor(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.rec_registrar_informe(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function public.rec_decidir(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.rec_definir_solucion(uuid, text, text, bigint, timestamptz) to authenticated;
grant execute on function public.rec_comunicar(uuid, text, text, timestamptz) to authenticated;
grant execute on function public.rec_cerrar(uuid, timestamptz) to authenticated;
grant execute on function public.rec_corregir_compensacion(uuid, bigint, text, timestamptz) to authenticated;
grant execute on function public.rec_anular(uuid, text, timestamptz) to authenticated;
grant execute on function public.rec_reabrir(uuid, text, timestamptz) to authenticated;
grant execute on function public.rec_adjuntar(uuid, text, text) to authenticated;
grant execute on function public.rec_set_alcance(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.rec_set_motivo(text, text, boolean, int, boolean, text) to authenticated;
