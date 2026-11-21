-- Terreno: la página pública del QR muestra el nombre de la actividad (datos->>'nombre') para que el participante
-- compruebe que escaneó la charla correcta. Si el nombre está vacío o no existe, cae en el tipo (kind), como antes.
-- Misma firma y mismas columnas: actividad, cliente, obra, fecha, y nada más.
create or replace function public.rt_asistencia_info(p_token text)
returns table (actividad text, cliente text, obra text, fecha date)
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(nullif(btrim(r.datos->>'nombre'), ''), r.kind), r.cliente, r.obra, r.fecha
  from public.rt_asistencia_tokens t
  join public.registros r on r.id = t.registro_id
  where t.token = p_token and r.asistencia_abierta
$$;

-- create or replace conserva los permisos; se reafirman por claridad.
revoke all on function public.rt_asistencia_info(text) from public, anon, authenticated;
grant execute on function public.rt_asistencia_info(text) to anon, authenticated;
