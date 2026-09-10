# Personalized Deck Ranking Implementation Plan

## Overview

Replace `swipe_deck`'s unconditional newest-first ordering with a per-collector ordering
driven by tag overlap against the artworks that collector has liked, and narrow its
exclusion predicate so previously-skipped pieces return, demoted, instead of disappearing
forever.

This is roadmap slice **S-01**, the north star: every other slice on the recommendation
roadmap only matters if this one works.

## Current State Analysis

`swipe_deck` is defined exactly once
([`supabase/migrations/20260909160200_add_interactions.sql:50-68`](../../../supabase/migrations/20260909160200_add_interactions.sql)) and does two things this
plan changes:

- **Orders by recency only** — `order by a.created_at desc` (`:66`). Every collector is
  served the same sequence regardless of what they have liked.
- **Excludes on any interaction** — the anti-join at `:60-65` fires on a row with either
  action, so a piece the collector merely skipped is gone permanently.

Everything else about the function is correct and must survive: `security invoker` so RLS
stays in force, `set search_path = ''`, the `a.artist_id <> auth.uid()` self-exclusion, and
the `least(greatest(p_limit, 1), 50)` clamp.

Verified state of the surrounding system:

- **No ranking exists anywhere.** Confirmed across `main` and all 13 local/remote branches;
  the only `rank` identifier in `src/` is an unrelated sort-order map at
  [`queries.ts:116`](../../../src/lib/artworks/queries.ts).
- **The TypeScript layer needs no change.** [`getSwipeDeck`](../../../src/lib/artworks/queries.ts)
  calls the RPC and hydrates artists; holding the signature means `src/types/database.ts`
  is unaffected.
- **The evaluation corpus is already seeded.** 54 artworks — 48 tagged in four clusters of
  twelve, six untagged — with `created_at` staggered round-robin so a broken ranking cannot
  masquerade as a working one. `oil` is shared between two clusters on purpose, giving one
  partial-match case to discriminate.
- **A pre-S-01 baseline is recorded.** The warm collector's first ~18 cards contained
  cluster 1 exactly once despite all eight of their likes being cluster 1
  ([`judgment.md`](../../archive/2026-09-10-ranking-eval-corpus/judgment.md)).
- **CI cannot test this.** The default lane mocks Supabase; ordering is only observable
  against real Postgres in the opt-in integration lane.

### Key Discoveries:

- The seed corpus tags are **free text, not taxonomy terms** (`{abstract,blue,geometric,minimal}` —
  `blue` and `minimal` are not in `src/lib/ai/taxonomy.ts`). Matching must be plain array
  overlap on raw text, taxonomy-agnostic.
- `test/integration/helpers.ts` mints **artists only** (`createTestArtist` promotes the user).
  A deck test needs a collector, and `swipe_deck` excludes the caller's own artworks, so a
  deck spec requires at least two users in one file.
- The lane's rate-limit note (`sign_in_sign_ups = 30` per 5 min) permits a handful of users
  per file — "one per file" is guidance against per-test signup, not a hard cap of one.
- `create or replace function` preserves existing privileges, so the `revoke ... from public,
  anon` / `grant execute ... to authenticated` pair at `:70-71` does not need repeating.

## Desired End State

A collector who has liked several pieces is served their next cards ordered by how well each
piece's tags overlap the tags on the pieces they liked. Pieces they previously skipped return
below all fresh matches. Untagged pieces sit at the very bottom. Liked pieces never return.

Verified by: the judgment walkthrough showing Blue-abstraction pieces concentrated at the
front for the warm collector (against a recorded baseline where cluster 1 appeared once in
18 cards), and an integration suite asserting each ordering rule against real Postgres.

## What We're NOT Doing

- **No like-count threshold.** PRD Open Question 2 stays open and keeps blocking S-03. A
  collector with no likes scores zero against everything and lands on the recency floor —
  that fallback is a consequence of the ordering, not a designed cold-start path.
- **No tag weighting.** PRD Open Question 1 stays open: taste is a distinct set, every tag
  counts once, no rarity or frequency weighting.
- **No changes to the client.** `SwipeDeck.tsx` and `getSwipeDeck` are untouched. The deck
  stays a fixed one-shot fetch; continuous refill is S-02.
- **No changes to what is stored.** No schema change, no new table, no new column. Skips
  continue to be written as they are today and are used only for demotion, never as taste
  input.
- **No explanation surfaced to the collector.** No score, no "because you liked X" — a
  standing PRD Non-Goal.
- **No backfill of tags** onto pre-enrichment artworks.

## Implementation Approach

The whole change is one `create or replace function` in a new migration. Ranking stays in
SQL rather than moving to TypeScript for three reasons: the RPC contract and its `p_limit`
clamp stay intact, RLS continues to be enforced by the same `security invoker` boundary, and
scoring in the database avoids pulling the catalogue into Node to sort it.

The ordering is a four-key sort:

1. **Tagged before untagged** — outermost, so untagged pieces sink below everything.
2. **Unseen before previously-skipped** — the demotion tier.
3. **Tag overlap, descending** — the actual ranking.
4. **`created_at desc`** — the floor, preserving today's behavior wherever scores tie.

Taste is one aggregate: the distinct union of tags across the collector's liked artworks.

## Critical Implementation Details

**The skip tier must not be expressed as a bare boolean cast.** The interactions row is
`left join`ed, so for an unseen artwork `i.action` is null and `(i.action = 'skip')::int`
evaluates to null — which sorts *last* under `ASC`, placing unseen pieces below skipped ones
and inverting the tier. Use a null-safe form (`coalesce(..., 0)`, or a `case` on `i.id is
null`). This is the single most likely way to ship an ordering that looks plausible and is
backwards.

**Scoring reads every candidate row.** The GIN index on `tags` accelerates containment, not
overlap counting, and the plan deliberately serves zero-overlap pieces rather than filtering
them out — so a prefilter on `&&` is not available. A sequential scan over the catalogue is
accepted at current scale (54 seeded rows, a handful live). Revisit only if the catalogue
grows by orders of magnitude.

## Phase 1: Ranked deck function

### Overview

Rewrite `swipe_deck` in a new migration: add the taste aggregate, the four-key ordering, and
the narrowed exclusion predicate. Nothing outside this one function changes.

### Changes Required:

#### 1. New migration

**File**: `supabase/migrations/<timestamp>_rank_swipe_deck.sql` (timestamp must sort after
`20260910101500`)

**Intent**: Replace the function body so the deck is ordered per collector by tag overlap
against their own likes, with skipped pieces demoted and untagged pieces last, and so the
exclusion fires only on likes. Never edit the original migration — this is a new file that
replaces the function.

**Contract**: Signature, volatility, and security context are unchanged —
`public.swipe_deck(p_limit int default 20) returns setof public.artworks`, `language sql`,
`stable`, `security invoker`, `set search_path = ''`. All object references stay
fully-qualified because `search_path` is empty. Grants are preserved by `create or replace`
and need not be repeated.

The ordering contract, which Phase 2 asserts against:

```sql
order by
  (cardinality(a.tags) = 0)::int,              -- tagged first, untagged last
  coalesce((i.action = 'skip')::int, 0),       -- unseen first, skipped after (null-safe!)
  (select count(*) from unnest(a.tags) tg
     where tg = any(taste.tags)) desc,          -- tag overlap
  a.created_at desc                             -- recency floor
```

Taste is the distinct union of tags over liked artworks, coalesced to `'{}'` so a collector
with no likes yields an empty array rather than null (an empty array scores every piece 0;
a null would make every comparison null). The exclusion predicate narrows to
`action = 'like'`; the same-user `left join` on `interactions` supplies the skip tier.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npm run format:check`
- Linting passes: `npm run lint`
- Type checking passes: `npm run typecheck`
- Default test suite passes: `npm run test`
- Production build succeeds: `npm run build`
- `src/types/database.ts` is unchanged — the RPC signature did not move, so no regeneration is needed

#### Manual Verification:

- Migration applies cleanly on a fresh local stack: `npx supabase db reset`
- `\df+ public.swipe_deck` in `npx supabase db psql` confirms `security invoker` and the empty `search_path` survived the replace
- Function grants still show execute for `authenticated` only, not `anon` or `public`

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful
before proceeding to the next phase.

---

## Phase 2: Real-boundary proof

### Overview

Prove each ordering rule against real Postgres, under real RLS. This is the only lane that
can assert any of it — and it is not run by CI, which the plan states plainly rather than
implying coverage that does not exist.

### Changes Required:

#### 1. Collector fixture

**File**: `test/integration/helpers.ts`

**Intent**: Add a collector counterpart to `createTestArtist`. A collector is simply a
signed-up user left at the default `role`, which is what makes it distinct — it must not be
promoted, because `swipe_deck` excludes the caller's own artworks and the deck is a
collector-side view.

**Contract**: `createTestCollector(stack: LocalStack): Promise<TestCollector>` returning at
least `{ client, userId, cleanup }`, mirroring the existing artist helper's construction
(anonymous client, in-memory session, `signUp` returning a live session because local
confirmations are disabled). `cleanup` deletes the user's own `interactions` rows — RLS
already scopes the delete — and signs out.

#### 2. Deck ordering spec

**File**: `test/integration/swipe-deck.int.ts`

**Intent**: Assert the four ordering rules and the FR-006 guarantee against a fixture
catalogue with known tags, so a regression in the sort key fails loudly instead of returning
a plausible-looking deck.

**Contract**: One artist and two collectors minted in `beforeAll` (well inside the lane's
signup rate limit). The artist uploads `TINY_PNG` once and reuses that key across every
fixture artwork — the same approach `supabase/seed.sql` takes — then inserts artworks with
controlled `tags` and explicit staggered `created_at`.

A fixture set sufficient to separate all four keys: a liked piece establishing taste, two
unseen pieces with different overlap against it, an unseen zero-overlap piece, an unseen
untagged piece, and one piece the collector skips.

Assertions:

- A liked artwork never appears in the deck (**FR-006** — the roadmap's named break risk)
- A skipped artwork does appear, and after every unseen tagged piece
- Among unseen tagged pieces, higher tag overlap sorts first
- The untagged piece sorts last, below the skipped piece
- A collector with no likes receives tagged pieces newest-first, with untagged last

**Note on an assumption to verify first**: these tests set `created_at` explicitly on insert.
Nothing in the schema or RLS forbids it and `seed.sql` does the same, but confirm a
client-side insert honours the supplied value rather than the `now()` default before building
the ordering assertions on it. If it does not, stagger inserts and assert relative order
instead.

### Success Criteria:

#### Automated Verification:

- Integration lane passes: `npm run test:integration`
- Default suite and full gate still pass: `npm run test`, `npm run lint`, `npm run typecheck`, `npm run format:check`
- The new spec fails when the skip-tier expression is made non-null-safe — observe this deliberately before treating the suite as meaningful

#### Manual Verification:

- Local stack is running and `.env.test.local` points at loopback (the lane refuses otherwise)
- The spec's failure output names which ordering rule broke, not just an index mismatch

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful
before proceeding to the next phase.

---

## Phase 3: Judgment walk and decision record

### Overview

Run the human judgment the corpus was built for, record the post-S-01 reading, and reconcile
the decision record — including the archived Walk B expectation this change deliberately
invalidates.

### Changes Required:

#### 1. Post-S-01 judgment reading

**File**: `context/changes/personalized-deck-ranking/judgment-post-s01.md`

**Intent**: Record Walk A and Walk B exactly as the archived procedure prescribes, so the
before/after comparison is evidence rather than recollection.

**Contract**: Same cluster-code format as the recorded baseline (1 = Blue abstraction,
2 = Warm portraiture, 3 = Muted landscape, 4 = Neon street, U = untagged), the first ~20
cards per walk, the date and commit, and an explicit verdict on whether Blue abstraction
concentrated at the front for the warm collector versus appearing once in 18 cards before.

#### 2. Amend the archived Walk B expectation

**File**: `context/archive/2026-09-10-ranking-eval-corpus/judgment.md`

**Intent**: Walk B currently states the cold-start deck must not change, and calls any change
a regression. Explicit untagged demotion changes it by design, so the expectation is amended
to "newest-first among tagged pieces, untagged tail" — otherwise the next person to run the
walk reads correct behavior as a regression.

**Contract**: A dated annotation naming this change as the cause, not a silent rewrite. The
recorded baseline measurements themselves stay untouched — only the forward-looking
expectation changes.

#### 3. Reconcile the roadmap

**File**: `context/foundation/roadmap.md`

**Intent**: Record that Open Question 4 is answered, so S-03's remaining blocker is visible
as the like-threshold alone. Also correct the stale Backlog Handoff row that still says S-01
needs F-01 first — F-01 is done.

**Contract**: Update Open Roadmap Question 4 to resolved with the decision and its rationale;
narrow S-03's Unknowns to OQ-2; set S-01's status; fix the Backlog Handoff row.

### Success Criteria:

#### Automated Verification:

- Formatting passes: `npm run format:check`
- Full gate passes: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`

#### Manual Verification:

- Walk A shows Blue abstraction concentrated at the front of the warm collector's deck
- The four unliked Blue-abstraction pieces lead the warm collector's deck
- `oil`-sharing pieces from Warm portraiture / Muted landscape rank above unrelated clusters as a partial match
- No previously-liked piece appears in either walk
- Walk B shows tagged pieces newest-first with untagged at the tail, matching the amended expectation
- The roadmap no longer lists Open Question 4 as blocking S-03

---

## Testing Strategy

### Unit Tests:

Nothing to add. The change is entirely inside a Postgres function; the default lane mocks
Supabase, so a unit test here would assert the mock rather than the ordering. Existing
`test/actions/interactions.test.ts` continues to cover the write path unchanged.

### Integration Tests:

`test/integration/swipe-deck.int.ts` carries every ordering assertion, listed in Phase 2.

**This lane does not run in CI.** `.github/workflows/verify.yml` runs the default gate only,
so a green CI badge on this change says nothing about whether the ranking works. Running
`npm run test:integration` locally is a required step of Phase 2, not an optional extra.

### Manual Testing Steps:

1. Reset the local stack and re-upload the seed images per `supabase/seed-assets/README.md`.
2. Sign in as `seed-collector-warm@artswipe.local` / `seedpassword`, open `/discover`, do not swipe, and record the first 20 cluster codes.
3. Compare against the recorded pre-S-01 baseline: `4, 2, 4, 2, 4, 2, U, 3, 1, 3, 2, 3, U, 3, 4, U, 4, 2`.
4. Sign in as `seed-collector-cold@artswipe.local` and record Walk B the same way.
5. Confirm no piece from the warm collector's eight likes (`b…01`–`b…08`) appears.

## Performance Considerations

Scoring reads every candidate row rather than using the GIN index, because zero-overlap
pieces must still be served. At the current catalogue size this is irrelevant. The clamp
`least(greatest(p_limit, 1), 50)` bounds the result set, but not the scan — if the catalogue
ever reaches a scale where that matters, the fix is a prefiltered union (indexed overlap
candidates first, unranked remainder appended), not an index on the current shape.

## Migration Notes

No data migration and no schema change — one `create or replace function` in a new file.
Rollback is a further migration restoring the previous body, which remains readable in
`20260909160200_add_interactions.sql`. Migrations auto-deploy on merge to `main` via
`.github/workflows/migrations.yml`, so the deployed function changes as soon as this lands.

Behavior changes for existing users on deploy: previously-skipped artworks become visible
again (demoted), and untagged artworks move to the bottom of every deck.

## References

- Frame brief: `context/changes/add-onboarding-flow-for-collector/frame.md` — establishes why this slice precedes onboarding work
- Roadmap slice: `context/foundation/roadmap.md` § S-01
- Recorded baseline: `context/archive/2026-09-10-ranking-eval-corpus/judgment.md`
- Current function: `supabase/migrations/20260909160200_add_interactions.sql:50-68`
- Deck query wrapper: `src/lib/artworks/queries.ts:53-64`
- Lane rails: `test/integration/setup.ts`, `test/integration/helpers.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Ranked deck function

#### Automated

- [x] 1.1 Formatting passes: `npm run format:check` — 183d9f6
- [x] 1.2 Linting passes: `npm run lint` — 183d9f6
- [x] 1.3 Type checking passes: `npm run typecheck` — 183d9f6
- [x] 1.4 Default test suite passes: `npm run test` — 183d9f6
- [x] 1.5 Production build succeeds: `npm run build` — 183d9f6
- [x] 1.6 `src/types/database.ts` is unchanged — 183d9f6

#### Manual

- [x] 1.7 Migration applies cleanly on a fresh local stack — 183d9f6
- [x] 1.8 `security invoker` and empty `search_path` survived the replace — 183d9f6
- [x] 1.9 Execute grants still limited to `authenticated` — 183d9f6

### Phase 2: Real-boundary proof

#### Automated

- [x] 2.1 Integration lane passes: `npm run test:integration` — fd9f9d9
- [x] 2.2 Default gate still passes: test, lint, typecheck, format:check — fd9f9d9
- [x] 2.3 Spec observed failing when the skip-tier expression is made non-null-safe — fd9f9d9

#### Manual

- [x] 2.4 Local stack running and `.env.test.local` points at loopback — fd9f9d9
- [x] 2.5 Failure output names the broken ordering rule — fd9f9d9

### Phase 3: Judgment walk and decision record

#### Automated

- [x] 3.1 Formatting passes: `npm run format:check` — b7f8100
- [x] 3.2 Full gate passes: lint, typecheck, test, build — b7f8100

#### Manual

- [x] 3.3 Walk A shows Blue abstraction concentrated at the front — b7f8100
- [x] 3.4 The four unliked Blue-abstraction pieces lead the warm deck — b7f8100
- [x] 3.5 `oil`-sharing pieces rank above unrelated clusters — b7f8100
- [x] 3.6 No previously-liked piece appears in either walk — b7f8100
- [x] 3.7 Walk B matches the amended expectation — b7f8100
- [x] 3.8 Roadmap no longer lists Open Question 4 as blocking S-03 — b7f8100
