-- Registro de Terreno: asistencias por QR y permisos de edición.
-- Los participantes de una charla/capacitación cargan sus datos y firma desde una página pública (sin sesión)
-- mediante una RPC anónima protegida por un token por actividad. Solo aditivo: no borra ni reescribe datos.
--
-- Diferencia deliberada con el plan original: el token NO es una columna de public.registros. La app publicada
-- hoy hace select('*') sobre registros, y como anon/authenticated tienen SELECT a nivel de tabla, un
-- "revoke select (columna)" no tendría efecto; para que sí lo tuviera habría que quitar el SELECT de tabla
-- y la app publicada fallaría con "permission denied" hasta publicar el código nuevo. Una tabla aparte sin
-- ningún permiso para anon/authenticated da la misma garantía (el token no se lee por la API; el PM solo lo
-- recibe al ejecutar rt_asistencia_abrir) sin tocar los permisos de registros.

-- ===== Datos =====
alter table public.registros add column if not exists asistencia_abierta boolean not null default false;

create table if not exists public.rt_asistencias (
  id uuid primary key default gen_random_uuid(),
  registro_id uuid not null references public.registros(id) on delete cascade,
  nombre text not null,
  rut text default '',
  cargo text default '',
  email text default '',
  fono text default '',
  firma text default '',
  origen text not null default 'manual' check (origen in ('qr','manual')),
  created_at timestamptz not null default now()
);
create index if not exists rt_asistencias_registro_idx on public.rt_asistencias (registro_id);

-- Token vigente de cada actividad con asistencia abierta (una fila por registro; se borra al cerrar).
create table if not exists public.rt_asistencia_tokens (
  registro_id uuid primary key references public.registros(id) on delete cascade,
  token text not null unique
);

-- ===== Permisos de tablas =====
alter table public.rt_asistencias enable row level security;
alter table public.rt_asistencia_tokens enable row level security;  -- sin políticas ni permisos: solo las RPC (definer) la tocan

revoke all on public.rt_asistencias from public, anon, authenticated;
grant select, insert, update, delete on public.rt_asistencias to authenticated;
revoke all on public.rt_asistencia_tokens from public, anon, authenticated;

drop policy if exists "rt asist leer" on public.rt_asistencias;
create policy "rt asist leer" on public.rt_asistencias for select to authenticated using (app.rt_activo());
drop policy if exists "rt asist editar" on public.rt_asistencias;
create policy "rt asist editar" on public.rt_asistencias for update to authenticated using (app.rt_activo()) with check (app.rt_activo());
drop policy if exists "rt asist borrar" on public.rt_asistencias;
create policy "rt asist borrar" on public.rt_asistencias for delete to authenticated using (app.rt_activo());
drop policy if exists "rt asist crear" on public.rt_asistencias;
create policy "rt asist crear" on public.rt_asistencias for insert to authenticated
  with check (app.rt_activo() and exists (
    select 1 from public.registros r
    where r.id = registro_id and (r.autor = auth.uid() or app.tiene_rol('admin'))));

-- ===== Edición de registros: quien no es autor ni admin solo puede cambiar estado =====
-- La política de UPDATE de registros se mantiene (app.rt_activo()): la app publicada cambia el estado de una
-- visita con un update directo y debe seguir funcionando mientras se publica el código nuevo.
create or replace function app.rt_registros_restringir_edicion()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if auth.uid() is null then return new; end if;  -- mantenimiento / service_role, sin sesión de usuario
  if old.autor = auth.uid() or app.tiene_rol('admin') then return new; end if;
  if (to_jsonb(new) - 'estado' - 'updated_at') is distinct from (to_jsonb(old) - 'estado' - 'updated_at') then
    raise exception 'solo el autor o un admin pueden modificar este registro' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function app.rt_registros_restringir_edicion() from public, anon, authenticated;

drop trigger if exists rt_registros_edicion_trg on public.registros;
create trigger rt_registros_edicion_trg before update on public.registros
  for each row execute function app.rt_registros_restringir_edicion();

-- ===== Normalización de nombres (igual que normNombre de terreno-core.js) =====
create or replace function app.rt_norm_nombre(p text)
returns text
language sql
immutable
set search_path to ''
as $$
  select regexp_replace(translate(lower(btrim(coalesce(p, ''))), 'áéíóúüñàèìòùâêîôû', 'aeiouunaeiouaeiou'), '\s+', ' ', 'g')
$$;
revoke all on function app.rt_norm_nombre(text) from public, anon, authenticated;

-- ===== RPC del PM (autenticadas) =====
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
  insert into public.rt_asistencia_tokens (registro_id, token) values (p_registro, v_tok)
    on conflict (registro_id) do update set token = excluded.token;
  update public.registros set asistencia_abierta = true where id = p_registro;
  return v_tok;
end $$;

create or replace function public.rt_asistencia_cerrar(p_registro uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare v_autor uuid;
begin
  select autor into v_autor from public.registros where id = p_registro for update;
  if not found or not app.rt_activo() or not (v_autor = auth.uid() or app.tiene_rol('admin')) then
    raise exception 'solo el autor o un admin pueden cerrar la asistencia';
  end if;
  delete from public.rt_asistencia_tokens where registro_id = p_registro;
  update public.registros set asistencia_abierta = false where id = p_registro;
end $$;

-- ===== RPC públicas (anónimas) =====
-- Datos mínimos de la actividad para mostrar en la página del QR; sin filas si el token no existe o está cerrado.
create or replace function public.rt_asistencia_info(p_token text)
returns table (actividad text, cliente text, obra text, fecha date)
language sql
stable
security definer
set search_path to ''
as $$
  select r.kind, r.cliente, r.obra, r.fecha
  from public.rt_asistencia_tokens t
  join public.registros r on r.id = t.registro_id
  where t.token = p_token and r.asistencia_abierta
$$;

-- Sin espera entre envíos (con el QR proyectado se registran ~30 personas a la vez); el bloqueo de la fila del
-- token serializa los envíos de una misma actividad para que el tope y los duplicados no se salten en paralelo.
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
  v_rut text := btrim(coalesce(p_rut, ''));
  v_cargo text := btrim(coalesce(p_cargo, ''));
  v_email text := btrim(coalesce(p_email, ''));
  v_fono text := btrim(coalesce(p_fono, ''));
  v_firma text := coalesce(p_firma, '');
  v_rut_norm text;
  v_repetido boolean;
begin
  -- Mismos límites que validarAsistencia (terreno-core.js): nombre 120, firma 60 KB, 80 por actividad.
  if v_nombre = '' or length(v_nombre) > 120 or length(v_rut) > 20 or length(v_cargo) > 120
     or length(v_email) > 120 or length(v_fono) > 30 or length(v_firma) > 60 * 1024
     or (v_firma <> '' and v_firma !~ '^(data:image/png;base64,)?[A-Za-z0-9+/]+={0,2}$') then
    raise exception 'enlace no válido o actividad cerrada';
  end if;

  select t.registro_id into v_reg
  from public.rt_asistencia_tokens t
  join public.registros r on r.id = t.registro_id
  where t.token = p_token and r.asistencia_abierta
  for update of t;
  if v_reg is null then raise exception 'enlace no válido o actividad cerrada'; end if;

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

-- ===== Ejecución: nada por defecto; solo los roles que lo necesitan =====
revoke all on function public.rt_asistencia_abrir(uuid) from public, anon, authenticated;
revoke all on function public.rt_asistencia_cerrar(uuid) from public, anon, authenticated;
revoke all on function public.rt_asistencia_info(text) from public, anon, authenticated;
revoke all on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.rt_asistencia_abrir(uuid) to authenticated;
grant execute on function public.rt_asistencia_cerrar(uuid) to authenticated;
grant execute on function public.rt_asistencia_info(text) to anon, authenticated;
grant execute on function public.rt_asistencia_agregar(text, text, text, text, text, text, text) to anon, authenticated;
