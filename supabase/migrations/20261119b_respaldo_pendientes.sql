-- Lote de la cola para la función respaldo-drive. Solo service_role.
-- procesar: pendientes listos + eliminados aún no informados; noche: errores con menos de 10 intentos.
create or replace function public.respaldo_pendientes(p_modo text, p_limite int default 10)
returns setof public.respaldo_cola language sql stable security definer set search_path = '' as $$
  select * from public.respaldo_cola c
  where c.intentos < 10 and (
    (p_modo = 'procesar' and c.listo_desde <= now() and (
       c.estado = 'pendiente'
       or (c.estado = 'eliminado' and (c.enviado_at is null or c.enviado_at < c.listo_desde))))
    or (p_modo = 'noche' and c.estado = 'error')
  )
  order by c.listo_desde
  limit greatest(1, least(p_limite, 50));
$$;
revoke all on function public.respaldo_pendientes(text, int) from public, anon, authenticated;
grant execute on function public.respaldo_pendientes(text, int) to service_role;
