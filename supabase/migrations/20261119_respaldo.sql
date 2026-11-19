-- Respaldo de Apps TX en Google Drive: cola, archivos, contadores y disparadores.
-- Diseño: docs/superpowers/specs/2026-11-19-respaldo-drive-design.md

create table if not exists public.respaldo_cola (
  id bigserial primary key,
  app text not null,
  tabla text not null,
  registro_id text not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','enviado','error','eliminado')),
  intentos int not null default 0,
  ultimo_error text,
  numero int,
  drive_folder_id text,
  drive_url text,
  listo_desde timestamptz not null default now(),
  creado_at timestamptz not null default now(),
  enviado_at timestamptz,
  unique (tabla, registro_id)
);
create index if not exists respaldo_cola_pend_idx on public.respaldo_cola (estado, listo_desde);

create table if not exists public.respaldo_archivos (
  id bigserial primary key,
  cola_id bigint not null references public.respaldo_cola(id) on delete cascade,
  bucket text not null,
  ruta text not null,
  nombre_drive text,
  drive_file_id text,
  subido_at timestamptz,
  borrado_supabase_at timestamptz,
  unique (bucket, ruta)
);
create index if not exists respaldo_archivos_cola_idx on public.respaldo_archivos (cola_id);

create table if not exists public.respaldo_contadores (
  app text primary key,
  ultimo int not null default 0
);

alter table public.respaldo_cola enable row level security;
alter table public.respaldo_archivos enable row level security;
alter table public.respaldo_contadores enable row level security;
revoke all on public.respaldo_cola, public.respaldo_archivos, public.respaldo_contadores from anon, authenticated;

-- Encola (o reprograma) un envío. Agrupa ediciones: cada cambio corre la espera a now()+5 min.
create or replace function app.respaldo_encolar(p_app text, p_tabla text, p_id text, p_eliminado boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.respaldo_cola (app, tabla, registro_id, estado, listo_desde)
  values (p_app, p_tabla, p_id, case when p_eliminado then 'eliminado' else 'pendiente' end, now() + interval '5 minutes')
  on conflict (tabla, registro_id) do update
    set estado = case when p_eliminado then 'eliminado' else 'pendiente' end,
        listo_desde = now() + interval '5 minutes',
        intentos = 0,
        ultimo_error = null;
end $$;
revoke all on function app.respaldo_encolar(text, text, text, boolean) from public, anon, authenticated;

-- Disparador genérico: TG_ARGV[0] = app.
create or replace function app.respaldo_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r record; v_id text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if tg_table_name = 'mtto_docs' then
    if r.coleccion not in ('chk','ots') then return null; end if;
    v_id := r.coleccion || ':' || r.id;
  else
    v_id := r.id::text;
  end if;
  perform app.respaldo_encolar(tg_argv[0], tg_table_name, v_id, tg_op = 'DELETE');
  return null;
end $$;
revoke all on function app.respaldo_trigger() from public, anon, authenticated;

drop trigger if exists respaldo_trg on public.ent_entregas;
create trigger respaldo_trg after insert or update or delete on public.ent_entregas for each row execute function app.respaldo_trigger('entregas');
drop trigger if exists respaldo_trg on public.registros;
create trigger respaldo_trg after insert or update or delete on public.registros for each row execute function app.respaldo_trigger('terreno');
drop trigger if exists respaldo_trg on public.eventos;
create trigger respaldo_trg after insert or update or delete on public.eventos for each row execute function app.respaldo_trigger('silos');
drop trigger if exists respaldo_trg on public.solicitudes;
create trigger respaldo_trg after insert or update or delete on public.solicitudes for each row execute function app.respaldo_trigger('silos');
drop trigger if exists respaldo_trg on public.crm_visits;
create trigger respaldo_trg after insert or update or delete on public.crm_visits for each row execute function app.respaldo_trigger('crm');
drop trigger if exists respaldo_trg on public.mtto_docs;
create trigger respaldo_trg after insert or update or delete on public.mtto_docs for each row execute function app.respaldo_trigger('mantencion');

-- Número de envío: estable por fila de cola, correlativo por app. Solo service_role.
create or replace function public.respaldo_asignar_numero(p_cola_id bigint)
returns int language plpgsql security definer set search_path = '' as $$
declare v_app text; v_num int;
begin
  select app, numero into v_app, v_num from public.respaldo_cola where id = p_cola_id for update;
  if v_app is null then raise exception 'cola % no existe', p_cola_id; end if;
  if v_num is not null then return v_num; end if;
  insert into public.respaldo_contadores (app, ultimo) values (v_app, 1)
    on conflict (app) do update set ultimo = public.respaldo_contadores.ultimo + 1
    returning ultimo into v_num;
  update public.respaldo_cola set numero = v_num where id = p_cola_id;
  return v_num;
end $$;
revoke all on function public.respaldo_asignar_numero(bigint) from public, anon, authenticated;
grant execute on function public.respaldo_asignar_numero(bigint) to service_role;
