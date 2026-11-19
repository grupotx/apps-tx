-- Programación del respaldo: cada 5 minutos procesa la cola; cada noche reintenta errores (y, en la tarea 6, copia completa).
-- La llamada usa app.respaldo_llamar(), que lee el token de Vault: no se guarda ninguna clave en este archivo.
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname in ('respaldo-procesar', 'respaldo-noche');
select cron.schedule('respaldo-procesar', '*/5 * * * *', $$select app.respaldo_llamar('procesar')$$);
select cron.schedule('respaldo-noche', '0 6 * * *', $$select app.respaldo_llamar('noche')$$); -- 06:00 UTC = 03:00 Chile (verano)
