# Push the Local Artwork Corpus to Production — Implementation Plan

## Overview

`supabase/seed-assets/corpus.json` holds 1000 public-domain artworks with their images on
disk, but the only sink for that manifest is `supabase/seed.sql`, applied by
`supabase db reset` against the local stack. The linked project (`qtohgsgfzuutcvpzpowt`) has
no catalogue at all.

This adds `push` as a **fifth stage of `scripts/build-corpus.ts`** — a second *sink* on the
existing pipeline, not a second mechanism. It signs in as a dedicated demo artist over the
publishable key, crosses the same RLS the product's own upload path crosses, and writes the
1000 rows and 1000 objects into whatever target its explicitly-named env file points at.
Dry-run by default; `--apply` is the only thing that writes, and it replaces rows wholesale
so a re-push after more enrichment carries the new tags and descriptions with it.

## Current State Analysis

**What exists.** The manifest is complete and reviewed: 1000 pieces, 197 carrying
`tags_from_enrichment`, 1 pinned as an enrichment failure, 50 pinned `untagged`, all 1000
JPEGs present under `supabase/seed-assets/00000000-0000-4000-8000-000000000001/` (264 MB,
gitignored, largest file 2.4 MB). `like_history` names `figurative` with 8 likes.

**What the target already has.** Every migration in `supabase/migrations/` is on `main`, and
`.github/workflows/migrations.yml` auto-deploys on push, so the linked project's schema is
current. This change deploys **data only** — no migration, no schema step, no
`db:types` regeneration.

**Why no service-role key is needed.** `artworks` permits an insert where
`auth.uid() = artist_id and private.is_artist()`
(`supabase/migrations/20260909160100_add_artworks.sql`), and storage permits a write where
`(storage.foldername(name))[1] = auth.uid()` and the same role check
(`20260909160300_add_artworks_storage.sql`). Signing in as the demo artist crosses exactly
the boundary a real artist crosses on every upload.

**What blocks a naive copy.** `imagePathOf` (`scripts/build-corpus.ts:1869`) hardcodes the
local `ARTIST_UUID`, and `image_path_pattern` (`20260910000100_constrain_artwork_image_path.sql`)
requires `<artist-uuid>/<piece-uuid>.<ext>`. Keys must be re-derived against the target
artist's uid, never copied from local.

**The env hazard, confirmed and worse than described.** `.env.local` currently holds a full
`supabase status -o env` dump of the *local* stack — including `SERVICE_ROLE_KEY` — while
`.env.local.remote.bak` holds the remote pair. They share variable names, so a push reading
`NEXT_PUBLIC_SUPABASE_URL` targets whichever file was last swapped into place.

### Key Discoveries:

- `piece_uuid` is pinned in the manifest, so using it as `artworks.id` makes the push
  idempotent and resumable by construction. Rows are **upserted** — a re-push replaces them
  wholesale, which is what makes re-running after more enrichment the supported top-up path.
  Objects are content-addressed by the same uuid and never change, so `upsert: false` skips
  the ones already there rather than re-sending 264 MB.
- Upsert needs both the insert and the update policy, and the artist has both — "Artists can
  update their own artworks" is `using (auth.uid() = artist_id)` with the same `with check`,
  and the `artworks_set_updated_at` trigger keeps `updated_at` honest across a replace.
- **`created_at` is insertable.** Only `public.profiles` carries column-level
  `revoke`/`grant` statements; `public.artworks` has none, so the slot-staggered `created_at`
  (`CORPUS_EPOCH + slot hours`, `scripts/build-corpus.ts:2018`) can be preserved on the
  target. This matters: it is what keeps the newest-first deck deterministic and stops tag
  groups being contiguous by insertion order.
- The app has a first-class collector→artist opt-in — `becomeArtist`
  (`src/app/actions/profile.ts:38`) — so the demo account can be minted entirely through the
  product's own signup flow. No SQL against production, ever.
- `verifyGeneratable` (`scripts/build-corpus.ts:1959`) already checks the four constraints
  corpus data can violate, including `image_path_pattern` — it is reusable as the push's
  pre-flight once parameterised by artist uid.
- `inBatches` (`scripts/build-corpus.ts:987`) is the existing bounded-parallelism helper;
  `parseLimit` (`:1372`) is the existing argv convention. Both are reused rather than
  re-invented.
- The integration lane's rail (`test/integration/setup.ts`) is the *inverse* of what this
  needs — it refuses anything but loopback. The push refuses nothing by hostname; it refuses
  ambiguity, by reading only variables nothing else in the repo defines.

## Desired End State

`npm run db:push` diffs the manifest against a target and writes nothing. `npm run db:push --
--apply` lands the corpus. The linked project holds 1000 artworks owned by a dedicated demo artist,
their images served from the `artworks` bucket, and a re-run of the dry-run reports nothing to
do. Re-running `--apply` after more enrichment replaces the affected rows in place. Signing into the deployed app as a collector shows a full deck.

## What We're NOT Doing

- **No enrichment run.** The 803 unenriched pieces go up as they are. Enrichment continues
  locally against the manifest, and a later `--apply` replaces those rows with the enriched
  version — that is the top-up path, and it needs no further code.
- **No migration, no schema change, no `db:types` run.** Data only.
- **No fix for the empty style pools.** Most onboarding style terms will have no artworks
  behind them in prod until enrichment finishes. That is the `data-driven-picker` change's
  job, and it is accepted here as a known consequence of pushing all 1000.
- **No seeding of the untagged tail's meaning.** In prod it is simply 50 artworks with no
  tags and no description. It stays because it is part of the pinned corpus, not because it
  serves a purpose there.
- **No collectors, no like history, no `auth.users` writes.** `seed.sql`'s hand-authored
  identities section is local-only and stays that way. Production accounts are created
  through the app.
- **No service-role key, anywhere.** Not in the env file, not as a fallback.
- **No push of `interactions`.** The warm collector is a local fixture.

## Implementation Approach

The push is a stage on the existing pipeline because that is what it is: the manifest already
has one renderer (`renderGeneratedRegion` → SQL text), and this adds a second (manifest →
Supabase API calls) over the same pure helpers — `imagePathOf`, `descriptionFor`,
`effectiveTags`, `verifyGeneratable`. Sharing those is what makes "the prod corpus and the
local corpus are the same corpus" a structural fact rather than a claim.

Two modes over one code path. The dry-run resolves everything — target, session, artist uid,
derived keys, what is already present — and stops before the first write. `--apply` runs the
identical resolution and then writes. That makes the plan output a genuine pre-flight, and
makes re-running the dry-run after an apply a complete verification with no extra code.

## Critical Implementation Details

**Ordering within a piece: object first, then row.** The row's `image_path` is a promise that
an object exists at that key. Inserting first opens a window where the deck renders a broken
image; uploading first leaves at worst an orphan object, which costs storage and nothing else.
This is the same ordering `src/lib/artworks/upload.ts` and `createArtwork` already use in the
browser.

**The `artworks` bucket is public.** Objects are readable by URL once uploaded, so a partial
push is visible to anyone with a link before its rows exist. Harmless for public-domain
images; worth knowing before assuming a half-finished push is invisible.

**Session lifetime.** A 1000-object upload runs for many minutes. The supabase-js client
refreshes an access token automatically only when `autoRefreshToken` is on, which the plain
`createClient` from `@supabase/supabase-js` enables by default — do not disable it, and do not
reach for the `@supabase/ssr` browser factory here (it wants cookies and a document).

---

## Phase 1: Target resolution and the dry-run plan

### Overview

Everything up to but not including the first write: read an unambiguous target, sign in,
prove the account is an artist, derive the keys, reconcile the manifest against what is
already there, and print a plan. Rehearsed entirely against the local stack.

### Changes Required:

#### 1. Parameterise the artist uid

**File**: `scripts/build-corpus.ts`

**Intent**: `imagePathOf` and `verifyGeneratable` currently bake in the seeded local
`ARTIST_UUID`; the push needs both against the target artist's uid without forking them.

**Contract**: `imagePathOf(piece: CorpusPiece, artistUuid?: string): string` and
`verifyGeneratable(manifest: CorpusManifest, artistUuid?: string): void`, both defaulting to
`ARTIST_UUID` so `runGenerate`, `artworkRow` and the existing tests are untouched.

#### 2. Target resolution

**File**: `scripts/build-corpus.ts` (new "Stage: push" section)

**Intent**: Read the target from variables nothing else in this repo defines, so a
wrongly-swapped `.env.local` cannot redirect a push. Fail with the generation instructions
when any is missing, in the style `requireLocalStack` uses.

**Contract**: Four required variables — `PUSH_SUPABASE_URL`, `PUSH_SUPABASE_PUBLISHABLE_KEY`,
`PUSH_ARTIST_EMAIL`, `PUSH_ARTIST_PASSWORD` — loaded from `.env.push.local` via the npm
script's `--env-file-if-exists`. The script reads no `NEXT_PUBLIC_*` variable and no
`SERVICE_ROLE_KEY` / `SECRET_KEY` under any name; if one of those is set in the process
environment it is ignored, not consulted as a fallback.

#### 3. Sign-in and the artist assertion

**File**: `scripts/build-corpus.ts`

**Intent**: Establish the session the whole push runs under, and refuse early if the account
cannot actually write — a failed `private.is_artist()` otherwise surfaces 1000 times as an
opaque RLS rejection on the first insert.

**Contract**: `createClient` from `@supabase/supabase-js` (not the `@supabase/ssr` browser
factory), then `signInWithPassword`, then a `profiles` select asserting `role === 'artist'`.
Throws naming the email and the resolved host when the role is wrong. Returns the session's
`user.id` as the artist uid every derived key is built from.

#### 4. Reconciliation

**File**: `scripts/build-corpus.ts`

**Intent**: Diff the manifest against the target — what is absent, and what is present but
stale — without writing. A diff rather than a presence check is what makes a re-push after
enrichment legible in advance, and what lets the post-push dry-run report a true zero.

**Contract**: Rows — select `id, title, description, tags, image_path, created_at` from
`artworks` restricted to the manifest's `piece_uuid` list (chunked at 200; a 1000-element
`in` filter is a URL-length hazard), then compare each against the row the push would write.
Objects — `storage.from('artworks').list(artistUuid, …)` paginated by `offset`, since the API
caps a page and the corpus is exactly 1000. Produces a `PushPlan` naming the host, artist uid
and email, and three counts: rows to create, rows to replace (with the fields that differ),
and objects to upload.

#### 5. The `push` stage and its npm script

**File**: `scripts/build-corpus.ts`, `package.json`

**Intent**: Wire `push` into the existing dispatcher and expose it the way every other stage
is exposed. Dry-run is the bare invocation.

**Contract**: `STAGES.push = runPush`. `"db:push": "tsx --conditions=react-server
--env-file-if-exists=.env.push.local scripts/build-corpus.ts push"`. Bare run echoes host,
artist uid, email and the three plan counts, then exits 0 having written nothing, ending with
the line naming `--apply` as the way to write. When all three counts are zero it says so in
one line — that is the shape the post-push verification looks for. `--apply` is parsed here but does nothing until
Phase 2.

#### 6. Unit tests for the new pure helpers

**File**: `test/build-corpus.test.ts`

**Intent**: The reconciliation and key derivation are the parts that can be wrong silently;
both are pure and testable without a network.

**Contract**: Cover `imagePathOf` under a non-default artist uid (asserting the result still
satisfies `image_path_pattern`), and the plan-building helper across the four states — piece
fully present, row only, object only, neither.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npm run format:check`
- Linting passes: `npm run lint`
- Type checking passes: `npm run typecheck`
- Default suite passes, including the new cases: `npm run test`
- Build passes: `npm run build`
- `npm run db:seed:generate` still rewrites `supabase/seed.sql` byte-identically — the
  parameterisation changed no default (`git diff --exit-code supabase/seed.sql`)

#### Manual Verification:

- With `.env.push.local` pointed at the **local** stack and the seeded artist
  (`seed-artist@artswipe.local` / `seedpassword`), a dry-run over an already-seeded database
  reports nothing to do — 0 to create, 0 to replace, 0 objects
- After `npm run db:reset` is interrupted to leave a fresh, unseeded database, the same
  dry-run reports 1000 rows to create and 1000 objects to upload
- Deleting `PUSH_SUPABASE_URL` from the env file produces the setup instructions, not a stack
  trace; a `.env.local` swapped to the remote pair changes nothing about where the dry-run points
- Signing in with a collector account (`seed-collector-cold@artswipe.local`) is refused by the
  artist assertion before any reconciliation runs

**Implementation Note**: After completing this phase and all automated verification passes,
pause for manual confirmation before proceeding.

---

## Phase 2: The apply pass

### Overview

Make `--apply` write. Objects then rows, batched, failures collected rather than fatal, exit
non-zero if anything failed.

### Changes Required:

#### 1. Pre-flight validation

**File**: `scripts/build-corpus.ts`

**Intent**: Run the same constraint checks `generate` runs, against the *target's* uid,
before the first write — a title over 120 chars or a malformed key should cost nothing, not a
partial push.

**Contract**: `verifyGeneratable(manifest, artistUuid)` called at the top of the apply path.
Throws before any network write.

#### 2. Object upload

**File**: `scripts/build-corpus.ts`

**Intent**: Put each missing JPEG at `<artistUuid>/<piece_uuid>.jpg` through the artist's
session, the same call the browser makes.

**Contract**: `storage.from('artworks').upload(key, bytes, { contentType: 'image/jpeg',
upsert: false })`, reading from `ASSET_DIR`. A missing local file is a collected failure
naming `npm run db:seed:fetch`, not a crash. Bounded by `inBatches` at a small constant
(start at 4) with periodic progress, following the `ENRICH_CONCURRENCY` precedent.

#### 3. Row insert

**File**: `scripts/build-corpus.ts`

**Intent**: Write the artwork rows for pieces whose object is now present, preserving the
manifest's identity and ordering — replacing any row already there rather than leaving a
stale one standing.

**Contract**: `insert` into `artworks` with `id: piece_uuid`, `artist_id: artistUuid`,
`title`, `description: descriptionFor(piece)`, `tags: effectiveTags(piece)`,
`image_path: imagePathOf(piece, artistUuid)`, and `created_at` as the ISO instant
`CORPUS_EPOCH + (slot + 1) hours` — matching `artworkRow` exactly. Chunked (200 rows) so one
rejected row does not fail a thousand. **Upsert on `id`, replacing every column** — the
manifest is the source of truth, so a row that has drifted from it is wrong, and a re-push
after more enrichment is how corrected tags and descriptions reach production. `updated_at`
is left to the `artworks_set_updated_at` trigger.

Only the pieces the plan named are written — created *or* replaced — so a re-push over an
unchanged corpus sends no row requests at all.

**A piece whose object upload failed does not get a row.** Object-then-row holds per piece,
so a partial run never leaves a row pointing at nothing.

#### 4. Failure accumulation and exit code

**File**: `scripts/build-corpus.ts`

**Intent**: One run surfaces every failure, and the process still reports failure.

**Contract**: A `{ aic_id, piece_uuid, stage: 'object' | 'row', reason }` list, printed as a
summary; `process.exitCode = 1` when non-empty. The final line states that a re-run retries
only the failures, because everything that landed is skipped by reconciliation.

#### 5. Tests for the row mapping

**File**: `test/build-corpus.test.ts`

**Intent**: The row the push sends and the row `generate` writes must not drift.

**Contract**: A test asserting the push's row object and `artworkRow`'s SQL agree on id,
title, description, tags, image_path and `created_at` for the same piece under the same
artist uid — including an untagged-tail piece, which must carry `[]` tags and a null
description in both. Plus the diff helper: a target row identical to the manifest's is clean,
one whose tags or description differ is stale, and tag comparison is a plain ordered array
comparison because `combineTags` is deterministic.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npm run format:check`
- Linting passes: `npm run lint`
- Type checking passes: `npm run typecheck`
- Default suite passes, including the row-parity test: `npm run test`
- Build passes: `npm run build`

#### Manual Verification:

- Against a freshly reset local stack with an empty bucket, `--apply` lands all 1000 rows and
  1000 objects, and the subsequent dry-run reports nothing to do
- A second `--apply` immediately after sends no row and no object requests — the plan is
  already all-zero — and `select count(*) from artworks` stays 1000
- Hand-editing one piece's description in the manifest makes the dry-run report exactly one
  row to replace; `--apply` updates that row and leaves the other 999 rows and every object alone
- Killing a run part-way and re-running lands the remainder, after which the dry-run reports
  nothing to do
- With one JPEG deleted from `ASSET_DIR`, the run completes, reports exactly one collected
  failure naming that piece, exits non-zero, and leaves no row for it
- The local app renders the deck from the pushed data with images intact

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Documentation and env scaffolding

### Overview

Make the new sink discoverable and settle the "second seeding mechanism" question in writing.

### Changes Required:

#### 1. Env example

**File**: `.env.example`

**Intent**: Document the four `PUSH_*` variables and where they come from, alongside the
existing block.

**Contract**: A commented section naming `.env.push.local` as their home, stating that they
are deliberately distinct from `NEXT_PUBLIC_*` so a swapped `.env.local` cannot redirect a
push, and that no service-role key belongs there. `.env*` already covers the new file in
`.gitignore` — verify, do not add a rule.

#### 2. Corpus README

**File**: `supabase/seed-assets/README.md`

**Intent**: The workflow doc currently says "local development only" without qualification;
one stage is now the exception.

**Contract**: A new "Pushing the corpus to a hosted project" section covering the
`.env.push.local` shape, the demo-artist prerequisite (created through the app, promoted via
the account page), dry-run-then-apply, resumability, and the re-run-the-dry-run verification.
Adds the `push` row to the stages table. The "Local development only" section keeps its
warning about `seed.sql` — which remains local-only and is *not* what the push uses.

#### 3. Project conventions

**File**: `AGENTS.md`

**Intent**: Answer the "Do not add a second seeding mechanism" rule head-on so a future
reader does not have to re-litigate it.

**Contract**: In the Database changes section, a sentence establishing that `push` is a second
*sink* on the manifest — same source of truth, same pure helpers as `generate` — and that the
prohibition still stands against any *new* corpus source. Names `.env.push.local` as the only
place the push reads its target from.

#### 4. Script header

**File**: `scripts/build-corpus.ts`

**Intent**: The module header ends "LOCAL DEVELOPMENT ONLY", which is now false of one stage
and dangerously reassuring.

**Contract**: Update the stage list to five entries and replace the closing line with one
distinguishing the four local-only stages from `push`, which writes to whatever
`.env.push.local` names and is dry-run by default.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npm run format:check`
- Linting passes: `npm run lint`
- Full gate stays green: `npm run typecheck` · `npm run test` · `npm run build`
- `git status --porcelain` shows no `.env.push.local` — the gitignore rule covers it

#### Manual Verification:

- A reader following only `supabase/seed-assets/README.md` can construct `.env.push.local`
  and run a dry-run without reading the script
- The AGENTS.md sentence is defensible against the existing rule rather than an exception
  carved out of it

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: The production run

### Overview

Create the demo artist on the linked project through the product's own flow, then push.
This phase writes to production and is driven by the owner.

### Changes Required:

#### 1. The demo artist account

**Target**: the deployed app, not the codebase

**Intent**: A dedicated demo/collection account so seeded museum works never mix with a real
artist's portfolio, created entirely through the product so no SQL touches production.

**Contract**: Sign up in the deployed app with a dedicated address, complete onboarding, then
use the account page's become-an-artist form (`becomeArtist`,
`src/app/actions/profile.ts:38`) with a display name identifying it as the collection
account. The resulting `profiles.role` must read `artist`; the account's uid becomes the
folder every pushed key sits under.

#### 2. `.env.push.local` against the linked project

**Intent**: Point the push at production, explicitly.

**Contract**: `PUSH_SUPABASE_URL` and `PUSH_SUPABASE_PUBLISHABLE_KEY` from the linked
project's Data API settings (the same pair `.env.local.remote.bak` holds), plus the demo
artist's credentials. Not committed.

#### 3. The run

**Intent**: Land the corpus.

**Contract**: Dry-run first — confirm the echoed host is the linked project, the artist uid
matches the account just created, and the plan reads 1000 rows to create and 1000 objects to
upload. Then
`--apply`. Re-run the dry-run.

### Success Criteria:

#### Automated Verification:

- The pre-push dry-run reports the linked project's host, the demo artist's uid, 1000 rows to
  create and 1000 objects to upload
- `--apply` exits 0 with no collected failures (a non-zero exit is a re-run, not a conclusion)
- The post-push dry-run reports nothing to do

#### Manual Verification:

- Signing into the deployed app as a fresh collector shows a full deck with images rendering
- The demo artist's studio page lists the corpus, and the pieces are attributed to the demo
  account rather than any real artist profile
- An untagged-tail piece renders without tags or description rather than erroring
- Onboarding's style picker behaves as expected for the terms enrichment has covered, and its
  empty-pool behaviour for the rest is the known `data-driven-picker` defect, not a new one
- No account other than the demo artist owns any pushed artwork

---

## Testing Strategy

### Unit Tests (`npm run test`):

- `imagePathOf` under a non-default artist uid still satisfies `image_path_pattern`
- Plan building across all four presence states (both / row only / object only / neither)
- Row parity between the push's insert object and `artworkRow`'s SQL, including an
  untagged-tail piece
- `renderGeneratedRegion` unchanged — the parameterisation must not move the default

### Integration Tests:

None added. The integration lane refuses non-loopback hosts by design, and the behaviour
worth proving here — that an artist session can insert a row and upload an object under real
RLS — is already covered by `test/integration/create-artwork.int.ts`,
`upload.int.ts` and `storage-boundary.int.ts`. The push crosses the same policies.

### Manual Testing Steps:

1. Point `.env.push.local` at the local stack and the seeded artist; dry-run over the seeded
   database — expect nothing to do.
2. Reset to an empty database and bucket; dry-run — expect 1000 to create, 1000 objects.
3. `--apply`; then dry-run — expect nothing to do. Re-apply — expect no requests sent.
4. Edit one description in the manifest; dry-run — expect exactly one row to replace, and
   `--apply` to touch only it.
5. Delete one local JPEG; `--apply` — expect one collected failure, non-zero exit, no row for
   that piece.
6. Only then repeat 2–3 against the linked project (Phase 4).

## Performance Considerations

264 MB across 1000 objects is the whole cost. `inBatches` at 4 keeps it to a few minutes
without hammering the project's storage endpoint; raise it only if the run is comfortably
error-free. Row inserts are 5 chunked requests and are not the bottleneck. Reconciliation is
~5 select requests (fetching the comparable columns — a few hundred KB in total) and a handful
of paginated `list` calls, so the dry-run is cheap enough to run freely — which is what makes
it usable both as the verification step and as the answer to "what would a re-push change?".

## Migration Notes

**Re-pushing after enrichment.** The owner is resuming enrichment manually. Once more pieces
carry `tags_from_enrichment`, their manifest entries change while their `piece_uuid` does not
— so the diff reports exactly those rows as stale and `--apply` replaces them. **Re-running
the push is the top-up path**, and it needs no additional code or planning. Objects are
untouched by such a re-push: a piece's image is fixed by its uuid, so nothing re-uploads and
the run costs seconds rather than minutes. If an image itself ever has to change, delete the
object first — `upsert: false` will not overwrite it.

**Rollback.** Everything the push creates is owned by one account. Deleting the demo artist's
profile cascades its artworks (`artworks.artist_id … on delete cascade`); its storage folder
is removed separately. No other data is touched, so a bad push is fully reversible without a
migration.

## References

- Change notes and owner decisions: `context/changes/push-corpus-to-prod/change.md`
- Corpus pipeline: `scripts/build-corpus.ts` — `imagePathOf:1869`, `descriptionFor:1887`,
  `verifyGeneratable:1959`, `artworkRow:2010`, `inBatches:987`
- The path this push imitates: `src/lib/artworks/upload.ts`, `src/app/actions/artworks.ts`
- RLS being crossed: `supabase/migrations/20260909160100_add_artworks.sql`,
  `20260909160300_add_artworks_storage.sql`
- Env-targeting precedent (inverted): `test/integration/setup.ts`
- Related change: `context/changes/data-driven-picker/change.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Target resolution and the dry-run plan

#### Automated

- [x] 1.1 Formatting passes: `npm run format:check`
- [x] 1.2 Linting passes: `npm run lint`
- [x] 1.3 Type checking passes: `npm run typecheck`
- [x] 1.4 Default suite passes, including the new cases: `npm run test`
- [x] 1.5 Build passes: `npm run build`
- [x] 1.6 `npm run db:seed:generate` still rewrites `supabase/seed.sql` byte-identically

#### Manual

- [x] 1.7 Dry-run against the seeded local stack reports nothing to do
- [x] 1.8 Dry-run against a fresh, unseeded local database reports 1000 rows to create and 1000 objects to upload
- [x] 1.9 A missing `PUSH_*` variable produces setup instructions; a swapped `.env.local` changes nothing
- [x] 1.10 A collector account is refused by the artist assertion before reconciliation runs

### Phase 2: The apply pass

#### Automated

- [ ] 2.1 Formatting passes: `npm run format:check`
- [ ] 2.2 Linting passes: `npm run lint`
- [ ] 2.3 Type checking passes: `npm run typecheck`
- [ ] 2.4 Default suite passes, including the row-parity test: `npm run test`
- [ ] 2.5 Build passes: `npm run build`

#### Manual

- [ ] 2.6 `--apply` against a fresh local stack lands 1000 rows and 1000 objects; dry-run then reports nothing to do
- [ ] 2.7 A second `--apply` sends no row or object requests; count stays 1000
- [ ] 2.8 A hand-edited description yields exactly one row to replace, applied in place
- [ ] 2.9 An interrupted run resumes and reaches nothing-to-do
- [ ] 2.10 A deleted local JPEG yields exactly one collected failure, a non-zero exit, and no row for that piece
- [ ] 2.11 The local app renders the deck from pushed data with images intact

### Phase 3: Documentation and env scaffolding

#### Automated

- [ ] 3.1 Formatting passes: `npm run format:check`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Full gate stays green: `npm run typecheck` · `npm run test` · `npm run build`
- [ ] 3.4 `git status --porcelain` shows no `.env.push.local`

#### Manual

- [ ] 3.5 A reader can construct `.env.push.local` and dry-run from the README alone
- [ ] 3.6 The AGENTS.md sentence is defensible against the existing "no second mechanism" rule

### Phase 4: The production run

#### Automated

- [ ] 4.1 Pre-push dry-run reports the linked project's host, the demo artist's uid, 1000 rows to create and 1000 objects to upload
- [ ] 4.2 `--apply` exits 0 with no collected failures
- [ ] 4.3 Post-push dry-run reports nothing to do

#### Manual

- [ ] 4.4 A fresh collector sees a full deck with images rendering in the deployed app
- [ ] 4.5 The demo artist's studio lists the corpus, attributed to the demo account
- [ ] 4.6 An untagged-tail piece renders without tags or description rather than erroring
- [ ] 4.7 No account other than the demo artist owns any pushed artwork
