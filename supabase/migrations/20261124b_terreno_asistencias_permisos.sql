-- Terreno: los participantes (y sus firmas, que son la evidencia de la asistencia) solo los corrige
-- el autor del registro o un admin. El select no cambia: cualquier PM activo ve todos los registros.
drop policy if exists "rt asist editar" on public.rt_asistencias;
create policy "rt asist editar" on public.rt_asistencias for update to authenticated
  using (app.rt_activo() and exists (
    select 1 from public.registros r where r.id = registro_id and (r.autor = auth.uid() or app.tiene_rol('admin'))))
  with check (app.rt_activo() and exists (
    select 1 from public.registros r where r.id = registro_id and (r.autor = auth.uid() or app.tiene_rol('admin'))));

drop policy if exists "rt asist borrar" on public.rt_asistencias;
create policy "rt asist borrar" on public.rt_asistencias for delete to authenticated
  using (app.rt_activo() and exists (
    select 1 from public.registros r where r.id = registro_id and (r.autor = auth.uid() or app.tiene_rol('admin'))));
