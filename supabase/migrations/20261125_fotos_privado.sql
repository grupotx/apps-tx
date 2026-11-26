-- El bucket 'fotos' (Silos) era publico: cualquiera con la URL (adivinada o filtrada) podia ver fotos de
-- silos/clientes sin iniciar sesion. Se pone privado y se agrega lectura para quien ya puede ver los
-- eventos/solicitudes de Silos (mismo gate que 'leer eventos'/'leer solicitudes': vendedor/tecnico/
-- supervisor/admin). El cliente ya sabe pedir una URL firmada antes de caer al respaldo de Drive
-- (foto-archivada.js), asi que no hace falta tocar la app para las fotos que siguen en Supabase.
update storage.buckets set public = false where id = 'fotos';

create policy "leer fotos" on storage.objects for select
using (bucket_id = 'fotos' and app.tiene_rol('vendedor','tecnico','supervisor','admin'));
