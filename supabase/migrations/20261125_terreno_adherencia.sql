-- Terreno: ensayos de adherencia. registros_kind_check hoy solo admite charla, capacitacion y visita, así que guardar
-- un registro con kind = 'adherencia' falla hasta que se amplíe. Esta migración solo agrega ese valor; no toca datos,
-- políticas, triggers ni permisos. Hay que aplicarla antes de usar la pestaña Ensayos de adherencia: sin ella, guardar uno falla.
alter table public.registros drop constraint if exists registros_kind_check;
alter table public.registros add constraint registros_kind_check check (kind in ('charla', 'capacitacion', 'visita', 'adherencia'));
