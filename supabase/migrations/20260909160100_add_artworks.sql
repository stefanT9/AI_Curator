-- Artworks uploaded by artists. `image_path` is the storage object key inside
-- the `artworks` bucket, not a URL — URLs are derived at render time so the
-- project can move buckets or switch to signed URLs without a data migration.

create table public.artworks (
  id uuid primary key default gen_random_uuid(),
  artist_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text,
  tags text[] not null default '{}',
  image_path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint artworks_title_length check (char_length(title) between 1 and 120),
  constraint artworks_description_length check (description is null or char_length(description) <= 2000),
  constraint artworks_tags_length check (cardinality(tags) <= 10)
);

-- Foreign keys are not indexed automatically, and every studio page filters on
-- this column.
create index artworks_artist_id_idx on public.artworks (artist_id);

-- The deck orders by created_at desc.
create index artworks_created_at_idx on public.artworks (created_at desc);

-- GIN is the index type for array containment — this is what the later
-- filter-by-tag and recommendation queries will use.
create index artworks_tags_idx on public.artworks using gin (tags);

alter table public.artworks enable row level security;

-- The catalog is browsable by any signed-in user; that is the whole point of
-- the collector flow. `to authenticated` still keeps it away from anon.
create policy "Signed-in users can read all artworks"
  on public.artworks for select
  to authenticated
  using (true);

-- The role check belongs here and not only in the server action: a collector
-- with a valid session could otherwise POST straight to PostgREST.
create policy "Artists can insert their own artworks"
  on public.artworks for insert
  to authenticated
  with check (
    (select auth.uid()) = artist_id
    and (select private.is_artist())
  );

-- USING picks the rows they may touch, WITH CHECK stops them handing a row to
-- another artist.
create policy "Artists can update their own artworks"
  on public.artworks for update
  to authenticated
  using ((select auth.uid()) = artist_id)
  with check ((select auth.uid()) = artist_id);

create policy "Artists can delete their own artworks"
  on public.artworks for delete
  to authenticated
  using ((select auth.uid()) = artist_id);

-- Keep updated_at honest without trusting the client to send it.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger artworks_set_updated_at
  before update on public.artworks
  for each row execute function public.set_updated_at();
