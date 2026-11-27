-- Reclamos: varios productos por reclamo y quién reclama.
--  1. rec_reclamos.productos: lista [{code, nombre, planta}] de hasta 10 productos sin repetir. producto, producto_nombre y
--     planta siguen siendo los del primero (bandeja, filtros, RLS y derivación no cambian). Los reclamos anteriores se
--     rellenan con su único producto.
--  2. Reclamante (vendedor o cliente): tipo, id (perfil del vendedor), nombre, correo y teléfono. Del vendedor, el nombre
--     y el correo los toma la base del perfil; el teléfono viaja en la petición y, si no viene, se usa el del perfil.
--     profiles.telefono lo mantiene el administrador (admin_set_telefono) y se ve en admin_usuarios.
--  3. rec_crear y rec_actualizar reciben la lista y el reclamante (se eliminan las firmas anteriores); rec_vendedores
--     entrega la lista para elegir. Mensajes idénticos a reclamos-core.js. RLS sin cambios.

-- ───────────────────────── Columnas ─────────────────────────
alter table public.rec_reclamos
  add column if not exists productos jsonb not null default '[]'::jsonb,
  add column if not exists reclamante_tipo text,
  add column if not exists reclamante_id uuid references public.profiles(id) on delete set null,
  add column if not exists reclamante_nombre text,
  add column if not exists reclamante_correo text,
  add column if not exists reclamante_telefono text;
alter table public.rec_reclamos
  add constraint rec_reclamos_productos_check
    check (case when jsonb_typeof(productos) = 'array' then jsonb_array_length(productos) <= 10 else false end),
  add constraint rec_reclamos_reclamante_tipo_check check (reclamante_tipo in ('vendedor', 'cliente'));
create index if not exists rec_reclamos_reclamante_id_idx on public.rec_reclamos (reclamante_id);

update public.rec_reclamos r
   set productos = jsonb_build_array(jsonb_build_object(
         'code', r.producto, 'nombre', coalesce(r.producto_nombre, p.name), 'planta', coalesce(r.planta, p.planta)))
  from public.crm_products p
 where p.code = r.producto and r.producto is not null and r.productos = '[]'::jsonb;

alter table public.profiles add column if not exists telefono text;

-- ───────────────────────── Ayudantes internos ─────────────────────────
-- Recorta como String.prototype.trim y vacío → null. Mismo conjunto que JS: tab, LF, VT, FF, CR, espacio, NBSP, U+1680,
-- U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 y U+FEFF (BOM).
create or replace function app.rec_txt(p text)
returns text language sql immutable security definer set search_path = ''
as $$
  select nullif(btrim(coalesce(p, ''),
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197) || chr(8198) || chr(8199) || chr(8200)
    || chr(8201) || chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279)), '')
$$;

-- Teléfono recortado (null si viene vacío). Solo dígitos, espacios y + ( ) - . ; máximo 30 caracteres y al menos 7 dígitos.
create or replace function app.rec_normalizar_telefono(p_tel text)
returns text language plpgsql immutable security definer set search_path = ''
as $$
declare
  v text := app.rec_txt(p_tel);
begin
  if v is not null and (length(v) > 30 or v !~ '^[0-9 +().-]+$' or length(regexp_replace(v, '[^0-9]', '', 'g')) < 7) then
    raise exception 'El teléfono debe tener al menos 7 dígitos.';
  end if;
  return v;
end
$$;

-- Lista de códigos → [{code, nombre, planta}] en el mismo orden. Descarta los elementos en blanco; máximo 10, sin repetir.
create or replace function app.rec_normalizar_productos(p_codigos text[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_cod text[];
  v_res jsonb;
  v_n int;
begin
  select coalesce(array_agg(t.c order by t.o), '{}') into v_cod
    from (select app.rec_txt(u.x) c, u.o from unnest(p_codigos) with ordinality u(x, o)) t
   where t.c is not null;
  if cardinality(v_cod) > 10 then raise exception 'Máximo 10 productos por reclamo.'; end if;
  if (select count(distinct c) from unnest(v_cod) c) < cardinality(v_cod) then raise exception 'Hay productos repetidos.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', p.code, 'nombre', p.name, 'planta', p.planta) order by u.o), '[]'::jsonb), count(p.code)
    into v_res, v_n
    from unnest(v_cod) with ordinality u(c, o) left join public.crm_products p on p.code = u.c;
  if v_n < cardinality(v_cod) then raise exception 'El producto indicado no existe.'; end if;
  return v_res;
end
$$;

-- {tipo, id?, nombre?, correo?, telefono?} → {tipo, id, nombre, correo, telefono} validado y recortado.
create or replace function app.rec_normalizar_reclamante(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tipo text;
  v_id text;
  v_nombre text;
  v_correo text;
  v_tel text;
  pf public.profiles;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Indica quién reclama: vendedor o cliente.'; end if;
  v_tipo := p->>'tipo';
  if v_tipo is null or v_tipo not in ('vendedor', 'cliente') then raise exception 'Indica quién reclama: vendedor o cliente.'; end if;
  if v_tipo = 'vendedor' then
    v_id := app.rec_txt(p->>'id');
    if v_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into pf from public.profiles x where x.id = v_id::uuid and x.activo and x.rol::text = 'vendedor';
    end if;
    if pf.id is null then raise exception 'El vendedor elegido no existe o no está activo.'; end if;
    v_tel := coalesce(app.rec_normalizar_telefono(p->>'telefono'), app.rec_txt(pf.telefono));
    return jsonb_build_object('tipo', 'vendedor', 'id', pf.id, 'nombre', coalesce(app.rec_txt(pf.nombre), pf.email),
                              'correo', pf.email, 'telefono', v_tel);
  end if;
  v_nombre := app.rec_txt(p->>'nombre');
  v_correo := app.rec_txt(p->>'correo');
  v_tel := app.rec_txt(p->>'telefono');
  if v_nombre is null then raise exception 'Escribe el nombre de quien reclama.'; end if;
  if v_correo is null and v_tel is null then raise exception 'Indica un correo o un teléfono de contacto.'; end if;
  -- Equivale a /^[^\s@]+@[^\s@]+\.[^\s@]+$/ de JS. Se listan los espacios de \s de JS uno a uno: [[:space:]] no
  -- sirve porque no incluye U+FEFF y sí incluye U+0085.
  if v_correo is not null and v_correo !~
       '^[^\t\n\v\f\r    -     　﻿@]+@[^\t\n\v\f\r    -     　﻿@]+\.[^\t\n\v\f\r    -     　﻿@]+$' then
    raise exception 'El correo no tiene un formato válido.';
  end if;
  return jsonb_build_object('tipo', 'cliente', 'id', null, 'nombre', v_nombre, 'correo', v_correo,
                            'telefono', app.rec_normalizar_telefono(v_tel));
end
$$;

revoke all on function app.rec_txt(text) from public, anon, authenticated;
revoke all on function app.rec_normalizar_telefono(text) from public, anon, authenticated;
revoke all on function app.rec_normalizar_productos(text[]) from public, anon, authenticated;
revoke all on function app.rec_normalizar_reclamante(jsonb) from public, anon, authenticated;

-- ───────────────────────── Ingreso ─────────────────────────
drop function if exists public.rec_crear(uuid, text, text, text, date, jsonb);
create or replace function public.rec_crear(
  p_cliente_id uuid, p_productos text[], p_motivo text, p_descripcion text, p_fecha_recepcion date,
  p_datos jsonb default '{}'::jsonb, p_reclamante jsonb default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  m public.rec_motivos;
  v_prods jsonb;
  v_rec jsonb;
  v_cli_nombre text;
  v_datos jsonb := coalesce(p_datos, '{}'::jsonb);
  v_hoy date := (now() at time zone 'America/Santiago')::date;
  v_id uuid;
begin
  perform app.rec_exigir_acceso();
  select coalesce(nullif(btrim(c.name), ''), c.razon) into v_cli_nombre from public.crm_clients c where c.id = p_cliente_id;
  if p_cliente_id is null or not found then raise exception 'El cliente no existe.'; end if;
  if not (app.rec_es_servicio() or public.crm_can_see_client(p_cliente_id)
          or app.tiene_rol(variadic array['vendedor', 'tecnico', 'supervisor', 'admin'])) then
    raise exception 'No puedes ingresar reclamos de este cliente.';
  end if;
  select * into m from public.rec_motivos where id = p_motivo and activo;
  if not found then raise exception 'El motivo elegido no existe o está inactivo.'; end if;
  v_prods := app.rec_normalizar_productos(p_productos);
  if m.requiere_producto and jsonb_array_length(v_prods) = 0 then raise exception 'Este motivo exige indicar el producto.'; end if;
  v_rec := app.rec_normalizar_reclamante(p_reclamante);
  if nullif(btrim(coalesce(p_descripcion, '')), '') is null then raise exception 'Escribe la descripción del reclamo.'; end if;
  if p_fecha_recepcion is null then raise exception 'Indica la fecha de recepción.'; end if;
  if p_fecha_recepcion > v_hoy then raise exception 'La fecha de recepción no puede ser futura.'; end if;
  if p_fecha_recepcion < v_hoy - 365 then raise exception 'La fecha de recepción tiene más de un año de antigüedad; revísala.'; end if;
  if jsonb_typeof(v_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
  if length(v_datos::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;

  insert into public.rec_reclamos (cliente_id, cliente_nombre, producto, producto_nombre, planta, productos, motivo, descripcion,
                                   fecha_recepcion, datos, creado_por, reclamante_tipo, reclamante_id, reclamante_nombre,
                                   reclamante_correo, reclamante_telefono)
    values (p_cliente_id, v_cli_nombre, v_prods->0->>'code', v_prods->0->>'nombre', v_prods->0->>'planta', v_prods, m.id,
            btrim(p_descripcion), p_fecha_recepcion, v_datos, v_uid, v_rec->>'tipo', (v_rec->>'id')::uuid, v_rec->>'nombre',
            v_rec->>'correo', v_rec->>'telefono')
    returning id into v_id;
  insert into public.rec_eventos (reclamo_id, tipo, de_estado, a_estado, usuario) values (v_id, 'creado', null, 'ingresado', v_uid);
  return v_id;
end
$$;

-- ───────────────────────── Completar productos, reclamante y datos adicionales ─────────────────────────
-- Servicio al cliente/admin (todo, en cualquier estado salvo cerrado/anulado) y el asesor asignado mientras verifica
-- (solo datos). p_productos null = sin cambio; un arreglo es la lista completa nueva. Los datos se mezclan con los
-- existentes; un valor vacío quita la clave. El evento guarda lo anterior.
drop function if exists public.rec_actualizar(uuid, text, jsonb, timestamptz);
create or replace function public.rec_actualizar(
  p_id uuid, p_productos text[] default null, p_datos jsonb default null, p_version timestamptz default null,
  p_reclamante jsonb default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  r public.rec_reclamos;
  v_uid uuid := auth.uid();
  v_sc boolean;
  v_asesor boolean;
  v_prods jsonb;
  v_rec jsonb;
  v_rec_ant jsonb;
  v_merged jsonb;
begin
  perform app.rec_exigir_acceso();
  r := app.rec_bloquear(p_id);
  v_sc := app.rec_es_servicio();
  v_asesor := r.estado = 'en_verificacion' and r.asesor_id = v_uid
              and exists (select 1 from app.rec_alcances_de(v_uid) a where a.rol = 'asesor_tecnico');
  if not (v_sc or v_asesor) then
    raise exception 'Solo servicio al cliente, o el asesor asignado durante la verificación, pueden completar los datos del reclamo.';
  end if;
  if r.estado in ('cerrado', 'anulado') then raise exception 'Un reclamo cerrado o anulado no se puede modificar.'; end if;
  if p_productos is not null and not v_sc then raise exception 'Solo servicio al cliente puede cambiar el producto.'; end if;
  if p_reclamante is not null and not v_sc then raise exception 'Solo servicio al cliente puede cambiar los datos del reclamante.'; end if;
  if p_productos is null and p_datos is null and p_reclamante is null then raise exception 'No hay nada que actualizar.'; end if;
  if p_productos is not null then
    v_prods := app.rec_normalizar_productos(p_productos);
    if jsonb_array_length(v_prods) = 0 then raise exception 'Indica al menos un producto.'; end if;
  end if;
  if p_reclamante is not null then
    v_rec := app.rec_normalizar_reclamante(p_reclamante);
    if r.reclamante_tipo is not null then
      v_rec_ant := jsonb_build_object('tipo', r.reclamante_tipo, 'id', r.reclamante_id, 'nombre', r.reclamante_nombre,
                                      'correo', r.reclamante_correo, 'telefono', r.reclamante_telefono);
    end if;
  end if;
  v_merged := r.datos;
  if p_datos is not null then
    if jsonb_typeof(p_datos) <> 'object' then raise exception 'Los datos adicionales deben ser un objeto.'; end if;
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_merged
      from jsonb_each(r.datos || p_datos) e
     where e.value <> '""'::jsonb and e.value <> 'null'::jsonb;
    if length(v_merged::text) > 8000 then raise exception 'Los datos adicionales son demasiado largos.'; end if;
  end if;
  perform app.rec_mover(p_id,
    array['ingresado', 'derivado', 'en_verificacion', 'aprobado', 'rechazado', 'solucion_definida', 'comunicado'],
    r.estado, 'datos_actualizados', null,
    jsonb_build_object('producto_anterior', r.producto, 'producto_nuevo', v_prods->0->>'code',
                       'productos_anteriores', r.productos, 'productos_nuevos', v_prods,
                       'reclamante_anterior', v_rec_ant, 'datos_anteriores', r.datos), p_version);
  update public.rec_reclamos
     set productos = coalesce(v_prods, productos),
         producto = case when v_prods is not null then v_prods->0->>'code' else producto end,
         producto_nombre = case when v_prods is not null then v_prods->0->>'nombre' else producto_nombre end,
         planta = case when v_prods is not null then v_prods->0->>'planta' else planta end,
         reclamante_tipo = case when v_rec is not null then v_rec->>'tipo' else reclamante_tipo end,
         reclamante_id = case when v_rec is not null then (v_rec->>'id')::uuid else reclamante_id end,
         reclamante_nombre = case when v_rec is not null then v_rec->>'nombre' else reclamante_nombre end,
         reclamante_correo = case when v_rec is not null then v_rec->>'correo' else reclamante_correo end,
         reclamante_telefono = case when v_rec is not null then v_rec->>'telefono' else reclamante_telefono end,
         datos = v_merged
   where id = p_id;
end
$$;

-- ───────────────────────── Vendedores para elegir ─────────────────────────
create or replace function public.rec_vendedores()
returns table(id uuid, nombre text, email text, telefono text) language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app.rec_exigir_acceso();
  return query
    select p.id, p.nombre, p.email, p.telefono
      from public.profiles p
     where p.activo and p.rol::text = 'vendedor'
     order by coalesce(p.nombre, p.email), p.id;
end
$$;

-- ───────────────────────── Teléfono del perfil (administración) ─────────────────────────
create or replace function public.admin_set_telefono(p_id uuid, p_telefono text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not app.tiene_rol(variadic array['admin']) then raise exception 'sin permiso'; end if;
  update public.profiles set telefono = app.rec_normalizar_telefono(p_telefono) where id = p_id;
end
$$;

-- admin_usuarios: igual que la versión vigente, con telefono después de cargo.
drop function if exists public.admin_usuarios();
create or replace function public.admin_usuarios()
returns table(id uuid, nombre text, email text, cargo text, telefono text, cuenta_activa boolean, creado timestamp with time zone, modulos jsonb)
language sql stable security definer set search_path = ''
as $$
  select p.id, p.nombre, p.email, p.cargo, p.telefono, p.activo, p.created_at,
    jsonb_build_object(
      'silos', jsonb_build_object('activo', p.activo and p.rol::text <> 'pendiente', 'rol', p.rol::text),
      'crm',   jsonb_build_object('activo', coalesce(c.active,false), 'rol', c.role),
      'ent',   jsonb_build_object('activo', coalesce(e.activo,false) and coalesce(e.rol,'pendiente') <> 'pendiente', 'rol', e.rol),
      'tur',   jsonb_build_object('activo', coalesce(t.activo,false), 'rol', t.rol),
      'rt',    jsonb_build_object('activo', coalesce(r.activo,false), 'rol', null),
      'rec',   jsonb_build_object('activo', coalesce(rc.activo,false), 'rol', null),
      'cp',    jsonb_build_object('activo', coalesce(q.activo,false), 'rol', q.rol),
      'mtto',  jsonb_build_object('activo', coalesce(m.activo,false), 'rol', m.rol))
    || ra.j
  from public.profiles p
  left join public.crm_profiles c on c.id = p.id
  left join public.ent_usuarios e on e.id = p.id
  left join public.tur_usuarios t on t.id = p.id
  left join public.rt_usuarios r on r.id = p.id
  left join public.rec_usuarios rc on rc.id = p.id
  left join public.cp_usuarios q on q.id = p.id
  left join public.mtto_usuarios m on m.id = p.id
  left join lateral (
    select jsonb_object_agg('rep_' || k.modulo, jsonb_build_object('activo', coalesce(a.activo,false), 'rol', null)) as j
    from (values ('resumen'),('comercial'),('logistica'),('produccion'),('estado_planta'),('rrhh'),('finanzas'),('costos')) as k(modulo)
    left join public.rep_acceso a on a.id = p.id and a.modulo = k.modulo
  ) ra on true
  where app.tiene_rol(variadic array['admin']) and p.email not like 'zz.%'
  order by p.activo desc, p.nombre nulls last, p.email
$$;

-- ───────────────────────── Permisos de ejecución ─────────────────────────
revoke all on function public.rec_crear(uuid, text[], text, text, date, jsonb, jsonb) from public, anon;
revoke all on function public.rec_actualizar(uuid, text[], jsonb, timestamptz, jsonb) from public, anon;
revoke all on function public.rec_vendedores() from public, anon;
revoke all on function public.admin_set_telefono(uuid, text) from public, anon;
revoke all on function public.admin_usuarios() from public, anon;
grant execute on function public.rec_crear(uuid, text[], text, text, date, jsonb, jsonb) to authenticated;
grant execute on function public.rec_actualizar(uuid, text[], jsonb, timestamptz, jsonb) to authenticated;
grant execute on function public.rec_vendedores() to authenticated;
grant execute on function public.admin_set_telefono(uuid, text) to authenticated;
grant execute on function public.admin_usuarios() to authenticated, service_role;
