-- Correcciones de la revisión final del respaldo.

-- (#6) El lote "reclama" sus filas: suma el intento antes de procesar, así un corte por tiempo o memoria
-- también cuenta y la fila no bloquea la cola para siempre (a los 10 intentos deja de reintentarse).
-- Ordena por intentos para que una fila problemática no quede siempre primera.
-- (menor) La noche también reintenta avisos de eliminación pendientes, no solo errores.
drop function if exists public.respaldo_pendientes(text, int);
create function public.respaldo_pendientes(p_modo text, p_limite int default 10)
returns setof public.respaldo_cola language sql volatile security definer set search_path = '' as $$
  update public.respaldo_cola c set intentos = c.intentos + 1
  where c.id in (
    select x.id from public.respaldo_cola x
    where x.intentos < 10 and (
      (p_modo = 'procesar' and x.listo_desde <= now() and (
         x.estado = 'pendiente'
         or (x.estado = 'eliminado' and (x.enviado_at is null or x.enviado_at < x.listo_desde))))
      or (p_modo = 'noche' and (
         x.estado = 'error'
         or (x.estado = 'eliminado' and (x.enviado_at is null or x.enviado_at < x.listo_desde)))))
    order by x.intentos, x.listo_desde
    limit greatest(1, least(p_limite, 50))
    for update skip locked)
  returning c.*;
$$;
revoke all on function public.respaldo_pendientes(text, int) from public, anon, authenticated;
grant execute on function public.respaldo_pendientes(text, int) to service_role;

-- (#4) Registrar archivos sin reasignar nunca una ruta ya registrada por otro registro.
create or replace function public.respaldo_registrar_archivos(p_cola_id bigint, p_archivos jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.respaldo_archivos as a (cola_id, bucket, ruta, nombre_drive, drive_file_id, subido_at)
  select p_cola_id, x->>'bucket', x->>'ruta', x->>'nombre_drive', x->>'drive_file_id', (x->>'subido_at')::timestamptz
  from jsonb_array_elements(p_archivos) x
  on conflict (bucket, ruta) do update
    set nombre_drive = excluded.nombre_drive, drive_file_id = excluded.drive_file_id, subido_at = excluded.subido_at
    where a.cola_id = excluded.cola_id;
$$;
revoke all on function public.respaldo_registrar_archivos(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.respaldo_registrar_archivos(bigint, jsonb) to service_role;

-- (#1) Retención solo para archivos cuyo envío figura como enviado en Drive.
create or replace function public.respaldo_archivos_retencion()
returns table (id bigint, bucket text, ruta text, drive_file_id text, creado_storage timestamptz, borrado_supabase_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, a.bucket, a.ruta, a.drive_file_id, o.created_at, a.borrado_supabase_at
  from public.respaldo_archivos a
  join public.respaldo_cola c on c.id = a.cola_id and c.estado = 'enviado'
  left join storage.objects o on o.bucket_id = a.bucket and o.name = a.ruta
  where a.borrado_supabase_at is null;
$$;
