-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
-- Registro de Terreno: asistencias por QR (token por actividad, RPC anónimas) y trigger de permisos de edición.
-- Usa usuarios reales solo como identidad (no los modifica); todo lo creado se revierte al final.
do $$
declare
  pm1 uuid; pm2 uuid; adm uuid;
  reg uuid := gen_random_uuid();
  tok text; tok2 text; n int; ok boolean; v text; fila record; i int;
  firma_ok text := 'data:image/png;base64,iVBORw0KGgo=';
begin
  -- ===== Preparación (como dueño) =====
  select u.id into pm1 from public.rt_usuarios u join public.profiles p on p.id = u.id
    where u.activo and p.activo and p.rol::text <> 'admin' order by u.id limit 1;
  select u.id into pm2 from public.rt_usuarios u join public.profiles p on p.id = u.id
    where u.activo and p.activo and p.rol::text <> 'admin' and u.id <> pm1 order by u.id limit 1;
  select id into adm from public.profiles where activo and rol::text = 'admin' order by id limit 1;
  if pm1 is null or pm2 is null or adm is null then raise exception 'faltan usuarios activos (2 PM no admin y 1 admin) para la prueba'; end if;

  insert into public.registros (id, kind, fecha, cliente, obra, estado, autor, datos)
    values (reg, 'charla', current_date, 'Cliente Test', 'Obra Test', 'Abierto', pm1, '{"tema":"original"}'::jsonb);

  -- ===== Esquema: el token no vive en registros (no se puede leer por la API) =====
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'registros' and column_name = 'asistencia_token') then
    raise exception 'registros no debe tener la columna asistencia_token';
  end if;
  if has_table_privilege('anon', 'public.rt_asistencia_tokens', 'select') or has_table_privilege('authenticated', 'public.rt_asistencia_tokens', 'select')
     or has_table_privilege('anon', 'public.rt_asistencias', 'select') or has_table_privilege('anon', 'public.rt_asistencias', 'insert') then
    raise exception 'privilegios de tabla demasiado abiertos';
  end if;
  if has_function_privilege('anon', 'public.rt_asistencia_abrir(uuid)', 'execute') or has_function_privilege('anon', 'public.rt_asistencia_cerrar(uuid)', 'execute') then
    raise exception 'anon puede ejecutar abrir/cerrar';
  end if;
  if not has_function_privilege('anon', 'public.rt_asistencia_info(text)', 'execute')
     or not has_function_privilege('anon', 'public.rt_asistencia_agregar(text,text,text,text,text,text,text)', 'execute') then
    raise exception 'anon no puede ejecutar info/agregar';
  end if;

  -- ===== 1) abrir: solo autor o admin; token de 32 caracteres =====
  perform set_config('request.jwt.claims', json_build_object('sub', pm2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin
    perform public.rt_asistencia_abrir(reg);
  exception when others then
    if sqlerrm <> 'solo el autor o un admin pueden abrir la asistencia' then raise exception 'error inesperado (abrir ajeno): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM que no es autor pudo abrir la asistencia'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', pm1, 'role', 'authenticated')::text, true);
  tok := public.rt_asistencia_abrir(reg);
  if length(tok) <> 32 then raise exception 'token de largo %', length(tok); end if;
  -- el token no se puede leer por la API (ni como autor)
  ok := false;
  begin
    perform 1 from public.rt_asistencia_tokens;
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'authenticated pudo leer rt_asistencia_tokens'; end if;
  ok := false;
  begin
    perform asistencia_token from public.registros;
  exception when undefined_column then ok := true; end;
  if not ok then raise exception 'authenticated pudo leer registros.asistencia_token'; end if;
  reset role;
  if not (select asistencia_abierta from public.registros where id = reg) then raise exception 'asistencia_abierta no quedó en true'; end if;

  -- ===== 2) info anónima: una fila, sin token ni participantes; token inventado = 0 filas =====
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  select count(*) into n from public.rt_asistencia_info(tok);
  if n <> 1 then raise exception 'info con token válido devolvió % filas', n; end if;
  select * into fila from public.rt_asistencia_info(tok);
  if fila.actividad <> 'charla' or fila.cliente <> 'Cliente Test' or fila.obra <> 'Obra Test' or fila.fecha <> current_date then
    raise exception 'info devolvió datos incorrectos: %', fila;
  end if;
  if to_jsonb(fila) ?| array['token','asistencia_token','participantes','nombre'] then raise exception 'info expone campos sensibles: %', to_jsonb(fila); end if;
  select count(*) into n from public.rt_asistencia_info('0123456789abcdef0123456789abcdef');
  if n <> 0 then raise exception 'info con token inventado devolvió % filas', n; end if;

  -- ===== 3) agregar con solo el nombre: correo vacío y origen qr =====
  if public.rt_asistencia_agregar(tok, 'Ana Pérez', '', '', '', '', '') is not true then raise exception 'agregar solo nombre no devolvió true'; end if;
  -- 4) segunda inserción inmediata (sin espera) también funciona
  if public.rt_asistencia_agregar(tok, 'Luis Soto', '12.345.678-5', 'Capataz', 'luis@x.cl', '+56911112222', firma_ok) is not true then
    raise exception 'segunda inserción seguida falló';
  end if;
  reset role;
  select * into fila from public.rt_asistencias where registro_id = reg and nombre = 'Ana Pérez';
  if fila.email <> '' or fila.origen <> 'qr' or fila.rut <> '' then raise exception 'fila de Ana incorrecta: %', to_jsonb(fila); end if;
  select * into fila from public.rt_asistencias where registro_id = reg and nombre = 'Luis Soto';
  if fila.firma <> firma_ok or fila.cargo <> 'Capataz' or fila.origen <> 'qr' then raise exception 'fila de Luis incorrecta'; end if;

  -- ===== Duplicados: mismo RUT (con otro formato) o mismo nombre normalizado sin RUT =====
  set local role anon;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, 'Otro Nombre', '12345678-5', '', '', '', '');
  exception when others then
    if sqlerrm <> 'ya estás registrado en esta actividad' then raise exception 'error inesperado (RUT repetido): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó un RUT repetido'; end if;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, '  ANA   perez ', '', '', '', '', '');
  exception when others then
    if sqlerrm <> 'ya estás registrado en esta actividad' then raise exception 'error inesperado (nombre repetido): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó un nombre repetido sin RUT'; end if;
  -- mismo nombre pero con RUT distinto: es otra persona
  if public.rt_asistencia_agregar(tok, 'Luis Soto', '9.876.543-2', '', '', '', '') is not true then raise exception 'homónimo con otro RUT rechazado'; end if;

  -- ===== Entradas inválidas: todas con el mensaje genérico =====
  foreach v in array array['', '   ', repeat('x', 121)] loop
    ok := false;
    begin
      perform public.rt_asistencia_agregar(tok, v, '', '', '', '', '');
    exception when others then
      if sqlerrm <> 'enlace no válido o actividad cerrada' then raise exception 'error inesperado (nombre inválido): %', sqlerrm; end if;
      ok := true;
    end;
    if not ok then raise exception 'se aceptó el nombre inválido [%]', left(v, 10); end if;
  end loop;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, 'Firma Grande', '', '', '', '', 'data:image/png;base64,' || repeat('A', 60 * 1024));
  exception when others then
    if sqlerrm <> 'enlace no válido o actividad cerrada' then raise exception 'error inesperado (firma): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó una firma de más de 60 KB'; end if;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, 'Firma Rara', '', '', '', '', '<script>alert(1)</script>');
  exception when others then ok := true; end;
  if not ok then raise exception 'se aceptó una firma que no es base64'; end if;
  ok := false;
  begin
    perform public.rt_asistencia_agregar('token-inventado', 'Intruso', '', '', '', '', '');
  exception when others then
    if sqlerrm <> 'enlace no válido o actividad cerrada' then raise exception 'error inesperado (token falso): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó un token inventado'; end if;

  -- ===== Tope de 80 participantes por actividad =====
  reset role;
  select count(*) into n from public.rt_asistencias where registro_id = reg;
  if n <> 3 then raise exception 'se esperaban 3 participantes, hay %', n; end if;
  set local role anon;
  for i in 1..77 loop
    perform public.rt_asistencia_agregar(tok, 'Participante ' || i, '', '', '', '', '');
  end loop;
  reset role;
  select count(*) into n from public.rt_asistencias where registro_id = reg;
  if n <> 80 then raise exception 'se esperaban 80 participantes, hay %', n; end if;
  set local role anon;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, 'Participante 81', '', '', '', '', '');
  exception when others then
    if sqlerrm <> 'enlace no válido o actividad cerrada' then raise exception 'error inesperado (cupo): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó el participante 81'; end if;

  -- ===== anon: acceso directo prohibido =====
  ok := false;
  begin perform 1 from public.rt_asistencias; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'anon pudo leer rt_asistencias'; end if;
  ok := false;
  begin
    insert into public.rt_asistencias (registro_id, nombre) values (reg, 'Directo');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'anon pudo insertar directo en rt_asistencias'; end if;
  ok := false;
  begin perform 1 from public.rt_asistencia_tokens; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'anon pudo leer rt_asistencia_tokens'; end if;
  ok := false;
  begin perform asistencia_token from public.registros; exception when undefined_column or insufficient_privilege then ok := true; end;
  if not ok then raise exception 'anon pudo leer registros.asistencia_token'; end if;
  select count(*) into n from public.registros;
  if n <> 0 then raise exception 'anon ve filas de registros'; end if;
  ok := false;
  begin perform public.rt_asistencia_abrir(reg); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'anon pudo abrir la asistencia'; end if;
  reset role;

  -- ===== cerrar: solo autor o admin; después no se puede agregar =====
  perform set_config('request.jwt.claims', json_build_object('sub', pm2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin
    perform public.rt_asistencia_cerrar(reg);
  exception when others then
    if sqlerrm <> 'solo el autor o un admin pueden cerrar la asistencia' then raise exception 'error inesperado (cerrar ajeno): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM que no es autor pudo cerrar la asistencia'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', pm1, 'role', 'authenticated')::text, true);
  perform public.rt_asistencia_cerrar(reg);
  reset role;
  if (select asistencia_abierta from public.registros where id = reg) then raise exception 'asistencia_abierta sigue en true'; end if;
  if exists (select 1 from public.rt_asistencia_tokens where registro_id = reg) then raise exception 'el token sigue guardado tras cerrar'; end if;
  set local role anon;
  select count(*) into n from public.rt_asistencia_info(tok);
  if n <> 0 then raise exception 'info devuelve filas con la actividad cerrada'; end if;
  ok := false;
  begin
    perform public.rt_asistencia_agregar(tok, 'Tarde', '', '', '', '', '');
  exception when others then
    if sqlerrm <> 'enlace no válido o actividad cerrada' then raise exception 'error inesperado (cerrada): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'se aceptó un participante con la actividad cerrada'; end if;
  reset role;

  -- reabrir genera otro token y el admin también puede abrir/cerrar
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  tok2 := public.rt_asistencia_abrir(reg);
  if tok2 = tok or length(tok2) <> 32 then raise exception 'el token reabierto debe ser nuevo'; end if;
  perform public.rt_asistencia_cerrar(reg);
  reset role;

  -- ===== Trigger de permisos de edición de registros =====
  -- PM activo que no es autor: solo puede cambiar estado (y updated_at)
  perform set_config('request.jwt.claims', json_build_object('sub', pm2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.registros set estado = 'En seguimiento', updated_at = now() where id = reg;
  reset role;
  if (select estado from public.registros where id = reg) <> 'En seguimiento' then raise exception 'el PM no pudo cambiar el estado'; end if;
  set local role authenticated;
  ok := false;
  begin
    update public.registros set datos = '{"tema":"cambiado"}'::jsonb where id = reg;
  exception when others then
    if sqlerrm not like 'solo el autor o un admin%' then raise exception 'error inesperado (datos ajenos): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM ajeno pudo cambiar datos'; end if;
  ok := false;
  begin
    update public.registros set cliente = 'Otro' where id = reg;
  exception when others then
    if sqlerrm not like 'solo el autor o un admin%' then raise exception 'error inesperado (cliente ajeno): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM ajeno pudo cambiar el cliente'; end if;
  ok := false;
  begin
    update public.registros set estado = 'Cerrado', autor = pm2 where id = reg;
  exception when others then
    if sqlerrm not like 'solo el autor o un admin%' then raise exception 'error inesperado (autor): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM ajeno pudo apropiarse del registro'; end if;
  ok := false;
  begin
    update public.registros set asistencia_abierta = true where id = reg;
  exception when others then
    if sqlerrm not like 'solo el autor o un admin%' then raise exception 'error inesperado (abierta ajeno): %', sqlerrm; end if;
    ok := true;
  end;
  if not ok then raise exception 'un PM ajeno pudo cambiar asistencia_abierta'; end if;
  reset role;
  if (select datos->>'tema' from public.registros where id = reg) <> 'original' or (select cliente from public.registros where id = reg) <> 'Cliente Test' then
    raise exception 'los datos del registro cambiaron pese al rechazo';
  end if;

  -- el autor puede cambiar todo
  perform set_config('request.jwt.claims', json_build_object('sub', pm1, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.registros set datos = '{"tema":"del autor"}'::jsonb, obra = 'Obra del autor' where id = reg;
  reset role;
  if (select datos->>'tema' from public.registros where id = reg) <> 'del autor' then raise exception 'el autor no pudo editar'; end if;
  -- un admin también
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.registros set cliente = 'Cliente del admin' where id = reg;
  reset role;
  if (select cliente from public.registros where id = reg) <> 'Cliente del admin' then raise exception 'el admin no pudo editar'; end if;

  -- ===== Políticas de rt_asistencias para usuarios autenticados =====
  perform set_config('request.jwt.claims', json_build_object('sub', pm2, 'role', 'authenticated')::text, true);
  set local role authenticated;
  ok := false;
  begin
    insert into public.rt_asistencias (registro_id, nombre) values (reg, 'Manual ajeno');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'un PM ajeno pudo agregar participantes a un registro que no es suyo'; end if;
  select count(*) into n from public.rt_asistencias where registro_id = reg;
  if n <> 80 then raise exception 'un PM activo debe poder leer los participantes (ve %)', n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', pm1, 'role', 'authenticated')::text, true);
  delete from public.rt_asistencias where registro_id = reg and nombre = 'Participante 1';
  insert into public.rt_asistencias (registro_id, nombre, origen) values (reg, 'Manual autor', 'manual');
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  insert into public.rt_asistencias (registro_id, nombre, origen) values (reg, 'Manual admin', 'manual');
  reset role;
  select count(*) into n from public.rt_asistencias where registro_id = reg;
  if n <> 81 then raise exception 'conteo final de participantes: %', n; end if;

  -- borrar el registro borra en cascada sus participantes
  delete from public.registros where id = reg;
  if exists (select 1 from public.rt_asistencias where registro_id = reg) then raise exception 'los participantes no se borraron en cascada'; end if;

  raise exception 'OK_ROLLBACK';
exception when others then
  reset role;
  raise;
end $$;
