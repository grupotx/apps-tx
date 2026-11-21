-- Terreno: el enlace del QR caduca. Si el PM nunca guarda la actividad, el borrador conserva asistencia_abierta = true y el
-- token aceptaba participantes para siempre. Ahora cada token guarda cuándo se abrió y las dos RPC anónimas
-- (rt_asistencia_info y rt_asistencia_agregar) exigen que sea de las últimas 48 horas.
--
-- 48 horas y no 24 a propósito: una charla puede empezar tarde y cerrarse a la mañana siguiente, y ningún participante
-- puede ser rechazado DURANTE la charla. Por eso tampoco hay un freno por tiempo entre registros de un mismo token:
-- esta ventana es solo un techo de vida del enlace, no un limitador de ritmo.
-- Solo aditivo: no borra ni reescribe datos. Las filas existentes quedan con abierto_en = now() (la fecha de esta migración),
-- así que los enlaces abiertos hoy viven 48 horas más; después caducan si nadie los reabre.

alter table public.rt_asistencia_tokens add column if not exists abierto_en timestamptz not null default now();

-- Abrir (o reabrir) la asistencia renueva el token y reinicia el plazo.
create or replace function public.rt_asistencia_abrir(p_registro uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare v_autor uuid; v_tok text;
begin
  select autor into v_autor from public.registros where id = p_registro for update;
  if not found or not app.rt_activo() or not (v_autor = auth.uid() or app.tiene_rol('admin')) then
    raise exception 'solo el autor o un admin pueden abrir la asistencia';
  end if;
  v_tok := replace(gen_random_uuid()::text, '-', '');  -- 32 caracteres
  insert into public.rt_asistencia_tokens (registro_id, token, abierto_en) values (p_registro, v_tok, now())
    on conflict (registro_id) do update set token = excluded.token, abierto_en = now();
  update public.registros set asistencia_abierta = true where id = p_registro;
  return v_tok;
end $$;

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
    and t.abierto_en > now() - interval '48 hours'
$$;

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
    and t.abierto_en > now() - interval '48 hours'
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

-- create or replace conserva los permisos; se reafirman por claridad.
revoke all on function public.rt_asistencia_abrir(uuid) from public, anon, authenticated;
grant execute on function public.rt_asistencia_abrir(uuid) to authenticated;
revoke all on function public.rt_asistencia_info(text) from public, anon, authenticated;
grant execute on function public.rt_asistencia_info(text) to anon, authenticated;
revoke all on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) to anon, authenticated;

-- ===== Comentarios que corrigen la migración 20261124 (ya aplicada, no se reedita) =====
-- Los comentarios del código pueden mentir; los de la base viajan con la función.
comment on function app.rt_norm_nombre(text) is
  'Normaliza un nombre para detectar duplicados: minúsculas, sin espacios sobrantes y sin tildes de las vocales, ü, ñ y las variantes con tilde grave/circunfleja (traduce 17 caracteres con translate). NO es igual a normNombre de terreno-core.js, que descompone con NFD y quita todas las marcas combinantes: un nombre con otro diacrítico (por ejemplo ç o ã) puede contar como distinto aquí y como igual en el cliente. Es solo una red de seguridad del lado del servidor para el registro por QR.';

comment on function app.rt_registros_restringir_edicion() is
  'Solo el autor o un admin pueden modificar un registro (cualquiera puede cambiar estado y updated_at). La salida "auth.uid() is null -> return new" es segura ÚNICAMENTE porque ninguna política de public.registros admite al rol anon: sin sesión de usuario solo llegan mantenimiento y service_role. Si algún día se agrega una política que permita escribir en registros a anon, este trigger dejaría de proteger y hay que revisar esa salida.';
