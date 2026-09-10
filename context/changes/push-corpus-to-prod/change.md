---
change_id: push-corpus-to-prod
title: Push the local artwork corpus to the linked production project
status: implemented
created: 2026-09-10
updated: 2026-09-11
archived_at: null
---

## Notes

Seed data currently reaches only the local stack. `supabase/seed-assets/corpus.json` is the
durable artifact and `npm run db:seed:generate` writes it into `supabase/seed.sql`, which
`supabase db reset` applies locally. There is no path from that manifest to the linked project
(`qtohgsgfzuutcvpzpowt`), so production has no catalogue.

**Owner's decisions, 2026-09-10, taken before planning.**

- **Scope: all 1000 pieces.** Offered three scopes — the ~196 enriched, all 1000, or 946 (all but
  the untagged tail) — and all 1000 was chosen. Two consequences to carry into the plan rather
  than re-argue: 804 pieces currently have no style or mood tags (those come only from
  enrichment, which the owner is resuming manually), so the onboarding style picker will meet
  empty pools in prod for most terms until enrichment finishes — the same defect the data-driven
  picker change exists to fix. And the 50-piece untagged tail is a *local fixture*, built to make
  S-01's demotion sort observable; in prod it is 50 artworks with no tags and no description.
  Both are known and accepted.
- **Owner: a dedicated demo/collection account**, not the owner's own prod account, so seeded
  museum works stay separate from any real artist's portfolio. The account must carry
  `profiles.role = 'artist'` — `private.is_artist()` gates both the row insert and the storage
  upload.
- **Sequenced through the full workflow** rather than built ad hoc, because it is a production
  write path.

**Design constraints found while scoping — for the plan to confirm, not to inherit blindly.**

- **No service-role key.** `artworks` RLS permits an insert where `artist_id = auth.uid()` and
  `private.is_artist()`; the storage policy permits a write into `artworks/<uid>/`. Signing in as
  the demo artist over the publishable key crosses exactly the boundary a real artist crosses, so
  a successful push is also evidence the product's own upload path works. This matches the
  integration lane's existing rule (`test/integration/setup.ts`) that fixtures run under real RLS.
- **`image_path` must be rebuilt per target.** `imagePathOf` (`scripts/build-corpus.ts`) hardcodes
  the local `ARTIST_UUID`, and `image_path_pattern`
  (`20260910000100_constrain_artwork_image_path.sql`) requires
  `<artist-uuid>/<piece-uuid>.jpg`. The key cannot be copied from local — it has to be derived
  against the target artist's uid.
- **`piece_uuid` is pinned in the manifest**, so using it as the `artworks.id` makes the push
  idempotent and resumable by construction — the same property the enrich stage relies on.
- **The env footgun is real.** `.env.local` currently points at the *local* stack while
  `.env.local.remote.bak` holds the remote one, so the owner swaps them by hand. A push that
  silently reads `.env.local` would target whichever way it was last swapped. The target belongs
  in explicit, separately-named variables, with the host echoed and confirmed before any write.
- **Attribution already holds.** `descriptionFor` appends
  `"<artist> — Art Institute of Chicago, object <n>. Public domain (CC0)."` to every piece, and
  AIC's own CC-BY `description` field is never copied.
- **AGENTS.md says "Do not add a second seeding mechanism."** This is a second *sink* for the
  existing mechanism (manifest → target), not a second mechanism. The plan should say so
  explicitly, or argue the other way.
