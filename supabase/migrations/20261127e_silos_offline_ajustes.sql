-- Silos sin conexion: ajustes a 20261127c_silos_offline.sql (ronda de correcciones 1).
-- C-1 (disparador de codigo rompiendo produccion) ya se desactivo por separado y con prioridad
-- en 20261127d_silos_offline_desactivar_codigo_trg.sql; este archivo cubre el resto de la ronda:
--
-- C-2. sil_solicitud_seq partia en 1 sin setval: ya habia 27 solicitudes con codigo hasta
--      SOL-0027, asi que la primera reserva real habria entregado un codigo que ya existe.
--      Se pone la secuencia al dia con greatest(maximo existente, valor ya consumido por las
--      pruebas) para no retroceder, y se agrega un indice unico parcial sobre
--      solicitudes.data->>'codigo' para que, si algo se escapa, la base lo rechace en vez de
--      guardar un duplicado.
-- I-2. sil_guardar_solicitud hacia "select ... for update", que bajo RLS aplica tambien la
--      politica de UPDATE (no solo la de SELECT): un vendedor editando su propia solicitud ya
--      en un estado fuera de lo que su politica permite (p. ej. "Instalada") recibia NO_EXISTE
--      en vez de un error de permiso, y el telefono podia interpretar eso como "se borro".
--      Ahora la existencia se chequea con un select plano (politica de SELECT, que todos los
--      roles del modulo tienen) y el guardado intenta el UPDATE con la version en el WHERE; si
--      no afecta filas, se revisa de nuevo para distinguir CONFLICTO (version cambio justo
--      ahora) de SIN_PERMISO (42501: la fila y la version son correctas, pero la politica de
--      UPDATE no deja tocarla en su estado actual).
-- I-3. lpad(..., 4, '0') trunca desde el codigo 10000 en adelante (mismo error ya corregido en
--      el CRM, 20261122b_crm_offline_ajustes.sql): se cambia a
--      lpad(v_seq::text, greatest(4, length(v_seq::text)), '0').
-- Aplicada en produccion con apply_migration (nombre: silos_offline_ajustes).

-- C-2: secuencia al dia -----------------------------------------------------------------------
select setval(
  'public.sil_solicitud_seq',
  greatest(
    (select coalesce(max(nullif(regexp_replace(data->>'codigo', '\D', '', 'g'), '')::int), 0)
       from public.solicitudes),
    (select last_value from public.sil_solicitud_seq)
  )
);

-- C-2: unicidad de codigo como ultima barrera --------------------------------------------------
create unique index if not exists solicitudes_codigo_uidx
  on public.solicitudes ((data->>'codigo'))
  where data->>'codigo' is not null;

-- I-2: sil_guardar_solicitud ya no confunde "sin permiso" con "no existe" ----------------------
create or replace function public.sil_guardar_solicitud(p_id uuid, p_base timestamptz, p jsonb)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_actual timestamptz;
  v_nuevo  timestamptz;
begin
  select s.updated_at into v_actual from public.solicitudes s where s.id = p_id;
  if not found then
    raise exception 'NO_EXISTE: la solicitud ya no está';
  end if;
  if p_base is distinct from v_actual then
    raise exception 'CONFLICTO: la solicitud cambió en el servidor';
  end if;

  update public.solicitudes s set
    estado  = coalesce(p->>'estado', s.estado),
    silo_id = case when p ? 'silo_id' then nullif(p->>'silo_id', '')::uuid else s.silo_id end,
    data    = coalesce(nullif(p->'data', 'null'::jsonb), s.data)
  where s.id = p_id and s.updated_at = p_base
  returning s.updated_at into v_nuevo;

  if found then
    return v_nuevo;
  end if;

  -- El update no afectó ninguna fila: o la versión cambió justo ahora (CONFLICTO), o la fila
  -- existe y su versión coincide pero la política de UPDATE no deja tocarla en su estado actual
  -- (sin permiso: no confundir con NO_EXISTE, que el teléfono interpretaría como "se borró").
  select s.updated_at into v_actual from public.solicitudes s where s.id = p_id;
  if not found or v_actual is distinct from p_base then
    raise exception 'CONFLICTO: la solicitud cambió en el servidor';
  end if;
  raise exception 'SIN_PERMISO: no tienes permiso para editar esta solicitud' using errcode = '42501';
end $$;
revoke all on function public.sil_guardar_solicitud(uuid, timestamptz, jsonb) from public, anon;
grant execute on function public.sil_guardar_solicitud(uuid, timestamptz, jsonb) to authenticated;

-- I-3: códigos sin truncar más allá de 9999 ----------------------------------------------------
create or replace function public.sil_reservar_codigos(p_n int)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_out text[] := '{}';
  v_seq bigint;
  v_num text;
  i int;
begin
  if auth.uid() is null or not app.tiene_rol(variadic array['vendedor', 'supervisor', 'admin']) then
    raise exception 'Sin permiso para crear solicitudes';
  end if;
  if p_n is null or p_n < 1 or p_n > 20 then
    raise exception 'Cantidad de códigos inválida (1 a 20)';
  end if;
  for i in 1..p_n loop
    v_seq := nextval('public.sil_solicitud_seq');
    v_num := 'SOL-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');
    insert into public.sil_solicitud_reservas (num, user_id) values (v_num, auth.uid());
    v_out := v_out || v_num;
  end loop;
  return v_out;
end $$;
revoke all on function public.sil_reservar_codigos(int) from public, anon;
grant execute on function public.sil_reservar_codigos(int) to authenticated;
