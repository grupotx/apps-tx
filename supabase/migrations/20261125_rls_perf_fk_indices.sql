-- Rendimiento: 25 politicas RLS reevaluaban auth.uid() por cada fila (el optimizador no puede
-- cachear una llamada a funcion que aparece "suelta" en la condicion); se envuelve en (select ...)
-- para que Postgres la resuelva una sola vez por consulta. Sin cambio de comportamiento, ya que
-- auth.uid() es estable dentro de una misma consulta. Ademas, 22 foreign keys sin indice: cada
-- borrado/actualizacion del lado "padre" (o un join por esa FK) escaneaba la tabla completa.

-- === RLS: auth.uid() -> (select auth.uid()) ===

alter policy "cp_usuarios propio o admin" on cp_usuarios
  using ((id = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text]));

alter policy "crm_a_ins" on crm_audit
  with check (crm_is_active() and (user_id = (select auth.uid())));

alter policy "crm_c_ins" on crm_clients
  with check (crm_has_perm('crear_cliente') or (crm_has_perm('registrar_visita') and (origen = 'prospecto') and ((select auth.uid()) = any (sellers))));

alter policy "crm_c_sel" on crm_clients
  using (crm_has_perm('ver_todo') or (crm_is_active() and ((select auth.uid()) = any (sellers))));

alter policy "crm_c_upd" on crm_clients
  using (crm_has_perm('crear_cliente') and (crm_has_perm('ver_todo') or ((select auth.uid()) = any (sellers))));

alter policy "crm_o_ins" on crm_opps
  with check (crm_is_active() and (crm_has_perm('ver_todo') or (user_id = (select auth.uid())) or crm_can_see_client(client_id)));

alter policy "crm_o_sel" on crm_opps
  using (crm_has_perm('ver_todo') or (user_id = (select auth.uid())) or crm_can_see_client(client_id));

alter policy "crm_o_upd" on crm_opps
  using (crm_is_active() and (crm_has_perm('ver_todo') or (user_id = (select auth.uid())) or crm_can_see_client(client_id)));

alter policy "crm_p_sel" on crm_profiles
  using ((id = (select auth.uid())) or crm_is_active());

alter policy "crm_q_sel" on crm_quotes
  using (crm_has_perm('ver_todo') or (crm_is_active() and (user_id = (select auth.uid()))) or crm_can_see_client(client_id));

alter policy "crm_q_upd" on crm_quotes
  using (crm_has_perm('aprobar_desc') or (crm_has_perm('cotizar') and ((user_id = (select auth.uid())) or crm_has_perm('ver_todo'))));

alter policy "crm_smp_sel" on crm_samples
  using (crm_has_perm('ver_todo') or (crm_is_active() and (user_id = (select auth.uid()))) or crm_can_see_client(client_id));

alter policy "crm_smp_upd" on crm_samples
  using (crm_has_perm('muestras') and ((user_id = (select auth.uid())) or crm_has_perm('ver_todo')));

alter policy "crm_t_sel" on crm_tasks
  using (crm_has_perm('ver_todo') or (crm_is_active() and (user_id = (select auth.uid()))));

alter policy "crm_t_upd" on crm_tasks
  using (crm_has_perm('ver_todo') or (crm_is_active() and (user_id = (select auth.uid()))));

alter policy "crm_v_ins" on crm_visits
  with check (crm_has_perm('registrar_visita') and
    case
      when client_id is null then ((lugar is not null) and ((user_id = (select auth.uid())) or crm_has_perm('ver_todo')))
      else crm_can_see_client(client_id)
    end);

alter policy "crm_v_sel" on crm_visits
  using (
    case
      when client_id is null then (crm_has_perm('ver_todo') or (crm_is_active() and (user_id = (select auth.uid()))))
      else crm_can_see_client(client_id)
    end);

alter policy "mtto_usuarios propio o admin" on mtto_usuarios
  using ((id = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text]));

alter policy "rt borrar" on registros
  using ((autor = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text]));

alter policy "rt crear" on registros
  with check (app.rt_activo() and (autor = (select auth.uid())));

alter policy "rt asist borrar" on rt_asistencias
  using (app.rt_activo() and (exists (select 1 from registros r
    where (r.id = rt_asistencias.registro_id) and ((r.autor = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text])))));

alter policy "rt asist crear" on rt_asistencias
  with check (app.rt_activo() and (exists (select 1 from registros r
    where (r.id = rt_asistencias.registro_id) and ((r.autor = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text])))));

alter policy "rt asist editar" on rt_asistencias
  using (app.rt_activo() and (exists (select 1 from registros r
    where (r.id = rt_asistencias.registro_id) and ((r.autor = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text])))))
  with check (app.rt_activo() and (exists (select 1 from registros r
    where (r.id = rt_asistencias.registro_id) and ((r.autor = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text])))));

alter policy "rt_usuarios propio o admin" on rt_usuarios
  using ((id = (select auth.uid())) or app.tiene_rol(variadic array['admin'::text]));

alter policy "tur_usuarios_self" on tur_usuarios
  using ((id = (select auth.uid())) or app.tur_admin());

-- === Indices para foreign keys sin cubrir ===

create index if not exists cp_capturas_autor_idx on cp_capturas (autor);
create index if not exists cp_capturas_canal_idx on cp_capturas (canal);
create index if not exists cp_capturas_producto_id_idx on cp_capturas (producto_id);
create index if not exists cp_capturas_updated_by_idx on cp_capturas (updated_by);
create index if not exists crm_audit_user_id_idx on crm_audit (user_id);
create index if not exists crm_clients_created_by_idx on crm_clients (created_by);
create index if not exists crm_comms_client_id_idx on crm_comms (client_id);
create index if not exists crm_comms_user_id_idx on crm_comms (user_id);
create index if not exists crm_opps_client_id_idx on crm_opps (client_id);
create index if not exists crm_opps_user_id_idx on crm_opps (user_id);
create index if not exists crm_price_list_items_code_idx on crm_price_list_items (code);
create index if not exists crm_price_lists_updated_by_idx on crm_price_lists (updated_by);
create index if not exists crm_products_created_by_idx on crm_products (created_by);
create index if not exists crm_products_updated_by_idx on crm_products (updated_by);
create index if not exists crm_quotes_opp_id_idx on crm_quotes (opp_id);
create index if not exists crm_quotes_user_id_idx on crm_quotes (user_id);
create index if not exists crm_samples_outcome_quote_id_idx on crm_samples (outcome_quote_id);
create index if not exists crm_samples_user_id_idx on crm_samples (user_id);
create index if not exists crm_tasks_client_id_idx on crm_tasks (client_id);
create index if not exists crm_tasks_user_id_idx on crm_tasks (user_id);
create index if not exists crm_visits_user_id_idx on crm_visits (user_id);
create index if not exists registros_autor_idx on registros (autor);
