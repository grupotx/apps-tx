-- Reclamos, Tarea 1: esquema base, planta por producto y motivos.
-- Spec: docs/superpowers/specs/2026-11-27-reclamos-design.md
-- Toda escritura posterior pasa por funciones security definer (Tareas 4 y 5); aquí solo se crean
-- las tablas, sus CHECK y la RLS habilitada (las políticas de lectura llegan en la Tarea 3).

-- ───────────────────────── Planta de un producto (a partir de su familia) ─────────────────────────
create or replace function public.rec_planta_de_familia(p_familia text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when upper(btrim(coalesce(p_familia, ''))) like 'PINTURAS%' then 'pinturas'
    when upper(btrim(coalesce(p_familia, ''))) in ('MORTEROS', 'MORT BAS', 'MORT REP', 'ESPECIALES', 'ESTUCOS', 'GRANELES') then 'morteros'
    when upper(btrim(coalesce(p_familia, ''))) = 'CEMENTO' then 'cementos'
    else 'adhesivos'
  end
$$;

-- crm_products.planta: se agrega nullable, se rellena desde la familia y luego se exige.
alter table public.crm_products add column if not exists planta text;
update public.crm_products set planta = public.rec_planta_de_familia(family) where planta is null or btrim(planta) = '';
alter table public.crm_products alter column planta set not null;
alter table public.crm_products drop constraint if exists crm_products_planta_check;
alter table public.crm_products add constraint crm_products_planta_check
  check (planta in ('pinturas', 'morteros', 'adhesivos', 'cementos'));

-- Si llega vacía (insert sin planta, o un update que la deja nula/en blanco), se deduce de la familia.
-- Una planta explícita (corregida a mano) se respeta.
create or replace function public.crm_products_planta_fill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.planta is null or btrim(new.planta) = '' then
    new.planta := public.rec_planta_de_familia(new.family);
  end if;
  return new;
end
$$;
drop trigger if exists crm_products_planta_fill on public.crm_products;
create trigger crm_products_planta_fill
  before insert or update on public.crm_products
  for each row execute function public.crm_products_planta_fill();

-- ───────────────────────── Acceso al módulo (patrón de Mantención/Terreno) ─────────────────────────
create table if not exists public.rec_usuarios (
  id uuid primary key references public.profiles(id) on delete cascade,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

-- Una fila por persona, rol, área y planta. La forma válida de cada rol la fija el CHECK de abajo
-- (la misma regla que valida rec_set_alcance en la Tarea 5).
create table if not exists public.rec_alcances (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.rec_usuarios(id) on delete cascade,
  rol text not null check (rol in ('servicio_cliente', 'asesor_tecnico', 'encargado_area', 'encargado_calidad', 'gerencia')),
  area text check (area in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial')),
  planta text check (planta in ('pinturas', 'morteros', 'adhesivos', 'cementos')),
  creado_en timestamptz not null default now(),
  constraint rec_alcances_unico unique nulls not distinct (usuario_id, rol, area, planta),
  constraint rec_alcances_forma check (
    case rol
      when 'encargado_area' then area is not null and (planta is not null) = (area in ('calidad', 'produccion'))
      when 'encargado_calidad' then area is null and planta is not null
      else area is null and planta is null
    end
  )
);

-- ───────────────────────── Catálogo de motivos ─────────────────────────
create table if not exists public.rec_motivos (
  id text primary key,
  nombre text not null check (btrim(nombre) <> ''),
  requiere_producto boolean not null default false,
  area_sugerida text check (area_sugerida in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial')),
  orden int not null default 0,
  activo boolean not null default true
);

insert into public.rec_motivos (id, nombre, requiere_producto, area_sugerida, orden) values
  ('calidad_producto',            'Calidad del producto',            true,  'calidad',   1),
  ('producto_equivocado_faltante', 'Producto equivocado o faltante',  true,  'logistica', 2),
  ('atraso_despacho',             'Atraso en despacho',              false, 'logistica', 3),
  ('dano_transporte',             'Daño en transporte',              true,  'logistica', 4),
  ('facturacion_cobro',           'Facturación o cobro',             false, 'finanzas',  5),
  ('condiciones_comerciales',     'Precio o condiciones comerciales', false, 'comercial', 6),
  ('otro',                        'Otro',                            false, null,        7)
on conflict (id) do nothing;

-- ───────────────────────── Folio REC-AAAA-NNNN ─────────────────────────
-- Contador por año en una tabla (no una secuencia): se revierte con la transacción, así una prueba
-- con rollback o un ingreso fallido no deja huecos en la numeración.
create table if not exists public.rec_folios (
  anio int primary key,
  ultimo int not null default 0
);

create or replace function public.rec_siguiente_folio()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anio int := extract(year from (now() at time zone 'America/Santiago'))::int;
  v_n int;
begin
  insert into public.rec_folios (anio, ultimo) values (v_anio, 1)
    on conflict (anio) do update set ultimo = public.rec_folios.ultimo + 1
    returning ultimo into v_n;
  return 'REC-' || v_anio::text || '-' || lpad(v_n::text, 4, '0');
end
$$;
revoke all on function public.rec_siguiente_folio() from public, anon, authenticated;

-- ───────────────────────── Reclamos, historia y adjuntos ─────────────────────────
create table if not exists public.rec_reclamos (
  id uuid primary key default gen_random_uuid(),
  folio text not null unique default public.rec_siguiente_folio(),
  cliente_id uuid not null references public.crm_clients(id),
  producto text references public.crm_products(code),
  planta text check (planta in ('pinturas', 'morteros', 'adhesivos', 'cementos')),
  motivo text not null references public.rec_motivos(id),
  descripcion text not null check (btrim(descripcion) <> ''),
  fecha_recepcion date not null check (fecha_recepcion <= current_date),
  estado text not null default 'ingresado' check (estado in
    ('ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado', 'cerrado', 'anulado')),
  area_destino text check (area_destino in ('calidad', 'produccion', 'logistica', 'finanzas', 'comercial')),
  planta_destino text check (planta_destino in ('pinturas', 'morteros', 'adhesivos', 'cementos')),
  asesor_id uuid references public.profiles(id),
  informe text,
  visita_registro_id uuid references public.registros(id) on delete set null,
  decision text check (decision in ('aprobado', 'rechazado')),
  razones text,
  decidido_por uuid references public.profiles(id),
  decidido_en timestamptz,
  solucion_tipo text check (solucion_tipo in ('nota_credito', 'reposicion', 'descuento', 'devolucion', 'asesoria', 'explicacion')),
  solucion_detalle text,
  compensacion bigint check (compensacion >= 0),
  mensaje_cliente text,
  canal text,
  comunicado_por uuid references public.profiles(id),
  comunicado_en timestamptz,
  cerrado_en timestamptz,
  datos jsonb not null default '{}'::jsonb,
  creado_por uuid not null references public.profiles(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists rec_reclamos_estado_idx on public.rec_reclamos (estado);
create index if not exists rec_reclamos_cliente_idx on public.rec_reclamos (cliente_id);
create index if not exists rec_reclamos_creado_por_idx on public.rec_reclamos (creado_por);
create index if not exists rec_reclamos_asesor_idx on public.rec_reclamos (asesor_id) where asesor_id is not null;
create index if not exists rec_reclamos_motivo_idx on public.rec_reclamos (motivo);
create index if not exists rec_reclamos_producto_idx on public.rec_reclamos (producto) where producto is not null;
create index if not exists rec_reclamos_creado_en_idx on public.rec_reclamos (creado_en desc);

create or replace function public.rec_reclamos_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  return new;
end
$$;
drop trigger if exists rec_reclamos_touch on public.rec_reclamos;
create trigger rec_reclamos_touch before update on public.rec_reclamos
  for each row execute function public.rec_reclamos_touch();

create table if not exists public.rec_eventos (
  id bigint generated always as identity primary key,
  reclamo_id uuid not null references public.rec_reclamos(id) on delete cascade,
  tipo text not null,
  de_estado text,
  a_estado text,
  usuario uuid not null references public.profiles(id),
  nota text,
  detalle jsonb,
  creado_en timestamptz not null default now()
);
create index if not exists rec_eventos_reclamo_idx on public.rec_eventos (reclamo_id, creado_en);

create table if not exists public.rec_adjuntos (
  id uuid primary key default gen_random_uuid(),
  reclamo_id uuid not null references public.rec_reclamos(id) on delete cascade,
  tipo text not null check (tipo in ('foto', 'informe', 'otro')),
  ruta text not null,
  subido_por uuid not null references public.profiles(id),
  creado_en timestamptz not null default now()
);
create index if not exists rec_adjuntos_reclamo_idx on public.rec_adjuntos (reclamo_id);

-- ───────────────────────── RLS: habilitada, sin políticas (llegan en la Tarea 3) ─────────────────────────
alter table public.rec_usuarios enable row level security;
alter table public.rec_alcances enable row level security;
alter table public.rec_motivos enable row level security;
alter table public.rec_reclamos enable row level security;
alter table public.rec_eventos enable row level security;
alter table public.rec_adjuntos enable row level security;
alter table public.rec_folios enable row level security;

-- ───────────────────────── Acceso al módulo ─────────────────────────
create or replace function app.rec_activo()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(select 1 from public.rec_usuarios u join public.profiles p on p.id = u.id
                where u.id = auth.uid() and u.activo and p.activo)
      or app.tiene_rol(variadic array['admin'])
$$;
revoke all on function app.rec_activo() from public, anon;
grant execute on function app.rec_activo() to authenticated;

create or replace function public.rec_tengo_acceso()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select app.rec_activo() $$;
revoke all on function public.rec_tengo_acceso() from public, anon;
grant execute on function public.rec_tengo_acceso() to authenticated, service_role;
