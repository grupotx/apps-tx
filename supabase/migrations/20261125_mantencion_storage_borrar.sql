-- El bucket 'mantencion' solo tenia politicas de lectura (mtto_activo()) y subida; sin ninguna de
-- borrado, nadie con el rol correcto podia limpiar una foto huerfana desde el panel sin la clave de
-- servicio. Se agrega borrado con el mismo gate que ya usan las escrituras de la app (mtto_editor()):
-- editor o admin, igual que subir/corregir un documento.
create policy "mantencion borrar" on storage.objects for delete
using (bucket_id = 'mantencion' and app.mtto_editor());
