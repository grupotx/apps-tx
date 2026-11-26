-- Fichas técnicas + bot de consulta (RAG). Modelo de embeddings: gemini-embedding-001, truncado a
-- 768 dimensiones con el parámetro output_dimensionality de la API (soportado oficialmente vía
-- Matryoshka Representation Learning: menos espacio/índice más rápido sin pérdida relevante de
-- calidad frente al valor por defecto de 3072). Quien llame a la API de embeddings DEBE pasar
-- output_dimensionality=768 explícitamente: el default del modelo es 3072, no 768.
create extension if not exists vector;

create table public.fichas_tecnicas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  categoria text,
  storage_path text not null,
  version int not null default 1,
  subido_por uuid references public.crm_profiles(id),
  creado_en timestamptz not null default now()
);

create table public.fichas_fragmentos (
  id uuid primary key default gen_random_uuid(),
  ficha_id uuid not null references public.fichas_tecnicas(id) on delete cascade,
  indice int not null,
  contenido text not null,
  embedding vector(768) not null
);

create index fichas_fragmentos_ficha_id_idx on public.fichas_fragmentos (ficha_id);
create index fichas_fragmentos_embedding_idx on public.fichas_fragmentos
  using hnsw (embedding vector_cosine_ops);

alter table public.fichas_tecnicas enable row level security;
alter table public.fichas_fragmentos enable row level security;

-- Solo lectura para el cliente: toda escritura pasa por la Edge Function fichas-ingesta con
-- service_role (que bypassa RLS), nunca directo desde el cliente.
create policy "fichas_tecnicas leer" on public.fichas_tecnicas for select
  using (public.crm_is_active());

create policy "fichas_fragmentos leer" on public.fichas_fragmentos for select
  using (public.crm_is_active());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fichas-tecnicas', 'fichas-tecnicas', false, 20971520, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "fichas-tecnicas leer" on storage.objects for select
  using (bucket_id = 'fichas-tecnicas' and public.crm_is_active());
