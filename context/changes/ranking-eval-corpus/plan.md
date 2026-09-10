# Ranking Evaluation Corpus Implementation Plan

## Overview

Seed the local Supabase instance with three fixed identities, 54 artworks organised into
deliberate tag clusters, and a like history — so that the tag-match ordering built in S-01 can be
judged by swiping through `/discover` rather than guessed at. Delivered entirely through the
already-configured-but-unused `supabase/seed.sql` hook plus a set of committed placeholder
images. No schema change, no migration, no application code change.

## Current State Analysis

**The seed hook is already wired and empty.** `supabase/config.toml:85-89` carries the stock
`[db.seed]` block with `enabled = true` and `sql_paths = ["./seed.sql"]`, but no
`supabase/seed.sql` exists. Anything placed at that path is applied automatically at the end of
`supabase db reset`, after all migrations. This is the whole mechanism — nothing new needs
building.

**Profiles cannot be inserted directly.** `profiles` has no insert policy
(`supabase/migrations/20260909144939_add_user.sql:27`); rows arrive only via the
`on_auth_user_created` trigger calling `public.handle_new_user()` (`:32-49`), a security-definer
function that copies `(id, email)` off `auth.users`. Seeding an identity therefore means writing
an `auth.users` row and letting the trigger produce the profile, then updating `role` afterwards.

**A collector never sees their own work.** `swipe_deck` filters
`a.artist_id <> (select auth.uid())` (`supabase/migrations/20260909160200_add_interactions.sql:59`),
so the artist who owns the corpus cannot also be the collector doing the judging. At least two
identities are structural, not a nicety.

**Storage is separate from the database.** `artworks.image_path` is `NOT NULL`
(`20260909160100_add_artworks.sql:11`) and holds a storage key, not a URL; `publicImageUrl`
(`src/lib/artworks/images.ts:13-14`) derives the URL at render time. `seed.sql` is pure SQL and
cannot create Storage objects, so the placeholder images need a separate upload step.

**No service-role key exists in the repo**, and `.env.example:2-3` explicitly warns against
introducing one. `seed.sql` runs as superuser and bypasses RLS entirely, which removes any need
for elevated credentials in application config.

**Verification is constrained by test conventions.** Per `AGENTS.md`, vitest is Node-only with
Supabase mocked and no integration layer. This change adds no importable module, so it adds no
unit tests; its verification is the repo's existing verify gate plus human judgment.

## Desired End State

After `supabase db reset` and one image-upload command, a developer can log in as
`seed-collector-warm@artswipe.local` and swipe `/discover`, seeing a deck drawn from a
54-artwork catalogue whose tags fall into four recognisable clusters, with that collector already
carrying eight likes concentrated in a single cluster. Logging in as
`seed-collector-cold@artswipe.local` shows the same catalogue with no likes at all. Both states
survive a reset and reproduce identically, because every identifier is a fixed UUID.

Verified by: running the reset + upload commands, logging in as each collector, and confirming
the deck renders 20 cards with visible cluster imagery and tag lists, the liked view shows eight
pieces for the warm collector and none for the cold one.

### Key Discoveries:

- `[db.seed]` already enabled with `sql_paths = ["./seed.sql"]` — `supabase/config.toml:85-89`
- Profiles are trigger-created from `auth.users` — `20260909144939_add_user.sql:32-49`
- `enable_confirmations = false` — `supabase/config.toml:225`, so seeded users need no email confirmation flow
- Artist role gate on artwork insert is irrelevant to seeding (superuser bypasses RLS) but the role still matters for the app's own artist checks — `20260909160000_add_profile_role.sql:31-44`
- `swipe_deck` excludes own artworks and any prior interaction — `20260909160200_add_interactions.sql:50-71`
- `cardinality(tags) <= 20` — `20260909214144_raise_artwork_tag_limit.sql:16`
- `title` length must be 1–120, `description` ≤ 2000 — `20260909160100_add_artworks.sql:15-16`
- The Supabase CLI is a devDependency at `node_modules/.bin/supabase` (v2.117.0) and supports `storage cp --local` with the `ss:///bucket/path` scheme — no global install needed
- Prior-art conventions from `context/changes/ai-artwork-enrichment/`: propose local Supabase commands rather than running them; never run `npm run db:types:local`

## What We're NOT Doing

- **No schema change and no migration.** This change adds one SQL file that is not a migration and one directory of images. `supabase/migrations/` is untouched.
- **No type regeneration.** Nothing about the schema changes, and `npm run db:types:local` is banned in this repo per `ai-artwork-enrichment/change.md`.
- **No automated ordering assertion.** No `.live.ts` smoke test, no fixtures framework. S-01 may add one later against its own contract.
- **No production or linked-project seeding.** Local development environment only. The seed file must never be run against a linked project.
- **No ranking logic.** This change produces data to judge ranking with; the ranking itself is S-01.
- **No changes to the upload flow, the deck query, or any application code.**
- **No generated SQL.** The corpus is authored as literal, reviewable rows.

## Implementation Approach

Everything lands in one new SQL file plus one new asset directory. The file is written in four
passes matching the phases below, so that a wrong `auth.users` shape is caught by logging in
before fifty-four corpus rows are authored against it.

Determinism is the design constraint throughout: every id is a hardcoded UUID and every insert is
guarded with `on conflict do nothing`, so the file is safe to run under `supabase db reset` and
safe to re-run by hand against an already-seeded database.

The corpus is designed rather than generated. Four clusters of twelve give a ranking something
unmistakable to promote, and one tag (`oil`) is deliberately shared between two clusters so the
ordering has at least one discrimination case to get right rather than only clean separation.

## Critical Implementation Details

**Password login needs an `auth.identities` row, not just `auth.users`.** GoTrue resolves a
password login through `auth.identities` matched on `provider = 'email'` and `provider_id` equal
to the email address; a user row alone produces a user who exists but cannot sign in. Each seeded
identity therefore needs both rows, with `identity_data` carrying at least `sub` (the user id, as
text) and `email`.

**`supabase db reset` clears Storage objects along with the database**, so the image-upload
command is part of the reset workflow, not a one-time setup step. Phase 4's documentation must
present reset and upload as a pair, or the corpus renders as broken images after every reset.

**The trigger fires inside the same statement**, so `profiles` rows exist immediately after the
`auth.users` insert — but with the default `role = 'collector'`. The artist's role update must
therefore come after the insert, not be attempted as part of it.

## Phase 1: Seeded Identities

### Overview

Create the three fixed identities the corpus hangs off, and prove they can log in before any
corpus data is written against their ids.

### Changes Required:

#### 1. Seed file, identities section

**File**: `supabase/seed.sql` (new)

**Intent**: Create one artist and two collectors as `auth.users` + `auth.identities` pairs with
hardcoded UUIDs, let the existing trigger produce their `profiles` rows, then promote the artist's
role. Fixed ids are what make every later section — image paths, artwork ownership, likes —
writable as literal SQL.

**Contract**: Three identities, each with a fixed UUID, an `@artswipe.local` email, and a shared
password of `seedpassword`:

| Role           | UUID                                   | Email                                |
| -------------- | -------------------------------------- | ------------------------------------ |
| Artist         | `00000000-0000-4000-8000-000000000001` | `seed-artist@artswipe.local`         |
| Warm collector | `00000000-0000-4000-8000-000000000002` | `seed-collector-warm@artswipe.local` |
| Cold collector | `00000000-0000-4000-8000-000000000003` | `seed-collector-cold@artswipe.local` |

Each `auth.users` row needs `instance_id` (all-zero UUID), `aud` and `role` both `'authenticated'`,
`encrypted_password` via `crypt('seedpassword', gen_salt('bf'))`, a non-null `email_confirmed_at`,
and `raw_app_meta_data` / `raw_user_meta_data` as valid JSON objects. Each `auth.identities` row
needs `provider = 'email'`, `provider_id` = the email, `user_id` = the fixed UUID, and
`identity_data` containing `sub` and `email`.

After the inserts, set `display_name` on all three profiles and
`update public.profiles set role = 'artist'` for the artist id only. Every insert carries
`on conflict do nothing` so the file is re-runnable.

A file-top comment must state that this file targets the local development database only and
must never be run against a linked project.

### Success Criteria:

#### Automated Verification:

- Formatting check passes: `npm run format:check`
- Linting passes: `npm run lint`
- Type checking passes: `npm run typecheck`
- Unit tests pass: `npm run test`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Reset applies the seed without error (owner runs: `npx supabase db reset`)
- All three profiles exist with the expected roles — one `artist`, two `collector`
- Signing in through the app's login form succeeds as each of the three seeded emails
- Re-running the seed against an already-seeded database produces no duplicate-key error

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase. This checkpoint exists specifically to catch a wrong `auth.users` /
`auth.identities` shape before the corpus is authored against these ids.

---

## Phase 2: Cluster Placeholder Images

### Overview

Commit five placeholder images — one per tag cluster plus one for untagged pieces — and establish
the command that puts them into the local Storage bucket.

### Changes Required:

#### 1. Placeholder image assets

**Files**: `supabase/seed-assets/00000000-0000-4000-8000-000000000001/` (new directory, five PNGs)

**Intent**: Give each cluster a visually distinct card image so that judging the ordering is a
glance rather than a tag-list read. The directory is named after the seeded artist's UUID so it can
be uploaded recursively into the bucket at exactly the path the seed rows reference.

**Contract**: Five PNGs, each a flat solid-colour or simple geometric field, small (well under the
bucket's 10 MiB limit), named as 36-character UUID-shaped basenames so the paths match
`IMAGE_PATH_PATTERN` (`src/lib/artworks/images.ts:36-37`):

| File                                       | Cluster          |
| ------------------------------------------ | ---------------- |
| `00000000-0000-4000-8000-0000000000a1.png` | Blue abstraction |
| `00000000-0000-4000-8000-0000000000a2.png` | Warm portraiture |
| `00000000-0000-4000-8000-0000000000a3.png` | Muted landscape  |
| `00000000-0000-4000-8000-0000000000a4.png` | Neon street      |
| `00000000-0000-4000-8000-0000000000a0.png` | Untagged         |

Colours must be clearly distinguishable from one another at card size.

#### 2. Upload command

**File**: no file change — the command is captured in Phase 4's documentation.

**Intent**: Establish and verify the exact invocation, so Phase 4 documents something known to
work rather than something plausible.

**Contract**: Uses the pinned devDependency CLI, the local stack, and the `ss:///bucket/path`
scheme:

```
npx supabase storage cp --local -r \
  supabase/seed-assets/00000000-0000-4000-8000-000000000001 \
  ss:///artworks/00000000-0000-4000-8000-000000000001
```

### Success Criteria:

#### Automated Verification:

- All five files exist with the exact expected names: `ls supabase/seed-assets/00000000-0000-4000-8000-000000000001/`
- Formatting check passes: `npm run format:check`
- Linting passes: `npm run lint`

#### Manual Verification:

- The upload command completes without error (owner runs it against a running local stack)
- `npx supabase storage ls ss:///artworks/00000000-0000-4000-8000-000000000001` lists all five objects
- Opening a public object URL in a browser renders the image rather than a 404
- The five placeholders are visually distinguishable from one another

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 3: Artwork Corpus and Like History

### Overview

Author the 54 artwork rows and the warm collector's like history — the actual substance of the
corpus.

### Changes Required:

#### 1. Seed file, artworks section

**File**: `supabase/seed.sql` (extend)

**Intent**: Insert 48 tagged artworks in four clusters of twelve, plus six untagged, all owned by
the seeded artist and each pointing at its cluster's placeholder image. The clusters are what make
a tag-match ordering legible: liking within one cluster should visibly pull that cluster forward.

**Contract**: One `insert` per cluster, each a literal `values` list of `(id, title, tags)` with
`artist_id` and `image_path` constant across the block. Cluster tag vocabularies:

| Cluster           | Image basename | Tags                                             |
| ----------------- | -------------- | ------------------------------------------------ |
| Blue abstraction  | `…a1.png`      | `abstract`, `blue`, `geometric`, `minimal`       |
| Warm portraiture  | `…a2.png`      | `portrait`, `figurative`, `warm`, `oil`          |
| Muted landscape   | `…a3.png`      | `landscape`, `muted`, `oil`, `pastoral`          |
| Neon street       | `…a4.png`      | `street`, `neon`, `high-contrast`, `photography` |
| Untagged (6 rows) | `…a0.png`      | `'{}'`                                           |

`oil` appearing in both Warm portraiture and Muted landscape is deliberate — it gives the ordering
one overlap case to discriminate rather than four cleanly separated islands. Do not remove it.

Artwork ids should be fixed and sequential-looking so likes can reference them literally. Titles
must be distinct and descriptive enough to identify a card without reading its tags; all must
satisfy the 1–120 length CHECK. Tag arrays must stay lowercase (matching the app's own
normalisation in `src/app/actions/artworks.ts:38-46`) and within the 20-tag ceiling. All inserts
carry `on conflict do nothing`.

`created_at` should be staggered across the corpus rather than left to a single `now()` default,
so that the current newest-first ordering produces an interleaved baseline. A corpus where the
clusters happen to be contiguous by insertion order would make a broken ranking look like a
working one.

#### 2. Seed file, like history section

**File**: `supabase/seed.sql` (extend)

**Intent**: Give the warm collector a taste to rank against, and leave the cold collector empty so
both the ranked and cold-start paths are observable without any clicking.

**Contract**: Eight `interactions` rows with `action = 'like'`, `user_id` = the warm collector's
UUID, `artwork_id` referencing eight of the twelve Blue abstraction pieces. Four are deliberately
left unliked so that cluster still has unseen members for the deck to serve. No rows at all for the
cold collector. `on conflict do nothing` guards the unique `(user_id, artwork_id)` constraint.

### Success Criteria:

#### Automated Verification:

- Formatting check passes: `npm run format:check`
- Linting passes: `npm run lint`
- Type checking passes: `npm run typecheck`
- Unit tests pass: `npm run test`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Reset applies cleanly and the corpus totals 54 artworks, 48 of them tagged (owner runs `npx supabase db reset`)
- Logged in as the warm collector, `/discover` renders a full 20-card deck with visible cluster imagery
- Logged in as the warm collector, the liked view shows exactly the eight seeded Blue abstraction pieces
- Logged in as the cold collector, the liked view is empty and the deck still renders 20 cards
- Neither collector is served any artwork they have already liked
- Untagged pieces appear in the deck and are visually identifiable
- Re-running the seed produces no duplicate-key error

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 4: Workflow Documentation and Judgment Walkthrough

### Overview

Write down how to use the corpus, so that the reset-and-upload pairing is not rediscovered every
time and so the judgment pass has something specific to look for.

### Changes Required:

#### 1. Seed workflow documentation

**File**: `supabase/seed-assets/README.md` (new)

**Intent**: Put the operating instructions next to the assets they operate on. Anyone who finds the
image directory finds the command that uploads it.

**Contract**: Documents, in order: that the corpus is local-only and must never be run against a
linked project; the reset command; the upload command from Phase 2; that **the upload must be
re-run after every reset**, because `supabase db reset` clears Storage objects along with the
database; and the three seeded logins with their shared password.

#### 2. Agent-facing convention note

**File**: `AGENTS.md` (extend)

**Intent**: The existing "Database changes" section tells a future agent how to add a migration but
says nothing about seed data, which risks a future change inventing a second seeding mechanism.

**Contract**: A short addition under the existing `### Database changes` heading naming
`supabase/seed.sql` as the local corpus, stating it is not a migration and is applied by
`supabase db reset`, and pointing at `supabase/seed-assets/README.md` for the workflow.

#### 3. Judgment walkthrough

**File**: `context/changes/ranking-eval-corpus/judgment.md` (new)

**Intent**: F-01 exists so ordering can be _judged_. Without a written procedure, "judge the
ranking" degrades into a vague glance. This is the artifact S-01 will actually use.

**Contract**: A short procedure recording the pre-S-01 baseline and what to compare against after
S-01 ships. Specifically: log in as the warm collector, record the cluster of each of the first 20
cards in order, and note that today's newest-first ordering should show clusters interleaved with
no relationship to the eight Blue abstraction likes. After S-01, the same walk should show Blue
abstraction pieces concentrated at the front. Includes the same walk for the cold collector, whose
deck should not change, and a note on where untagged pieces landed — the observation that feeds
Open Question 4.

### Success Criteria:

#### Automated Verification:

- Formatting check passes: `npm run format:check`
- Linting passes: `npm run lint`
- Full verify gate passes: `npm run typecheck` and `npm run test` and `npm run build`

#### Manual Verification:

- Following the README from a clean reset reproduces a working corpus with rendering images
- The judgment walkthrough can be executed end to end and produces a recorded pre-S-01 baseline
- The baseline confirms clusters are interleaved today, with no relationship to the warm collector's likes

---

## Testing Strategy

### Unit Tests:

None. This change adds no importable module — one SQL file applied by the Supabase CLI and a
directory of images. `AGENTS.md` scopes vitest coverage to Server Actions and `src/lib` helpers
with Supabase mocked; there is no seam here to mock or assert against. Adding a test would mean
adding a real-database integration lane, which is explicitly out of scope.

### Integration Tests:

None, deliberately. See "What We're NOT Doing" — an automated ordering assertion has no contract
to assert against until S-01 exists.

### Manual Testing Steps:

1. Run `npx supabase db reset` and confirm it completes without error.
2. Run the Phase 2 upload command and confirm all five objects are listed by `npx supabase storage ls`.
3. Log in as `seed-collector-warm@artswipe.local` and confirm `/discover` renders 20 cards with images.
4. Confirm the liked view shows exactly eight Blue abstraction pieces.
5. Log in as `seed-collector-cold@artswipe.local` and confirm the liked view is empty.
6. Log in as `seed-artist@artswipe.local` and confirm the studio lists all 54 pieces and `/discover` serves none of them.
7. Re-run the seed by hand and confirm no duplicate-key error.
8. Execute the judgment walkthrough and record the pre-S-01 baseline.

## Performance Considerations

None meaningful. Fifty-four rows against a local Postgres is trivial, and the deck query is capped
at 50 rows by `least(greatest(p_limit, 1), 50)`. The corpus is sized to exceed the 20-card deck so
that refill work (S-02) has something to page through, not to stress anything.

## Migration Notes

Not applicable — this change adds no migration. The seed file is applied by `supabase db reset`,
runs after all migrations, and touches only the local development database. Rollback is deleting
`supabase/seed.sql` and `supabase/seed-assets/`, then resetting.

The one operational note that matters: `supabase db reset` clears Storage objects as well as
database rows, so the image upload is part of the reset workflow rather than one-time setup.

## References

- Roadmap item: `context/foundation/roadmap.md` § Foundations → F-01
- PRD: `context/foundation/prd-v2.md`
- Prior change conventions: `context/changes/ai-artwork-enrichment/plan.md`
- Deck query: `supabase/migrations/20260909160200_add_interactions.sql:50-71`
- Profile trigger: `supabase/migrations/20260909144939_add_user.sql:32-49`
- Image path contract: `src/lib/artworks/images.ts:11-37`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Seeded Identities

#### Automated

- [x] 1.1 Formatting check passes: `npm run format:check` — b912fee
- [x] 1.2 Linting passes: `npm run lint` — b912fee
- [x] 1.3 Type checking passes: `npm run typecheck` — b912fee
- [x] 1.4 Unit tests pass: `npm run test` — b912fee
- [x] 1.5 Production build succeeds: `npm run build` — b912fee

#### Manual

- [x] 1.6 Reset applies the seed without error — b912fee
- [x] 1.7 All three profiles exist with the expected roles — b912fee
- [x] 1.8 Signing in succeeds as each of the three seeded emails — b912fee
- [x] 1.9 Re-running the seed produces no duplicate-key error — b912fee

### Phase 2: Cluster Placeholder Images

#### Automated

- [x] 2.1 All five files exist with the exact expected names — eb134d4
- [x] 2.2 Formatting check passes: `npm run format:check` — eb134d4
- [x] 2.3 Linting passes: `npm run lint` — eb134d4

#### Manual

- [x] 2.4 The upload command completes without error — eb134d4
- [x] 2.5 `storage ls` lists all five objects — eb134d4
- [x] 2.6 A public object URL renders the image rather than a 404 — eb134d4
- [x] 2.7 The five placeholders are visually distinguishable — eb134d4

### Phase 3: Artwork Corpus and Like History

#### Automated

- [x] 3.1 Formatting check passes: `npm run format:check`
- [x] 3.2 Linting passes: `npm run lint`
- [x] 3.3 Type checking passes: `npm run typecheck`
- [x] 3.4 Unit tests pass: `npm run test`
- [x] 3.5 Production build succeeds: `npm run build`

#### Manual

- [x] 3.6 Corpus totals 54 artworks, 48 of them tagged
- [x] 3.7 Warm collector's `/discover` renders a full 20-card deck with cluster imagery
- [x] 3.8 Warm collector's liked view shows exactly the eight seeded pieces
- [x] 3.9 Cold collector's liked view is empty and the deck still renders 20 cards
- [x] 3.10 Neither collector is served an artwork they have already liked
- [x] 3.11 Untagged pieces appear in the deck and are visually identifiable
- [x] 3.12 Re-running the seed produces no duplicate-key error

### Phase 4: Workflow Documentation and Judgment Walkthrough

#### Automated

- [ ] 4.1 Formatting check passes: `npm run format:check`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Full verify gate passes: `npm run typecheck`, `npm run test`, `npm run build`

#### Manual

- [ ] 4.4 Following the README from a clean reset reproduces a working corpus
- [ ] 4.5 The judgment walkthrough executes end to end and produces a pre-S-01 baseline
- [ ] 4.6 The baseline confirms clusters are interleaved today, unrelated to the warm collector's likes
