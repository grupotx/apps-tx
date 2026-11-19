-- Fotos nuevas de Mantención en un bucket privado (antes iban en base64 dentro de mtto_docs).
-- Leer: usuarios activos de Mantención. Subir: editores (los mismos que pueden escribir mtto_docs).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mantencion', 'mantencion', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "mantencion leer" on storage.objects;
create policy "mantencion leer" on storage.objects for select to authenticated
  using (bucket_id = 'mantencion' and (select app.mtto_activo()));

drop policy if exists "mantencion subir" on storage.objects;
create policy "mantencion subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'mantencion' and (select app.mtto_editor()));
