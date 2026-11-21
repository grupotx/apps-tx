-- Terreno: los campos opcionales demasiado largos se recortan en vez de rechazarse (el cliente no los valida y el
-- mensaje genérico de enlace inválido engañaría al participante). Nombre y firma siguen rechazándose (el cliente sí
-- los valida). El tope de 80 es solo de la vía pública del QR; el alta manual del PM no tiene tope a propósito.
create or replace function public.rt_asistencia_agregar(
  p_token text, p_nombre text, p_rut text, p_cargo text, p_email text, p_fono text, p_firma text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_reg uuid;
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_rut text := left(btrim(coalesce(p_rut, '')), 20);
  v_cargo text := left(btrim(coalesce(p_cargo, '')), 120);
  v_email text := left(btrim(coalesce(p_email, '')), 120);
  v_fono text := left(btrim(coalesce(p_fono, '')), 30);
  v_firma text := coalesce(p_firma, '');
  v_rut_norm text;
  v_repetido boolean;
begin
  -- Nombre (120) y firma (60 KB) se rechazan, igual que validarAsistencia (terreno-core.js).
  if v_nombre = '' or length(v_nombre) > 120 or length(v_firma) > 60 * 1024
     or (v_firma <> '' and v_firma !~ '^(data:image/png;base64,)?[A-Za-z0-9+/]+={0,2}$') then
    raise exception 'enlace no válido o actividad cerrada';
  end if;

  select t.registro_id into v_reg
  from public.rt_asistencia_tokens t
  join public.registros r on r.id = t.registro_id
  where t.token = p_token and r.asistencia_abierta
  for update of t;
  if v_reg is null then raise exception 'enlace no válido o actividad cerrada'; end if;

  -- Tope de 80 SOLO para este formulario público: es un freno al abuso del enlace abierto, no una regla de
  -- cuántas personas pueden asistir. El alta manual del PM (insert directo en rt_asistencias) no tiene tope,
  -- para no bloquear capacitaciones de más de 80 personas.
  if (select count(*) from public.rt_asistencias where registro_id = v_reg) >= 80 then
    raise exception 'enlace no válido o actividad cerrada';
  end if;

  v_rut_norm := lower(regexp_replace(v_rut, '[.\s]', '', 'g'));
  if v_rut_norm <> '' then
    select exists (select 1 from public.rt_asistencias
                   where registro_id = v_reg and lower(regexp_replace(coalesce(rut, ''), '[.\s]', '', 'g')) = v_rut_norm)
      into v_repetido;
  else
    select exists (select 1 from public.rt_asistencias
                   where registro_id = v_reg and app.rt_norm_nombre(nombre) = app.rt_norm_nombre(v_nombre))
      into v_repetido;
  end if;
  if v_repetido then raise exception 'ya estás registrado en esta actividad'; end if;

  insert into public.rt_asistencias (registro_id, nombre, rut, cargo, email, fono, firma, origen)
    values (v_reg, v_nombre, v_rut, v_cargo, v_email, v_fono, v_firma, 'qr');
  return true;
end $$;

-- create or replace conserva los permisos existentes; se reafirman por claridad.
revoke all on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) to anon, authenticated;
