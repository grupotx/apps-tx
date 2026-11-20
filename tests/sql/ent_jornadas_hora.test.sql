-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- ent_jornadas: la hora y la fecha las pone el servidor (reloj del teléfono acotado con app.ent_hora_valida).
do $$
declare
  uid uuid; j public.ent_jornadas;
  t_ok timestamptz := now() - interval '3 hours';
  hoy_cl date := (now() at time zone 'America/Santiago')::date;
begin
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then raise exception 'no hay auth.users para la prueba'; end if;
  insert into public.ent_usuarios (id, nombre, rol, activo) values (uid, 'Chofer Test', 'chofer', true)
    on conflict (id) do update set rol = 'chofer', activo = true;

  -- Actuar como el chofer (insert/update por la API, con RLS)
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1) inicio_at muy en el futuro (reloj del teléfono adelantado) y fecha falsa -> now() y hoy en Santiago
  insert into public.ent_jornadas (chofer_id, patente, fecha, inicio_at)
    values (uid, 'TEST01', date '2031-01-01', now() + interval '400 days') returning * into j;
  if abs(extract(epoch from j.inicio_at - now())) > 5 then raise exception 'inicio_at futuro no se reemplazó por now(): %', j.inicio_at; end if;
  if j.fecha <> hoy_cl then raise exception 'fecha no derivada de inicio_at en Santiago: % (esperado %)', j.fecha, hoy_cl; end if;

  -- 2) inicio_at reciente en el pasado (registro sin señal) -> se respeta; fecha = su día en Santiago
  insert into public.ent_jornadas (chofer_id, patente, fecha, inicio_at)
    values (uid, 'TEST02', date '2000-01-01', t_ok) returning * into j;
  if j.inicio_at <> t_ok then raise exception 'inicio_at reciente no se respetó: %', j.inicio_at; end if;
  if j.fecha <> (t_ok at time zone 'America/Santiago')::date then raise exception 'fecha de inicio_at pasado mal: %', j.fecha; end if;

  -- 3) fin_at fuera de ventana (futuro lejano) -> now()
  update public.ent_jornadas set fin_at = now() + interval '30 days' where id = j.id returning * into j;
  if abs(extract(epoch from j.fin_at - now())) > 5 then raise exception 'fin_at futuro no se acotó: %', j.fin_at; end if;

  -- 4) fin_at reciente válido -> se respeta
  update public.ent_jornadas set fin_at = t_ok + interval '1 hour' where id = j.id returning * into j;
  if j.fin_at <> t_ok + interval '1 hour' then raise exception 'fin_at válido no se respetó: %', j.fin_at; end if;

  -- 5) fin_at muy antiguo (> 72 h) -> now()
  update public.ent_jornadas set fin_at = now() - interval '10 days' where id = j.id returning * into j;
  if abs(extract(epoch from j.fin_at - now())) > 5 then raise exception 'fin_at antiguo no se acotó: %', j.fin_at; end if;

  -- 6) el chofer no puede llamar la función del trigger directamente
  begin
    perform app.ent_jornadas_hora();
    raise exception 'authenticated pudo ejecutar app.ent_jornadas_hora';
  exception when insufficient_privilege or feature_not_supported or undefined_function then null;
  end;

  raise exception 'OK_ROLLBACK';
end $$;
