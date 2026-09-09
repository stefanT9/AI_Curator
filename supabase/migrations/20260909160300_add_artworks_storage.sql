-- The bucket is created here rather than in config.toml so it exists both
-- locally (`supabase db reset`) and on the linked project (`supabase db push`
-- from the migrations workflow). config.toml buckets are local-only.
--
-- Public bucket: objects are readable by URL, which is what lets next/image
-- serve a deck of cards without minting a signed URL per card. Keys are random
-- UUIDs under a per-artist folder, so they are unguessable but not secret —
-- the right trade for a catalog whose whole purpose is to be looked at.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artworks',
  'artworks',
  true,
  10485760, -- 10 MiB
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

-- Writes are scoped to a folder named after the uploader's uid, so one artist
-- can never overwrite another's file. `storage.foldername(name)` splits the
-- object key on '/', and [1] is the first segment.

create policy "Artists can upload into their own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select private.is_artist())
  );

create policy "Artists can update their own artwork files"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Artists can delete their own artwork files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
