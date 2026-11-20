-- Entregas sin conexión: la jornada no queda con el reloj del teléfono.
-- inicio_at (al crear) y fin_at (al fijarse/cambiar) se acotan con app.ent_hora_valida
-- (fuera de [now()-72h, now()+10min] → now()); fecha se deriva de inicio_at en hora de Santiago.
create or replace function app.ent_jornadas_hora()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.inicio_at := app.ent_hora_valida(new.inicio_at);
    new.fecha := (new.inicio_at at time zone 'America/Santiago')::date;
  end if;
  -- solo cuando cambia: no re-acotar un fin_at viejo al editar otra columna
  if new.fin_at is not null and (tg_op = 'INSERT' or new.fin_at is distinct from old.fin_at) then
    new.fin_at := app.ent_hora_valida(new.fin_at);
  end if;
  return new;
end
$function$;
revoke all on function app.ent_jornadas_hora() from public, anon, authenticated;

drop trigger if exists ent_jornadas_hora on public.ent_jornadas;
create trigger ent_jornadas_hora
  before insert or update on public.ent_jornadas
  for each row execute function app.ent_jornadas_hora();
