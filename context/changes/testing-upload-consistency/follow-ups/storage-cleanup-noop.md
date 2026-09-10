# Follow-up: storage `.remove()` is a silent no-op

**Found:** 2026-09-10, during `/10x-impl-review` of `testing-upload-consistency`
(finding F8), verified against the local Supabase stack by
`test/integration/storage-boundary.int.ts` →
"does NOT let an artist delete an object in their own folder (recorded)".

## What

`supabase.storage.from("artworks").remove([key])` returns no error but does not
delete the object — **even when the caller owns it**. `storage-api` lists the
objects matching the prefixes before deleting them, and that list is gated by a
`select` policy on `storage.objects`. `supabase/migrations/20260909160300_add_artworks_storage.sql`
defines only `insert` / `update` / `delete` policies, so the list comes back
empty and nothing is deleted.

## Impact

- The compensating `remove()` in `createArtwork` (`src/app/actions/artworks.ts`,
  `insertError` branch) does nothing.
- The `remove()` in `deleteArtwork` does nothing — **every deleted artwork
  leaves its image in the bucket permanently.**
- The client-side `removeArtworkImage` in `ArtworkForm.tsx` does nothing.
- Because no deleter can delete, the pre-Phase-4 "cleanup orphans a live row's
  image" path (Risk #1 / research P1) is **not currently reachable** through the
  Server Action. The Phase 4 guard added in this change is defense-in-depth
  until a `select` policy lands.

## Why it is not fixed here

Adding a `select` policy on `storage.objects` is a schema/security change that:

1. makes cleanup actually delete — which makes P1 reachable, so it must land
   *with* the Phase 4 guard already in place (it is);
2. is Risk #3 territory (read-path authorization for storage), which the test
   plan assigns to **rollout Phase 3**, not Phase 1;
3. auto-deploys to production on merge to `main` via `migrations.yml` and wants
   its own review of what a `select` policy exposes (the bucket is public, so
   listing is not a secrecy leak, but the policy shape still needs deciding —
   folder-scoped vs. bucket-wide).

## Suggested action

Open a change in rollout Phase 3 that adds a folder-scoped `select` policy on
`storage.objects` for the `artworks` bucket, re-points the
storage-boundary characterization test to the new expected behavior, and adds a
`deleteArtwork` integration test proving the object is actually removed.
