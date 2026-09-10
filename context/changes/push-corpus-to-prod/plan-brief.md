# Push the Local Artwork Corpus to Production — Plan Brief

> Full plan: `context/changes/push-corpus-to-prod/plan.md`
> Change notes: `context/changes/push-corpus-to-prod/change.md`

## What & Why

Seed data currently reaches only the local stack: `supabase/seed-assets/corpus.json` is the
durable artifact, and `npm run db:seed:generate` writes it into `supabase/seed.sql`, which
only `supabase db reset` applies. There is no path from that manifest to the linked project,
so production has no catalogue at all. This builds that path — as a fifth stage of the
existing pipeline, writing under a dedicated demo artist's own session.

## Starting Point

The manifest holds 1000 pieces (197 enriched, 50 pinned as the untagged tail, 1 pinned
failure) with all 1000 JPEGs on disk (264 MB, gitignored). Every migration is already on
`main` and auto-deployed, so the linked project's schema is current — this is a data push,
not a schema change. Three things block a naive copy: `imagePathOf` hardcodes the local
artist UUID while `image_path_pattern` demands the key match the owner; there is no
service-role key to write with; and `.env.local` and `.env.local.remote.bak` share variable
names, so a push reading `NEXT_PUBLIC_*` targets whichever was last swapped into place.

## Desired End State

`npm run db:push` diffs the manifest against a target and writes nothing. `npm run db:push --
--apply` lands the corpus. The linked project holds 1000 artworks owned by a dedicated demo
account, images rendering from the `artworks` bucket, and a re-run of the dry-run reports
nothing to do. A collector signing into the deployed app sees a full deck — and once more
enrichment finishes locally, re-running `--apply` replaces the affected rows in place.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Scope | All 1000 pieces | Owner's call; empty style pools and a meaningless untagged tail in prod are known and accepted | Change notes |
| Owner account | A dedicated demo artist, created through the app's own signup + `becomeArtist` | Keeps museum works off any real artist's portfolio, and puts no SQL against production | Change notes |
| Auth | Sign in over the publishable key, no service-role | Crosses exactly the RLS a real artist crosses, so a green push is also evidence the product's upload path works on prod | Change notes / Plan |
| Targeting | A gitignored `.env.push.local` with distinct `PUSH_*` variables | Makes the `.env.local` swap hazard structurally impossible — no shared variable name to be redirected by | Plan |
| Images | Uploaded by the script on the artist's session, not `supabase storage cp --linked` | The CLI bypasses RLS as project owner and proves nothing about the artist path | Plan |
| Safety | Dry-run by default; `--apply` is the only thing that writes | The dangerous act needs a flag no one types by accident, and the plan output doubles as the pre-flight | Plan |
| Script home | A fifth stage of `scripts/build-corpus.ts` | Structurally proves it is a second *sink* on the manifest, not a second mechanism — it reuses `imagePathOf`, `descriptionFor`, `effectiveTags`, `verifyGeneratable` | Plan |
| Failures | Collect, continue, report, exit non-zero | One run surfaces every failure; the diff makes the retry touch only what did not land | Plan |
| Re-push semantics | Rows replaced wholesale, objects skipped when present | Makes re-running the push the enrichment top-up path, with no update-path change to plan later; images are fixed by uuid, so re-sending 264 MB would buy nothing | Plan |
| Verification | Re-run the dry-run | The check is the same code path as the plan, so there is nothing extra to keep correct — and because the plan is a diff, "nothing to do" is a true zero | Plan |

## Scope

**In scope:** the `push` stage (dry-run + apply), artist-uid parameterisation of
`imagePathOf` / `verifyGeneratable`, unit tests for the new pure helpers, `.env.example` /
README / AGENTS.md documentation, and the production run itself.

**Out of scope:** running enrichment (803 pieces go up unenriched — a later re-push replaces
those rows); the empty style-pool defect (`data-driven-picker`'s job); any migration or
`db:types` run; collectors, like history, or `auth.users` writes; a service-role key anywhere.

## Architecture / Approach

The manifest already has one renderer — `renderGeneratedRegion` → SQL text. This adds a
second — manifest → Supabase API calls — over the same pure helpers, which is what makes
"the prod corpus and the local corpus are the same corpus" a fact rather than a claim. Two
modes share one code path: the dry-run diffs the manifest against the target — rows to create,
rows present but stale, objects to upload — and stops; `--apply` runs the identical diff and
then writes. Per piece, the object goes up before the row, so a partial run leaves at worst an
orphan object rather than a row pointing at nothing.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Target resolution & dry-run | Unambiguous targeting, sign-in, artist assertion, a manifest-vs-target diff that writes nothing | Storage `list` pagination — the corpus is exactly 1000, at the API's page boundary |
| 2. The apply pass | Objects then rows, batched, failures collected, non-zero exit | Row drift from `artworkRow` (guarded by a parity test); session expiry across a multi-minute run |
| 3. Documentation | `.env.example`, README section, the AGENTS.md "sink not mechanism" argument, corrected script header | The header still reading LOCAL DEVELOPMENT ONLY while one stage writes to prod |
| 4. The production run | The demo artist, and the corpus live on the linked project | First real write; a wrong target or wrong account is the thing every rail above exists to prevent |

**Prerequisites:** local Supabase stack running for the Phase 1–2 rehearsal; the 1000 JPEGs
present (`npm run db:seed:fetch`); for Phase 4, access to the linked project's Data API keys
and a dedicated email address for the demo account.

**Estimated effort:** ~2–3 sessions. Phases 1–3 are one script section plus docs; Phase 4 is
an owner-driven run of a few minutes plus a manual pass through the deployed app.

## Open Risks & Assumptions

- **Most onboarding style terms will meet empty pools in prod** until enrichment finishes —
  accepted, and it is `data-driven-picker`'s defect to fix, not this plan's.
- **The untagged tail is a local fixture with no purpose in prod** — 50 artworks with no tags
  and no description. Accepted as part of pushing the pinned corpus whole.
- **The `artworks` bucket is public**, so a partial push is visible by URL before its rows
  exist. Harmless for public-domain images, but worth knowing.
- **A re-push replaces rows wholesale**, so any change made directly in the production
  database is silently reverted by the next `--apply`. The manifest is the source of truth by
  design; nothing should be edited on the target.
- **Rollback assumes the demo account owns everything pushed** — deleting its profile cascades
  the artworks; the storage folder is removed separately.

## Success Criteria (Summary)

- A collector signing into the deployed app sees a full deck of 1000 works with images
  rendering, attributed to the demo collection account.
- A dry-run after the push reports nothing to do — nothing missing and nothing stale.
- No account other than the demo artist owns any pushed artwork, and no SQL was run against
  production.
