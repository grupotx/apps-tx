-- Correr con execute_sql: debe terminar con "OK_ROLLBACK" (no deja datos).
do $$
declare a bigint; b bigint; n int; i1 int; dueno bigint; ret int;
begin
  insert into public.respaldo_cola (app,tabla,registro_id,estado,listo_desde) values ('terreno','registros','t-a','pendiente',now()-interval '1 min') returning id into a;
  insert into public.respaldo_cola (app,tabla,registro_id,estado,listo_desde) values ('terreno','registros','t-b','error',now()-interval '1 min') returning id into b;
  select count(*) into n from public.respaldo_pendientes('procesar', 10) p where p.id in (a,b);
  select intentos into i1 from public.respaldo_cola where id = a;
  if n <> 1 or i1 <> 1 then raise exception 'reclamo mal: n=% intentos=%', n, i1; end if;
  perform public.respaldo_registrar_archivos(a, '[{"bucket":"registro-terreno","ruta":"x/1.jpg","nombre_drive":"f","drive_file_id":"DA","subido_at":"2026-11-19T00:00:00Z"}]');
  perform public.respaldo_registrar_archivos(b, '[{"bucket":"registro-terreno","ruta":"x/1.jpg","nombre_drive":"f","drive_file_id":"DB","subido_at":"2026-11-19T00:00:00Z"}]');
  select cola_id into dueno from public.respaldo_archivos where bucket='registro-terreno' and ruta='x/1.jpg';
  if dueno <> a then raise exception 'ruta reasignada'; end if;
  select count(*) into ret from public.respaldo_archivos_retencion() r where r.ruta='x/1.jpg';
  if ret <> 0 then raise exception 'retencion incluye envio no enviado'; end if;
  update public.respaldo_cola set estado='enviado' where id=a;
  select count(*) into ret from public.respaldo_archivos_retencion() r where r.ruta='x/1.jpg';
  if ret <> 1 then raise exception 'retencion no incluye enviado'; end if;
  update public.respaldo_cola set intentos=10, estado='pendiente' where id=a;
  select count(*) into n from public.respaldo_pendientes('procesar', 10) p where p.id = a;
  if n <> 0 then raise exception 'tope de intentos no respetado'; end if;
  select count(*) into n from public.respaldo_pendientes('noche', 10) p where p.id = b;
  if n <> 1 then raise exception 'noche no toma error'; end if;
  raise exception 'OK_ROLLBACK';
end $$;
