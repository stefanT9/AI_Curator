# Real Artwork Corpus Implementation Plan

## Overview

Replace the 54-piece synthetic ranking-evaluation corpus with 1000 real public-domain
artworks sampled from the Art Institute of Chicago, tagged from museum metadata plus the
real enrichment pipeline, and generated into `supabase/seed.sql` from a committed manifest.

The corpus that F-01 delivered is a designed instrument: four clusters of twelve, five
placeholder PNGs of 1.8–5.3 KB, and hand-authored tags. Its own plan-brief names the
limitation — "the corpus is designed, not sampled from real data. It can only show whether
ranking _discriminates between clusters_, not whether the tag vocabulary matches real
artwork." This change closes that gap, and in doing so fixes a defect the synthetic corpus
was hiding: its tags are largely off-vocabulary, so 17 of 20 onboarding style pickers
currently return an empty starter pool.

> **Scope amendment, 2026-09-10 (during Phase 1).** Corpus size raised from ~168 to
> **1000** pieces at the owner's request, after the Phase 1 spot-check passed. Figures
> throughout this plan were updated to match rather than left describing a corpus that no
> longer exists. Two knock-on effects, both recorded where they land: the untagged tail
> scales with the corpus (~50 pieces, 5%) so Phase 3's "at least one untagged piece in the
> newest 20 slots" stays satisfiable, and Phase 2 is now ~1000 model calls rather than
> ~160 — an open question for the start of that phase, not something Phase 1 settled.

## Current State Analysis

**The corpus and its mechanism.** `supabase/seed.sql` (287 lines) is applied automatically at
the end of `supabase db reset` via the hook at `supabase/config.toml:85-89`, running as
superuser so RLS never enters the picture. It seeds three identities as raw
`auth.users` + `auth.identities` pairs (profiles arrive via the `on_auth_user_created`
trigger), then 54 artworks and 8 likes. Every id is a hardcoded UUID and every insert carries
`on conflict do nothing`. Storage is unreachable from SQL, so five placeholder PNGs upload
separately via `npm run db:seed:images`, which `npm run db:reset` chains after the reset.

**The tags are off-vocabulary.** `supabase/seed.sql` contains exactly four distinct tag sets:

| Cluster | Tags | In `taxonomy.ts`? |
| --- | --- | --- |
| Blue abstraction | `{abstract,blue,geometric,minimal}` | `abstract`, `geometric` only |
| Warm portraiture | `{portrait,figurative,warm,oil}` | `portrait`, `figurative` only |
| Muted landscape | `{landscape,muted,oil,pastoral}` | `landscape`, `muted` only |
| Neon street | `{street,neon,high-contrast,photography}` | `neon`, `photography` only |

`blue`, `minimal`, `oil`, `warm`, `pastoral`, `street` and `high-contrast` do not exist in
`src/lib/ai/taxonomy.ts` — which has `blue dominant`, `minimalist`, `oil painting`,
`warm palette`, `muted`, `street art` and `high contrast`. The corpus was never tag-compatible
with what enrichment actually produces.

**That silently breaks S-04's onboarding.** `getStarterDeck` in `src/lib/artworks/queries.ts`
filters `.overlaps("tags", terms)` where `terms` are validated against
`TAXONOMY_BY_FACET[ONBOARDING_FACET]` — the 20-term **style** facet
(`src/lib/onboarding/terms.ts`, `src/lib/onboarding/config.ts`). The corpus carries only three
style terms: `abstract`, `geometric`, `figurative`. A collector picking any of the other
seventeen gets a zero-row starter pool and is released straight onto the exhaustion path with
no likes — indistinguishable from a broken flow.

**What is calibrated against the corpus.** The archived judgment walkthrough
(`context/archive/2026-09-10-ranking-eval-corpus/judgment.md`) records a pre-S-01 baseline as a
sequence of cluster codes, and depends on the `[N]` title prefixes, the round-robin `created_at`
stagger, the `oil` tag shared between two clusters as the one discrimination case, and the warm
collector's eight same-cluster likes. S-02 (`continuous-deck-refill`, ready and unblocked) needs
a corpus larger than the 20-card deck.

### Key Discoveries:

- **AIC's API needs no key and exposes 62,056 public-domain works.** Verified against
  `https://api.artic.edu/api/v1/artworks/search` with `query[term][is_public_domain]=true`.
  Response `info.license_text` states all fields except `description` are CC0; `description`
  alone is CC-BY.
- **`classification_titles`, `subject_titles` and `color` map onto three of our five facets.**
  Van Gogh's *The Bedroom* returns `classification_titles: ["oil on canvas", "painting",
  "european painting", …]`, `subject_titles: ["interiors", "chair", "blue (color)", …]`, and
  `color: {h:40, l:34, s:65, population:1591}`.
- **`style_titles` is useless for our style facet.** It carries art-historical period and
  culture labels — `Post-Impressionism`, `Pre-Columbian`, `chola`, `19th century`. Direct term
  queries return: `surrealism` → 0, `minimalism` → 0, `expressionism` → 0, `psychedelic` → 0,
  `abstract` → 1, `cubism` → 3. Multi-word terms return a constant 1799 because the query ORs
  on the token "art". Full-text `q=abstract geometric` returns Pre-Columbian ceramic bowls whose
  *titles* contain those words. **Style and mood must come from enrichment.**
- **The IIIF image endpoint 403s without a `User-Agent`.** `curl` bare returns
  `http=403 type=text/html`; with `-H "AIC-User-Agent: …" -H "User-Agent: …"` it returns
  `http=200 bytes=235077 type=image/jpeg`, `843x660`. URL shape is
  `{config.iiif_url}/{image_id}/full/843,/0/default.jpg`.
- **No local resize step is needed.** IIIF sizes server-side, so there is no `sharp` or image
  library dependency — the 843px JPEG arrives ready to upload.
- **`server-only`'s default export throws.** `node_modules/server-only/package.json` maps
  `react-server` → `empty.js` and `default` → `index.js`, and `index.js` is a bare `throw`.
  `node --conditions=react-server` clears it (verified: the probe reached the *next* import).
- **Plain Node still cannot import `src/lib/ai/enrich.ts`.** Its relative imports are
  extensionless (`./schema`, `./taxonomy`); Node ESM requires extensions and its TS support does
  not add resolution. Verified: `ERR_MODULE_NOT_FOUND: Cannot find module '…/src/lib/ai/schema'`.
  Hence the `tsx` devDependency.
- **Schema constraints that bind the generator.** `title` 1–120 chars
  (`supabase/migrations/20260909160100_add_artworks.sql:15`) — AIC titles overflow; `tags`
  cardinality ≤ 20 (`20260909214144_raise_artwork_tag_limit.sql`) — room for all five facets;
  `image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'`
  (`20260910000100_constrain_artwork_image_path.sql`, `not valid`, so existing rows are exempt
  but every seed insert must comply).
- **`enrichFromImage` never throws and takes a `data:` URL.** `src/lib/ai/enrich.ts`: a
  three-model free-tier fallback chain under one shared 25 s budget, returning
  `{ ok: false, reason }` on failure. It reads `OPENROUTER_API_KEY` lazily inside the function.
- **There is no `scripts/` directory and no TS runner.** devDependencies are Tailwind, ESLint,
  Prettier, `supabase`, TypeScript and Vitest. Node is v26.

## Desired End State

A developer runs `npm run db:seed:fetch` once (network), then `npm run db:reset`, and lands in a
local app whose catalogue is 1000 real artworks by real artists — recognisable paintings,
prints, ceramics, photographs and sculpture — tagged with terms drawn entirely from
`src/lib/ai/taxonomy.ts` across all five facets. A fresh clone regenerates the identical corpus from the
committed manifest, because every AIC object id, every tag and every UUID is pinned in it.

Verified by: `npm run db:seed:coverage` reporting per-facet term coverage; the full verify gate
passing; and a recorded judgment walkthrough over the emergent tag groups. Note the 2026-09-10
amendment: "every one of the 20 onboarding style terms returns a non-empty starter pool" is no
longer this change's promise — it is delivered by the data-driven picker change, which offers
only populated terms. This change's job is that the corpus is real and its coverage is measured.

## What We're NOT Doing

- **No schema change and no migration.** The corpus fits the existing tables and constraints.
- **No type regeneration.** `db:types:local` is the user's to run and no schema changes here.
- **No application code changes in this change.** Not `swipe_deck`, not `getStarterDeck`, not
  the onboarding picker, not the upload flow. The original rider — "if coverage cannot be met by
  data, it is met by a manifest override" — was reversed on 2026-09-10 (see the Phase 3
  amendment): coverage gaps are now recorded as findings, and the empty-starter-pool defect is
  fixed by making the picker data-driven in a **separate change**. The guardrail it protected
  still stands: nothing here narrows the vocabulary production collectors are offered.
- **No second seeding mechanism.** `supabase/seed.sql` remains the single thing `db reset`
  applies. The script generates that file; it does not insert rows itself.
- **No committed image bytes.** The asset directory is gitignored; the manifest is the durable
  artifact.
- **No production or linked-project seeding.** The file-top warning and README stay.
- **No automated ranking assertions.** S-01 already ships its own; this corpus is for human
  judging.
- **No retro-tagging of real pre-enrichment artworks.** Still Parked in the roadmap.
- **No second image source.** AIC only; gaps close via manifest overrides.
- **No preservation of the F-01 recorded baseline as comparable.** Sampling naturally means the
  cluster codes cease to exist; the archived measurements are annotated as superseded, not
  re-derived.

## Implementation Approach

One new script, one new devDependency, one gitignored asset directory, one committed manifest,
and a regenerated `seed.sql`.

The manifest (`supabase/seed-assets/corpus.json`) is the source of truth and the unit of review:
for each piece it pins the AIC object id, the `image_id`, a generated piece UUID, the truncated
title, the artist attribution, the final tag array, the enrichment-written description, and the
`created_at` slot. Everything else is derived from it. Determinism therefore survives AIC
changing, a model being retired, or the free roster churning — regeneration reads the manifest,
not the network.

`scripts/build-corpus.ts` runs in stages so an expensive stage is never repeated needlessly:
`fetch` (network → manifest + images), `enrich` (images → manifest, resumable), `coverage`
(manifest → report), `generate` (manifest → `seed.sql`). Each stage reads and writes the same
manifest, so a failure halfway leaves usable progress.

`seed.sql` gains a generated region. Its hand-authored identity section (which encodes hard-won
GoTrue knowledge about empty-string token columns) stays hand-authored above an explicit marker;
everything below the marker is written by the generator and must not be hand-edited.

## Critical Implementation Details

**AIC request headers are mandatory, and only for images.** The JSON API answers a bare `curl`;
the IIIF image server returns `403 text/html` without a `User-Agent`. Both `User-Agent` and
`AIC-User-Agent` (AIC's documented courtesy header, identifying the application) go on every
image request. A missing header fails as an HTML body with a 200-shaped pipeline in some
clients, so the fetch stage must assert `content-type: image/*` rather than trusting the status.

**Enrichment must be fed local bytes, not the IIIF URL.** `enrichFromImage` accepts an https URL,
but the provider fetches it, and the provider will hit the same 403. Read the downloaded file and
pass a `data:image/jpeg;base64,…` URL — `mediaTypeOf` in `src/lib/ai/enrich.ts` reads the type
from the data URL prefix, so it is typed correctly.

**The enrich stage is the long pole and must be resumable.** ~1000 pieces against a free-tier
chain with a 25 s ceiling is tens of minutes at best. Write each result into the manifest as it
arrives, skip pieces already carrying enrichment on re-run, and bound concurrency (4 is a
reasonable ceiling against a free tier that returns 429). A piece whose enrichment returns
`ok: false` is left metadata-tagged rather than failing the run.

**The script bypasses the enrichment quota deliberately.** `ai_enrichment_calls`
(`20260910101500_add_enrichment_quota.sql`) is enforced by the `suggestArtworkFields` Server
Action, not by `enrichFromImage`. Calling the library directly writes no ledger row, which is
correct for a local corpus build — but it means the script is not a test of the quota path.

**`created_at` must not be ordered by tag group.** A corpus whose groups are contiguous by
insertion order makes a broken ranking look correct — the reason F-01 staggered round-robin. With
groups emergent rather than designed, the generator assigns slots by **deterministic shuffle**
(seeded by the piece UUID) rather than by group rotation, which achieves the same interleaving
without needing to know the groups in advance.

## Phase 1: Fetch script and manifest

### Overview

Stand up the script, the runner, and the fetch stage: sample AIC broadly, map museum metadata
onto the medium / subject / palette facets, download images, and pin everything into a committed
manifest.

### Changes Required:

#### 1. TypeScript runner

**File**: `package.json`

**Intent**: Add the only new dependency this change needs, plus the script entry points, so the
generator can import `src/lib/ai` the way Next does.

**Contract**: `tsx` as a devDependency. Four new scripts, each a stage of the same file:
`db:seed:fetch`, `db:seed:enrich`, `db:seed:coverage`, `db:seed:generate`. Every one invokes
`tsx --conditions=react-server scripts/build-corpus.ts <stage>`. The `--conditions` flag is
load-bearing, not decoration: without it `import "server-only"` throws before any of our code
runs. `db:reset` is left alone.

#### 2. Ignore the fetched bytes

**File**: `.gitignore`

**Intent**: Keep ~260 MB of JPEGs out of git history while leaving the manifest and the README
tracked.

**Contract**: Ignore the seeded artist's asset directory
(`supabase/seed-assets/00000000-0000-4000-8000-000000000001/`) with a negation for nothing —
the five placeholder PNGs currently living there are deleted by this phase, so the whole
directory becomes generated. `supabase/seed-assets/corpus.json` and `README.md` sit outside it
and stay tracked.

#### 3. Retire the placeholder images

**File**: `supabase/seed-assets/00000000-0000-4000-8000-000000000001/*.png`

**Intent**: Delete the five synthetic PNGs. They are the thing this change exists to replace,
and leaving them would let a stale `db:seed:images` upload succeed against a corpus that no
longer references them.

**Contract**: Five files removed: `…a0.png` through `…a4.png`.

#### 4. The corpus manifest

**File**: `supabase/seed-assets/corpus.json`

**Intent**: Define the pinned, reviewable record every later stage reads and writes. This file is
the durable artifact of the whole change — the images are regenerable, this is not.

**Contract**: A versioned object with a `source` block (AIC base URL, `iiif_url`, the licence
statement, the sampling query and the date sampled) and a `pieces` array. Each piece carries:
`aic_id`, `image_id`, `piece_uuid` (the artwork row id and image filename stem), `title`
(truncated to 120), `artist` (AIC `artist_title`, nullable), `tags_from_metadata`,
`tags_from_enrichment` (absent until Phase 2), `tag_overrides` (absent until Phase 3),
`description` (absent until Phase 2), `slot` (the `created_at` offset), `image_width` (the IIIF
width actually requested, so a re-download needs no API call), and `untagged` (a boolean set in
Phase 3). The `pieces` array is sorted by `aic_id` and each piece is written in a fixed key order
with a trailing newline, so a regeneration diff is reviewable rather than a reshuffle. Keys are
in declared order, not alphabetical. Both the reader and the writer preserve keys they do not
know, so a stage that re-reads the manifest can never delete another stage's work.

#### 5. The generator: fetch stage

**File**: `scripts/build-corpus.ts`

**Intent**: Sample AIC broadly enough that emergent tag groups are meaningful, map what museum
metadata reliably knows onto our vocabulary, and download each image once.

**Contract**: A stage dispatcher plus the `fetch` stage. Sampling spreads across AIC
`classification_titles` families (painting, print, drawing, photograph, **ceramics** — the
spelling the index uses — textile, sculpture) with `is_public_domain` true and `fields` limited
to what the mapping consumes, sampling to 1000 pieces with `image_id` non-null. AIC refuses any
offset above 1000, so a 24,740-piece family cannot be paged through: each family is instead
partitioned into six accession-id buckets and sampled from the head of each. Family targets are
allocated with a per-family cap and the shortfall redistributed, because `drawing` holds only 31
public-domain works in total. Resume is additive — pieces already in the manifest are pinned,
never re-sampled and never re-downloaded, and only the shortfall is fetched. Three mappers, each producing only
taxonomy terms:

- **medium** ← `classification_titles` / `medium_display`, matched against
  `TAXONOMY_BY_FACET.medium` through a committed synonym table (`"oil on canvas"` → `oil painting`,
  `"gelatin silver print"` → `photography`, `"earthenware"` → `ceramic`).
- **subject** ← `subject_titles`, matched against `TAXONOMY_BY_FACET.subject` through the same
  table (`"interiors"` → `interior`, `"bedrooms"` → `interior`).
- **palette** ← `color` HSL. Saturation and lightness thresholds give `monochrome`,
  `desaturated`, `muted` or `vivid`; hue buckets give `red dominant` / `green dominant` /
  `blue dominant`, emitted only above a saturation floor since the hue of a near-grey is noise;
  a near-grey that is also very dark **or** very light gives `black and white`. The thresholds
  are a documented constant block, not scattered literals.

The AIC response and the manifest are both validated with Zod at the boundary per AGENTS.md —
the manifest loosely, so unknown keys survive. Imports `TAXONOMY_BY_FACET` from
`@/lib/ai/taxonomy` so a term that leaves the vocabulary breaks the build rather than silently
producing an unmatchable tag. Every mapper output is asserted to
be a member of its facet before it reaches the manifest. Titles longer than 120 characters are
truncated on a word boundary with an ellipsis. Images are written as
`<artist-uuid>/<piece_uuid>.jpg` to satisfy `image_path_pattern`, requested at IIIF width 843
**capped at the source width** — AIC 403s any request that would upscale — with both user-agent
headers, and rejected unless the response `content-type` starts with `image/` and the bytes begin
with a JPEG magic number. Writes go through a temporary file and an atomic rename, and a
zero-byte file counts as absent, so an interrupted run is repaired rather than trusted.
Re-running skips pieces already in the manifest with a non-empty downloaded file present.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes
- `npm run build` passes
- `npm run db:seed:fetch` exits 0 and writes 1000 pieces to `supabase/seed-assets/corpus.json`
- Every `tags_from_metadata` entry is a member of `ARTWORK_TAGS` (asserted by the script, which
  exits non-zero otherwise)
- Every downloaded filename matches `^[0-9a-f-]{36}\.jpg$` and every file is a real JPEG
- `git status` shows no untracked files under the artist asset directory

#### Manual Verification:

- Spot-check five pieces: the image opens and is the artwork the AIC page for that `aic_id` shows
- The metadata-derived tags read as true of the piece, not merely plausible
- Re-running `npm run db:seed:fetch` re-downloads nothing and leaves `corpus.json` byte-identical

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 2: Enrichment top-up

> **Amended 2026-09-10, before Phase 2 starts.** Two things changed since this phase was
> written.
>
> **Size is no longer forced.** The data-driven picker (see the Phase 3 amendment) means
> enrichment no longer has to reach 20/20 style coverage, so the number of pieces to enrich is a
> free choice rather than a target. **Decision: run a 25-piece trial first, measure, then choose
> the full number with evidence.** The trial measures the four things worth knowing before
> committing an hour — per-piece wall-clock, failure rate, whether the tags are defensible, and
> which style terms real CC0 art actually produces. It also discharges manual step 2.12, which
> asks for exactly that latency measurement.
>
> **This requires a `--limit` (or equivalent) option on the `enrich` stage**, which the original
> contract below does not mention. Add it: without one there is no way to run a trial.
>
> **Measured account facts (2026-09-10), so nobody re-derives them:** `OPENROUTER_API_KEY` is
> present in `.env.local`; the account is **not** free-tier (credits present, $10 limit, $0
> used), so the cap is **1000 free-model requests per day**. The `:free` models cost nothing —
> the credit balance only unlocks the higher daily tier. Note that `enrichFromImage` falls back
> across up to three models, so a failure-heavy run makes **more than one request per piece** and
> 1000 pieces can exceed the daily cap. That is survivable precisely because the stage is
> resumable, which is why resumability is non-negotiable here.

### Overview

Fill the two facets museum metadata cannot supply — style and mood — by running each downloaded
image through the real enrichment pipeline, and pin the results.

### Changes Required:

#### 1. The generator: enrich stage

**File**: `scripts/build-corpus.ts`

**Intent**: Give every piece style and mood tags plus a description, produced by the same code
path production uses, and make the run survivable across tens of minutes and a flaky free tier.

**Contract**: An `enrich` stage that imports `enrichFromImage` from `@/lib/ai` — the only module
permitted to talk to a model — and for each piece lacking `tags_from_enrichment`, **up to an
optional `--limit N` (default: all)**, reads its downloaded JPEG, encodes it as a `data:image/jpeg;base64,…` URL, and calls the function. From the
returned `Enrichment` it keeps the style and mood terms and the description, discarding generated
medium / subject / palette terms in favour of the museum's own. Results are written into the
manifest incrementally, so an interrupted run resumes. Concurrency is bounded at 4. A piece
returning `{ ok: false }` is recorded with an empty `tags_from_enrichment` and an explicit
`enrichment_failed` reason, and the run continues; the stage prints a summary of failures and
exits 0 unless *every* piece failed. `OPENROUTER_API_KEY` absent is a clear up-front error, not
160 `unconfigured` results.

#### 2. Combined-tag assembly and the cardinality ceiling

**File**: `scripts/build-corpus.ts`

**Intent**: Merge the two tag sources into the array that reaches the database, within the
schema's limit and without letting one facet crowd out the others.

**Contract**: A pure function combining `tags_from_metadata` and `tags_from_enrichment` into a
deduplicated array capped at 20 to satisfy
`artworks_tags_length`. When over the cap it trims by taking terms round-robin across the five
facets rather than truncating the concatenation — a flat truncation would drop mood entirely,
which is the facet with the fewest terms per piece. Exported and unit-tested.

#### 3. Unit tests for the pure logic

**File**: `test/build-corpus.test.ts`

**Intent**: Cover the parts of the generator that are pure decisions, in the default lane, with
no network and no model.

**Contract**: Tests for the metadata mappers (a known AIC payload maps to known taxonomy terms),
the palette HSL thresholds at their boundaries, title truncation at exactly 120 characters, and
the tag combiner's round-robin trim at the 20-term ceiling. The default lane never hits AIC or
OpenRouter, matching the rule that Supabase and external services are mocked there.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes, including the new `test/build-corpus.test.ts`
- `npm run build` passes
- `npm run db:seed:enrich` exits 0 and every piece in the manifest carries either
  `tags_from_enrichment` or an `enrichment_failed` reason
- Every `tags_from_enrichment` entry is a member of `TAXONOMY_BY_FACET.style` or
  `TAXONOMY_BY_FACET.mood` (asserted by the script)
- No piece's combined tag array exceeds 20 entries
- Re-running `npm run db:seed:enrich` makes zero model calls and leaves `corpus.json`
  byte-identical

#### Manual Verification:

- Spot-check five pieces: the style and mood tags are defensible for the image, and the
  description reads as an artist's own register rather than "this image shows"
- The failure count is a small minority; if most pieces failed, the model roster has churned and
  `MODELS` in `src/lib/ai/enrich.ts` needs re-checking before continuing
- Note the observed wall-clock and rough per-call latency — this is the first real measurement of
  vision latency at volume, and `context/foundation/infrastructure.md` carries it as an open
  H/H risk

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 3: Coverage reporting and the untagged tail

> **Amended 2026-09-10, after Phase 1.** Curatorial overrides are dropped and the coverage
> stage stops gating. The owner chose to fix the empty-starter-pool defect at its root
> instead: the onboarding picker will offer only terms that have artworks behind them,
> computed from the catalogue, in a separate change. That makes 20/20 the wrong target here
> — a public-domain corpus that lacks `street art` should say so, not be tagged into
> claiming otherwise. What this phase owed the product (no collector meets an empty pool) is
> now owed by the picker; what it still owes is an honest measurement and the untagged tail.
> The dropped work is recorded below rather than deleted, so the reversal stays legible.

### Overview

Measure which vocabulary terms the corpus can actually serve, record the gaps as findings
rather than closing them, and choose the untagged tail.

### Changes Required:

#### 1. The generator: coverage stage

**File**: `scripts/build-corpus.ts`

**Intent**: Report exactly which vocabulary terms the corpus can serve, so the shape of a real
public-domain collection is a visible measurement — and so the picker change downstream has a
number to be checked against.

**Contract**: A `coverage` stage that, for every term in all five facets, counts manifest pieces
whose combined tags contain it — the same overlap `getStarterDeck` performs. Prints a per-facet
table and **always exits 0**: a term with no pieces is a finding about public-domain art, not a
build failure. The threshold for "covered" is 1, matching the query — `getStarterDeck` returns
rows or it does not, and `ONBOARDING_POOL_SIZE` is only a ceiling.

#### 2. Curatorial overrides — DROPPED

**Superseded by the amendment above.** The original contract added a `tag_overrides` array with
an `override_reason` to the handful of pieces needed to reach 20/20 on the style facet. It is
dropped: with a data-driven picker there is no number to hit, and tagging a 19th-century etching
`street art` because it is "the closest real match" would put a false tag on a real artwork to
satisfy a check that no longer exists. `tag_overrides` and `override_reason` are therefore never
added to the manifest, and the combiner has no third tag source.

#### 3. The untagged tail

**File**: `supabase/seed-assets/corpus.json`

**Intent**: Preserve a real untagged population so S-01's outermost sort key — untagged demoted
below every tagged piece, including previously-passed ones — stays observable.

**Contract**: ~50 pieces (5% of the corpus) marked `untagged: true`. The generator emits `'{}'` for their `tags`
and drops their description, regardless of what the earlier stages produced for them. They are
chosen spread across the `slot` range, including inside the newest-20 window, so a walk can see
where they land. This mirrors production, where no backfill exists for pre-enrichment artworks —
the reason Open Roadmap Question 4 existed.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes
- `npm run build` passes
- `npm run db:seed:coverage` exits 0 and reports per-facet term coverage across all five facets
- ~50 pieces (5%) carry `untagged: true`
- No piece carries a `tag_overrides` entry — the manifest has no override mechanism

#### Manual Verification:

- Read the coverage report: the uncovered terms are ones public-domain art genuinely lacks, and
  they are recorded as findings rather than closed
- The untagged tail includes at least one piece in the newest 20 slots, so a walk will encounter
  one

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 4: seed.sql generation

### Overview

Generate the corpus half of `supabase/seed.sql` from the manifest, preserving the hand-authored
identity half, and re-derive the warm collector's like history onto a group that actually emerged.

### Changes Required:

#### 1. The generated region boundary

**File**: `supabase/seed.sql`

**Intent**: Let one file be half hand-authored and half generated without either half putting the
other at risk.

**Contract**: The existing header comment and the whole Phase 1 identities section stay exactly
as they are — they encode the GoTrue requirement that every text token column be an empty string
rather than NULL, which is not re-derivable and must not be regenerated. Below them, an explicit
`-- === GENERATED BY scripts/build-corpus.ts — DO NOT HAND-EDIT ===` marker, and everything after
it is written by the generator. The header comment gains a line pointing at the manifest as the
place to make corpus changes.

#### 2. The generator: generate stage

**File**: `scripts/build-corpus.ts`

**Intent**: Emit the artworks and interactions inserts from the manifest, deterministically, so
the same manifest always produces the same file.

**Contract**: A `generate` stage that reads `seed.sql`, keeps everything above the marker
verbatim, and rewrites below it. Emits one `insert into public.artworks (id, artist_id, title,
description, tags, image_path, created_at) values …` covering all pieces, with `on conflict do
nothing`, all owned by the existing seeded artist UUID. `created_at` is
`timestamptz '2026-01-01 00:00:00+00' + interval 'N hour'` where the slot order is a
**deterministic shuffle seeded by piece UUID** — not group rotation, since groups are emergent —
so the newest-first deck is visibly interleaved and a broken ranking cannot pass by accident.
Titles carry no cluster-code prefix: real artwork is identifiable by its image, which is the
point of the change. `description` carries the enrichment paragraph plus an attribution line
(`artist_title`, AIC object id) — AIC's own `description` field is CC-BY and is never copied.
All string literals are SQL-escaped; AIC titles contain apostrophes.

#### 3. Re-derived like history

**File**: `scripts/build-corpus.ts`

**Intent**: Give the warm collector a like history concentrated in one real tag group, so a
ranked deck has something to visibly concentrate on.

**Contract**: The generator picks the most populous emergent style tag, takes eight pieces
carrying it, and emits `insert into public.interactions (…, action) values (… 'like')` for the
warm collector, with `on conflict do nothing`. The chosen tag and the eight piece UUIDs are
written back into the manifest under `like_history` so the judgment walkthrough can name the
group rather than rediscovering it. The cold collector gets no interactions, as today.

#### 4. Workflow documentation

**File**: `supabase/seed-assets/README.md`

**Intent**: Make the new prerequisite unmissable. The asset directory is now gitignored, so a
fresh clone has no images and `db:reset` alone produces a corpus of broken thumbnails.

**Contract**: Rewrite for the four-stage script: `db:seed:fetch` is a one-time network
prerequisite after a clone (and a re-run only when the manifest changes), while `db:reset`
remains the per-reset command. Document that the manifest is the place to change the corpus and
`seed.sql`'s generated region is not, the AIC CC0 licence and the `AIC-User-Agent` courtesy
header, `OPENROUTER_API_KEY` as required only for `db:seed:enrich`, and the unchanged seeded
logins. Keep the local-development-only warning.

#### 5. Agent-facing conventions

**File**: `AGENTS.md`

**Intent**: Record the two rules a future agent would otherwise break — hand-editing generated
SQL, and adding a second seeding mechanism now that a script exists.

**Contract**: Extend the existing `supabase/seed.sql` bullet under *Database changes*: the corpus
region is generated from `supabase/seed-assets/corpus.json` by `scripts/build-corpus.ts`, edit the
manifest and regenerate, and `db:seed:fetch` is a prerequisite because the images are gitignored.
Note `tsx --conditions=react-server` as the only way a script may import `src/lib/**`, and why.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes
- `npm run build` passes
- `npm run db:seed:generate` exits 0 and rewrites only the region below the marker (verified by
  diffing the identities section — it must be untouched)
- Re-running `npm run db:seed:generate` leaves `supabase/seed.sql` byte-identical
- `npx supabase db reset` applies the seed with no SQL error
- Row counts after reset: 1000 artworks, 8 `interactions` rows for the warm collector, 0 for the
  cold collector, 8 artworks with `tags = '{}'`
- Every `image_path` in the database satisfies `image_path_pattern`
- `npm run db:seed:images` uploads every file and `npx supabase storage ls` lists 1000 objects

#### Manual Verification:

- Sign in as the warm collector, complete or bypass onboarding, and open `/discover`: cards show
  real artwork, images render rather than 404, titles read as real titles
- The first 20 cards are visibly interleaved across tag groups, not grouped
- Sign in as the cold collector and pick each of several style terms in the onboarding picker:
  every one produces a non-empty starter set
- Sign in as the seeded artist: their own work is absent from their deck

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 5: Judgment walkthrough and docs

### Overview

Re-establish the judging instrument on the new footing: name the tag groups that emerged, write
a walkthrough against them, record a baseline, and mark the F-01 walkthrough superseded.

### Changes Required:

#### 1. Emergent group labels

**File**: `context/changes/real-artwork-corpus/judgment.md`

**Intent**: Restore what made the F-01 walk usable — a card whose group you can read off at a
glance — without the `[N]` title prefixes that natural sampling gives up.

**Contract**: A cheat-sheet section derived from the manifest: the most populous style/palette
tag combinations that actually emerged, each with a short label, its tag signature, its piece
count, and two or three example titles. Derived, not designed — the section states which manifest
fields it was computed from so it can be recomputed after a regeneration.

#### 2. The walkthrough

**File**: `context/changes/real-artwork-corpus/judgment.md`

**Intent**: Give the same two walks the corpus has always supported, retargeted at real art and
emergent groups, so ranking stays judged rather than guessed at.

**Contract**: Walk A (warm collector) and Walk B (cold collector), each recording the first 20
cards as group labels, with expectations stated for the current shipped behaviour: Walk A should
concentrate the warm collector's liked group near the front, and Walk B should be tagged pieces
newest-first with the untagged tail below all of them. Both note that a card's group is now read
from its image and title, and that untagged pieces are identified by having no tags rather than
by a `[U]` prefix. Includes the S-04 note that the onboarding gate must be satisfied — the SQL
`onboarded_at` stamp — before Walk B measures a genuinely cold deck.

#### 3. Recorded baseline

**File**: `context/changes/real-artwork-corpus/judgment.md`

**Intent**: Record what the corpus actually shows today, so a later ranking change has a real
"before" on real data.

**Contract**: A dated recorded-baseline section with both walks' group sequences, the untagged
positions observed, and a yes/no on whether the liked group concentrated at the front. This is
the first such measurement over real tags; if S-01's ordering does *not* concentrate, that is a
finding about the tag distribution, not a corpus defect, and it is recorded as such.

#### 4. Supersede the F-01 walkthrough

**File**: `context/archive/2026-09-10-ranking-eval-corpus/judgment.md`

**Intent**: Stop a future reader running a walk whose cluster codes no longer exist, following
the annotate-in-place convention S-01 and S-04 both used on this same file.

**Contract**: An appended annotation, retracting nothing: the corpus it measured has been
replaced by real sampled artwork, the `[N]` cluster codes and the four designed clusters no
longer exist, so its walks are not runnable and its recorded measurements are not comparable to
anything current. Points at this change's `judgment.md` as the live instrument, and states that
the recorded F-01 numbers remain valid as history of the synthetic corpus.

#### 5. Roadmap entry

**File**: `context/foundation/roadmap.md`

**Intent**: Record work that happened outside the roadmap's planned slices, and retire the
limitation it removes.

**Contract**: An entry noting the corpus is now sampled real CC0 artwork with taxonomy-conformant
tags, that this closed the off-vocabulary starter-pool defect, and that Open Roadmap Question 1
(how tags are weighted when matching) is now answerable against real data. Note the residual: a
handful of style terms are covered by curatorial override rather than by real pieces.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes
- `npm run build` passes
- `context/changes/real-artwork-corpus/judgment.md` exists and its cheat-sheet group counts sum to
  the manifest's tagged-piece count

#### Manual Verification:

- Walk A and Walk B both run end to end using only the cheat-sheet, without needing to inspect
  the database
- The recorded baseline is filled in with real observations, not left as a template
- A reader arriving at the archived F-01 walkthrough is told within its first screen that it is
  superseded

**Implementation Note**: This is the final phase. After automated verification passes, confirm the
manual walks were actually performed and recorded — a template left unfilled is the failure mode
`context/foundation/lessons.md` warns about under "Prove each Progress item before checking it
off".

---

## Testing Strategy

### Unit Tests:

- The AIC metadata mappers: a pinned real payload maps to known taxonomy terms
- Palette HSL thresholds at their boundary values
- Title truncation at exactly 120 characters, and on a word boundary
- The tag combiner's round-robin trim at the 20-term ceiling
- Vocabulary assertion: a mapper output outside `ARTWORK_TAGS` fails loudly

### Integration Tests:

None added. The real boundary this change crosses is AIC and OpenRouter, and the integration lane
refuses anything but a local Supabase stack. The `npx supabase db reset` + row-count checks in
Phase 4 are the integration verification, run by hand as part of that phase.

### Manual Testing Steps:

1. `npm run db:seed:fetch`, then `npm run db:seed:enrich`, then `npm run db:seed:coverage`,
   then `npm run db:seed:generate`
2. `npm run db:reset`
3. Sign in as the cold collector, run onboarding, pick several different style terms and confirm
   each yields a non-empty starter set
4. Sign in as the warm collector, open `/discover`, and record Walk A
5. Reset the cold collector's `onboarded_at` by SQL stamp and record Walk B
6. Sign in as the seeded artist and confirm their own work is absent from their deck
7. Delete the asset directory, run `npm run db:reset`, and confirm the failure is a clear
   "run db:seed:fetch first" rather than silent broken images

## Performance Considerations

The enrich stage is the only expensive part: ~1000 images against a free-tier chain with a 25 s
ceiling, bounded at concurrency 4, so tens of minutes. It is a one-time cost paid by whoever
regenerates the corpus, never by a developer running `db:reset`, because the results are pinned
in the manifest.

At runtime the corpus is roughly nineteen times larger than before. `swipe_deck` ranks in SQL over
an `artworks_tags_idx` GIN index and returns a 20-card page, so 1000 rows is not a scale
concern — but it is the first time the ranking query runs over a realistic tag distribution
rather than four uniform clusters, and Phase 4's manual verification is where a surprise would
show up.

Storage holds ~260 MB across 1000 objects locally. Nothing is committed.

## Known Intermediate State

**Between Phase 1 and Phase 4 this branch does not run locally.** Phase 1 deletes the five
placeholder PNGs; Phase 4 is what regenerates `supabase/seed.sql`. In between, `seed.sql` still
references those files 54 times, so `npm run db:reset` seeds 54 rows whose `image_path` points at
objects that no longer exist, and `npm run db:seed:images` uploads ~260 MB of JPEGs that no row
references yet.

Nothing is lost — the placeholders are recoverable at `03d7e7f^` — but the consequence is a
merge constraint, recorded here rather than discovered: **do not merge this branch until Phase 4
has regenerated `seed.sql`.** Phases 1 through 4 land together. Restoring the placeholders behind
a `.gitignore` negation was considered and rejected: it trades a visible breakage on a
feature branch for a hidden one that has to be remembered and undone later.

## Migration Notes

No data migration. The corpus is local-development-only seed data, replaced wholesale by
`supabase db reset`.

One workflow change is breaking for existing clones: the asset directory is now gitignored and
populated by `npm run db:seed:fetch`, so anyone who pulls this change must run that once before
their next `db:reset`. Phase 4's README rewrite and the guard in step 7 of the manual testing
steps exist to make that failure self-explaining rather than mysterious.

## References

- Prior corpus (superseded): `context/archive/2026-09-10-ranking-eval-corpus/plan.md`
- Baseline being superseded: `context/archive/2026-09-10-ranking-eval-corpus/judgment.md`
- Ranking this corpus judges: `context/archive/2026-09-10-personalized-deck-ranking/`
- Starter pool query: `src/lib/artworks/queries.ts` — `getStarterDeck`
- Controlled vocabulary: `src/lib/ai/taxonomy.ts`
- Enrichment contract: `src/lib/ai/enrich.ts`
- Tag ceiling: `supabase/migrations/20260909214144_raise_artwork_tag_limit.sql`
- Image path pattern: `supabase/migrations/20260910000100_constrain_artwork_image_path.sql`
- AIC API terms and licence: https://www.artic.edu/open-access/public-api

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Fetch script and manifest

#### Automated

- [x] 1.1 `npm run format:check` passes — 03d7e7f
- [x] 1.2 `npm run lint` passes — 03d7e7f
- [x] 1.3 `npm run typecheck` passes — 03d7e7f
- [x] 1.4 `npm run test` passes — 03d7e7f
- [x] 1.5 `npm run build` passes — 03d7e7f
- [x] 1.6 `npm run db:seed:fetch` exits 0 and writes 1000 pieces to the manifest — 03d7e7f
- [x] 1.7 Every `tags_from_metadata` entry is a member of `ARTWORK_TAGS` — 03d7e7f
- [x] 1.8 Every downloaded filename matches `^[0-9a-f-]{36}\.jpg$` and is a real JPEG — 03d7e7f
- [x] 1.9 `git status` shows no untracked files under the artist asset directory — 03d7e7f

#### Manual

- [x] 1.10 Five pieces spot-checked against their AIC page — 03d7e7f
- [x] 1.11 Metadata-derived tags read as true of the piece — 03d7e7f
- [x] 1.12 Re-running `db:seed:fetch` is a no-op and leaves the manifest byte-identical — 03d7e7f

### Phase 2: Enrichment top-up

#### Automated

- [x] 2.1 `npm run format:check` passes — 2e51f12
- [x] 2.2 `npm run lint` passes — 2e51f12
- [x] 2.3 `npm run typecheck` passes — 2e51f12
- [x] 2.4 `npm run test` passes, including `test/build-corpus.test.ts` — 2e51f12
- [x] 2.5 `npm run build` passes — 2e51f12
- [ ] 2.6 `npm run db:seed:enrich` exits 0; every piece has enrichment or a failure reason
- [x] 2.7 Every `tags_from_enrichment` entry is a style or mood taxonomy term — 2e51f12
- [x] 2.8 No piece's combined tag array exceeds 20 entries — 2e51f12
- [ ] 2.9 Re-running `db:seed:enrich` makes zero model calls and is byte-identical

#### Manual

- [x] 2.10 Five pieces spot-checked: style/mood defensible, description in an artist's register — 2e51f12
- [x] 2.11 Failure count is a small minority — 2e51f12
- [x] 2.12 Observed wall-clock and per-call latency noted against the infrastructure risk — 2e51f12

### Phase 3: Coverage verification and overrides

#### Automated

- [x] 3.1 `npm run format:check` passes — 246d8a4
- [x] 3.2 `npm run lint` passes — 246d8a4
- [x] 3.3 `npm run typecheck` passes — 246d8a4
- [x] 3.4 `npm run test` passes — 246d8a4
- [x] 3.5 `npm run build` passes — 246d8a4
- [x] 3.6 `npm run db:seed:coverage` exits 0 reporting per-facet term coverage — 246d8a4
- [x] 3.7 ~50 pieces (5%) carry `untagged: true` — 246d8a4
- [x] 3.8 No piece carries `tag_overrides` — the override mechanism is not built — 246d8a4

#### Manual

- [x] 3.9 Coverage report reviewed: gaps recorded as findings, not closed — 246d8a4
- [x] 3.10 At least one untagged piece falls in the newest 20 slots — 246d8a4

### Phase 4: seed.sql generation

#### Automated

- [x] 4.1 `npm run format:check` passes
- [x] 4.2 `npm run lint` passes
- [x] 4.3 `npm run typecheck` passes
- [x] 4.4 `npm run test` passes
- [x] 4.5 `npm run build` passes
- [x] 4.6 `db:seed:generate` rewrites only below the marker; identities section untouched
- [x] 4.7 Re-running `db:seed:generate` leaves `seed.sql` byte-identical
- [x] 4.8 `npx supabase db reset` applies the seed with no SQL error
- [x] 4.9 Row counts: 1000 artworks, 8 warm likes, 0 cold, ~50 with `tags = '{}'`
- [x] 4.10 Every `image_path` satisfies `image_path_pattern`
- [x] 4.11 `db:seed:images` uploads every file; storage lists 1000 objects

#### Manual

- [x] 4.12 Warm collector's `/discover` shows real artwork with images rendering
- [x] 4.13 First 20 cards are visibly interleaved across tag groups
- [x] 4.14 Every style term tried in onboarding produces a non-empty starter set
- [x] 4.15 Seeded artist's own work is absent from their deck

### Phase 5: Judgment walkthrough and docs

#### Automated

- [ ] 5.1 `npm run format:check` passes
- [ ] 5.2 `npm run lint` passes
- [ ] 5.3 `npm run typecheck` passes
- [ ] 5.4 `npm run test` passes
- [ ] 5.5 `npm run build` passes
- [ ] 5.6 `judgment.md` exists and cheat-sheet counts sum to the tagged-piece count

#### Manual

- [ ] 5.7 Walk A and Walk B run end to end from the cheat-sheet alone
- [ ] 5.8 Recorded baseline filled in with real observations
- [ ] 5.9 Archived F-01 walkthrough marked superseded within its first screen
