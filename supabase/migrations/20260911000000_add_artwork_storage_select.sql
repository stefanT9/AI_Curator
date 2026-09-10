-- `storage.objects` had insert/update/delete policies scoped to the
-- uploader's own folder but no select policy, so `storage.from(...).list()`
-- always returns empty for an authenticated artist listing their own
-- folder — RLS hides the rows before the bucket's `public` flag (which only
-- governs unauthenticated object *download*) ever comes into play.
--
-- Discovered by `push-corpus-to-prod`: reconciling the manifest against a
-- target needs to list what an artist has already uploaded, and there was no
-- policy that let it see anything at all.

create policy "Artists can list their own artwork files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'artworks'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
