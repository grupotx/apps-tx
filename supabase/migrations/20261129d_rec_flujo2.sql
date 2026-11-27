-- Reclamos, Tarea 5: motor del flujo — solución, comunicación, cierre, corregir compensación, anular, reabrir,
-- alcances y motivos (estos dos últimos solo administrador, con bitácora de cambios de acceso).
-- Mismas reglas que la Tarea 4: security definer, search_path vacío, estado revalidado bajo bloqueo en app.rec_mover,
-- un evento por paso en rec_eventos.

-- ───────────────────────── Bitácora de cambios de acceso (alcances y motivos) ─────────────────────────
-- Quién cambió qué y cuándo. La lee solo el administrador; solo la escriben rec_set_alcance y rec_set_motivo.
create table if not exists public.rec_accesos_log (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('alcance', 'motivo')),
  accion text not null check (accion in ('alta', 'baja', 'cambio')),
  usuario uuid not null references public.profiles(id),
  objetivo jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);
alter table public.rec_accesos_log enable row level security;
drop policy if exists rec_accesos_log_sel on public.rec_accesos_log;
create policy rec_accesos_log_sel on public.rec_accesos_log for select to authenticated using (app.tiene_rol(variadic array['admin']));
revoke all on public.rec_accesos_log from anon;
revoke insert, update, delete, truncate, references, trigger on public.rec_accesos_log from authenticated;

-- ───────────────────────── Solución, comunicación y cierre ─────────────────────────
-- La solución (tipo del catálogo + detalle) y la compensación (monto entero en pesos, ≥ 0) son dos cosas;
-- el monto es obligatorio al definir la solución (0 si no hay).
create or replace function public.rec_definir_solucion(p_id uuid, p_tipo text, p_detalle text, p_compensacion bigint)
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
    jsonb_build_object('solucion_tipo', p_tipo, 'compensacion', p_compensacion));
  update public.rec_reclamos
     set solucion_tipo = p_tipo, solucion_detalle = nullif(btrim(coalesce(p_detalle, '')), ''), compensacion = p_compensacion
   where id = p_id;
end
$$;

-- El sistema arma el texto (RC.mensajeCliente); servicio al cliente lo envía por su canal y aquí queda registrado.
create or replace function public.rec_comunicar(p_id uuid, p_mensaje text, p_canal text default null)
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
  perform app.rec_mover(p_id, array['solucion_definida'], 'comunicado', 'comunicado', null, jsonb_build_object('canal', v_canal));
  update public.rec_reclamos
     set mensaje_cliente = btrim(p_mensaje), canal = v_canal, comunicado_por = auth.uid(), comunicado_en = now()
   where id = p_id;
end
$$;

create or replace function public.rec_cerrar(p_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  if not app.rec_es_servicio() then raise exception 'Solo servicio al cliente puede cerrar un reclamo.'; end if;
  perform app.rec_mover(p_id, array['comunicado'], 'cerrado', 'cerrado', null, null);
  update public.rec_reclamos set cerrado_en = now() where id = p_id;
end
$$;

-- Servicio al cliente corrige la compensación hasta antes de cerrar; después solo un administrador. El evento guarda
-- el monto anterior y el nuevo, con el motivo.
create or replace function public.rec_corregir_compensacion(p_id uuid, p_monto bigint, p_motivo text)
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
    jsonb_build_object('monto_anterior', r.compensacion, 'monto_nuevo', p_monto));
  update public.rec_reclamos set compensacion = p_monto where id = p_id;
end
$$;

-- ───────────────────────── Anular y reabrir ─────────────────────────
-- Anular: duplicado o error; servicio al cliente o admin, desde cualquier estado salvo cerrado/anulado; con motivo.
-- Un anulado queda fuera de las métricas (RC.metricas).
create or replace function public.rec_anular(p_id uuid, p_motivo text)
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
    'anulado', 'anulado', p_motivo, jsonb_build_object('estado_anterior', r.estado));
end
$$;

-- Reabrir: solo administrador, desde cerrado o anulado, con motivo. Vuelve a "ingresado", conserva la historia, deja en
-- el detalle del evento una copia de lo que tenía (decisión, solución, compensación, comunicación, destino, informe) y
-- limpia esos campos de la fila para que el nuevo ciclo parta de cero.
create or replace function public.rec_reabrir(p_id uuid, p_motivo text)
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
  perform app.rec_mover(p_id, array['cerrado', 'anulado'], 'ingresado', 'reabierto', p_motivo, v_det);
  update public.rec_reclamos
     set decision = null, razones = null, decidido_por = null, decidido_en = null,
         solucion_tipo = null, solucion_detalle = null, compensacion = null,
         mensaje_cliente = null, canal = null, comunicado_por = null, comunicado_en = null, cerrado_en = null,
         area_destino = null, planta_destino = null, asesor_id = null, informe = null, visita_registro_id = null
   where id = p_id;
end
$$;

-- ───────────────────────── Alcances y motivos (solo administrador) ─────────────────────────
-- Forma válida de cada rol (la misma que el CHECK de rec_alcances): encargado_area exige área (y planta si el área es
-- calidad o producción; las demás no llevan planta); encargado_calidad exige planta y no lleva área; asesor_tecnico,
-- servicio_cliente y gerencia no llevan área ni planta. La persona debe tener ya acceso al módulo (se activa en Usuarios).
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
    if p_area in ('calidad', 'produccion') and p_planta is null then raise exception 'El área % exige una planta.', p_area; end if;
    if p_area not in ('calidad', 'produccion') and p_planta is not null then raise exception 'El área % no lleva planta.', p_area; end if;
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

create or replace function public.rec_set_motivo(p_id text, p_nombre text, p_requiere_producto boolean, p_orden int, p_activo boolean)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_nuevo boolean;
begin
  perform app.rec_exigir_acceso();
  if not app.tiene_rol(variadic array['admin']) then raise exception 'Solo un administrador puede cambiar los motivos.'; end if;
  if p_id is null or p_id !~ '^[a-z][a-z0-9_]{1,40}$' then
    raise exception 'El identificador del motivo debe usar minúsculas, números y guion bajo (2 a 41 caracteres, empezando por letra).';
  end if;
  if nullif(btrim(coalesce(p_nombre, '')), '') is null then raise exception 'Escribe el nombre del motivo.'; end if;
  v_nuevo := not exists (select 1 from public.rec_motivos where id = p_id);
  insert into public.rec_motivos (id, nombre, requiere_producto, orden, activo)
    values (p_id, btrim(p_nombre), coalesce(p_requiere_producto, false), coalesce(p_orden, 0), coalesce(p_activo, true))
    on conflict (id) do update
      set nombre = excluded.nombre, requiere_producto = excluded.requiere_producto, orden = excluded.orden, activo = excluded.activo;
  insert into public.rec_accesos_log (tipo, accion, usuario, objetivo)
    values ('motivo', case when v_nuevo then 'alta' else 'cambio' end, auth.uid(),
            jsonb_build_object('id', p_id, 'nombre', btrim(p_nombre), 'requiere_producto', coalesce(p_requiere_producto, false),
                               'orden', coalesce(p_orden, 0), 'activo', coalesce(p_activo, true)));
end
$$;

-- ───────────────────────── Permisos de ejecución ─────────────────────────
revoke all on function public.rec_definir_solucion(uuid, text, text, bigint) from public, anon;
revoke all on function public.rec_comunicar(uuid, text, text) from public, anon;
revoke all on function public.rec_cerrar(uuid) from public, anon;
revoke all on function public.rec_corregir_compensacion(uuid, bigint, text) from public, anon;
revoke all on function public.rec_anular(uuid, text) from public, anon;
revoke all on function public.rec_reabrir(uuid, text) from public, anon;
revoke all on function public.rec_set_alcance(uuid, text, text, text, boolean) from public, anon;
revoke all on function public.rec_set_motivo(text, text, boolean, int, boolean) from public, anon;
grant execute on function public.rec_definir_solucion(uuid, text, text, bigint) to authenticated;
grant execute on function public.rec_comunicar(uuid, text, text) to authenticated;
grant execute on function public.rec_cerrar(uuid) to authenticated;
grant execute on function public.rec_corregir_compensacion(uuid, bigint, text) to authenticated;
grant execute on function public.rec_anular(uuid, text) to authenticated;
grant execute on function public.rec_reabrir(uuid, text) to authenticated;
grant execute on function public.rec_set_alcance(uuid, text, text, text, boolean) to authenticated;
grant execute on function public.rec_set_motivo(text, text, boolean, int, boolean) to authenticated;
