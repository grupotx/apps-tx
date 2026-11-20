-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Hora real (p_at) en llegada/cierre e idempotencia del cierre en Entregas.
do $$
declare
  uid uuid; g1 uuid; g2 uuid; e1 public.ent_entregas; e2 public.ent_entregas;
  t_lleg timestamptz := now() - interval '2 hours';
  t_cierre timestamptz := now() - interval '1 hour';
  n int; ok boolean;
begin
  -- Datos de prueba (como dueño)
  select id into uid from auth.users order by created_at limit 1;
  if uid is null then raise exception 'no hay auth.users para la prueba'; end if;
  insert into public.ent_usuarios (id, nombre, rol, activo) values (uid, 'Chofer Test', 'chofer', true)
    on conflict (id) do update set rol = 'chofer', activo = true;
  insert into public.ent_productos (codigo, descripcion, unidad) values ('TEST-OFF', 'Producto test', 'SACO')
    on conflict (codigo) do nothing;
  insert into public.ent_guias (folio, chofer_id, dest_lat, dest_lng, created_by) values ('TEST-OFF-1', uid, -33.45, -70.66, uid) returning id into g1;
  insert into public.ent_guias (folio, chofer_id, dest_lat, dest_lng, created_by) values ('TEST-OFF-2', uid, -33.45, -70.66, uid) returning id into g2;

  -- Actuar como el chofer
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1) llegada con p_at en ventana -> se respeta
  e1 := public.ent_marcar_llegada(p_guia => g1, p_patente => 'ab12cd', p_lat => -33.45, p_lng => -70.66, p_precision => 10, p_at => t_lleg);
  if e1.llegada_at <> t_lleg then raise exception 'llegada_at no respeta p_at: %', e1.llegada_at; end if;

  -- 2) llegada con p_at fuera de ventana (+3 días) -> now()
  e2 := public.ent_marcar_llegada(p_guia => g2, p_patente => 'ab12cd', p_lat => -33.45, p_lng => -70.66, p_precision => 10, p_at => now() + interval '3 days');
  if abs(extract(epoch from e2.llegada_at - now())) > 5 then raise exception 'llegada_at futura no se reemplazó por now(): %', e2.llegada_at; end if;

  -- 3) cierre con p_at -> cierre_at = p_at; guía entregada_con_devolucion (con 1 devolución)
  e1 := public.ent_cerrar_entrega(p_guia => g1, p_resultado => 'entregada_con_devolucion', p_fotos => array['f/1.jpg'],
    p_receptor_nombre => 'Recibe', p_receptor_rut => null, p_receptor_cargo => null, p_receptor_telefono => null,
    p_firma_path => 'firmas/A.png', p_observacion => null, p_lat => -33.45, p_lng => -70.66,
    p_devoluciones => '[{"codigo":"TEST-OFF","cantidad":2,"motivo":"roto"}]'::jsonb, p_at => t_cierre);
  if e1.cierre_at <> t_cierre then raise exception 'cierre_at no respeta p_at: %', e1.cierre_at; end if;

  -- 3b) cierre sin p_at (firma vieja, app publicada) sobre g2 -> resultado entregada, cierre_at = now()
  e2 := public.ent_cerrar_entrega(p_guia => g2, p_resultado => 'entregada', p_fotos => array['f/2.jpg'],
    p_receptor_nombre => 'Recibe', p_receptor_rut => null, p_receptor_cargo => null, p_receptor_telefono => null,
    p_firma_path => 'firmas/B.png', p_observacion => null, p_lat => -33.45, p_lng => -70.66);
  if abs(extract(epoch from e2.cierre_at - now())) > 5 then raise exception 'cierre sin p_at no usa now()'; end if;

  -- 4) mismo cierre repetido (misma firma) -> sin error, misma fila, sin duplicar devoluciones
  e2 := public.ent_cerrar_entrega(p_guia => g1, p_resultado => 'entregada_con_devolucion', p_fotos => array['f/1.jpg'],
    p_receptor_nombre => 'Recibe', p_receptor_rut => null, p_receptor_cargo => null, p_receptor_telefono => null,
    p_firma_path => 'firmas/A.png', p_observacion => null, p_lat => -33.45, p_lng => -70.66,
    p_devoluciones => '[{"codigo":"TEST-OFF","cantidad":2,"motivo":"roto"}]'::jsonb, p_at => t_cierre);
  if e2.id <> e1.id or e2.cierre_at <> t_cierre then raise exception 'reintento devolvió otra fila'; end if;

  -- 5) cierre con otra firma sobre guía cerrada -> 'La guía ya fue cerrada'
  ok := false;
  begin
    perform public.ent_cerrar_entrega(p_guia => g1, p_resultado => 'entregada', p_fotos => array['f/1.jpg'],
      p_receptor_nombre => 'Recibe', p_receptor_rut => null, p_receptor_cargo => null, p_receptor_telefono => null,
      p_firma_path => 'firmas/OTRA.png', p_observacion => null, p_lat => -33.45, p_lng => -70.66, p_at => t_cierre);
  exception when others then
    if sqlerrm <> 'La guía ya fue cerrada' then raise exception 'error inesperado: %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'cierre con otra firma no falló'; end if;

  -- Verificaciones como dueño
  reset role;
  select count(*) into n from public.ent_devoluciones where guia_id = g1;
  if n <> 1 then raise exception 'devoluciones duplicadas: %', n; end if;
  if (select estado from public.ent_guias where id = g1) <> 'entregada_con_devolucion' then raise exception 'estado g1 incorrecto'; end if;
  if (select estado from public.ent_guias where id = g2) <> 'entregada' then raise exception 'estado g2 incorrecto'; end if;

  -- 6) helper: bordes de ventana
  if app.ent_hora_valida(null) is distinct from now() then raise exception 'hora_valida(null) <> now()'; end if;
  if app.ent_hora_valida(now() - interval '73 hours') <> now() then raise exception 'hora_valida no rechaza >72h'; end if;
  if app.ent_hora_valida(now() + interval '5 minutes') <> now() + interval '5 minutes' then raise exception 'hora_valida rechaza +5min'; end if;

  raise exception 'OK_ROLLBACK';
end $$;
