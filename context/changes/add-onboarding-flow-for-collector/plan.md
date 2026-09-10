# Onboarding Flow for Collector — Implementation Plan

## Overview

A brand-new collector currently lands on `/discover` with zero `interactions` rows. The
ranking function shipped in `S-01` derives taste from liked-artwork tags, so a collector
with no likes scores zero against everything and falls back to `created_at desc` — the
"naive fallback" the roadmap predicted. For the audience this change targets (a course
grader evaluating the app in one session) that fallback *is* the product they see.

This plan adds a mandatory, chrome-free first-run flow that ends with the collector
holding real likes, so their first `/discover` deck is genuinely ranked. It writes
ordinary `interactions` rows, so the ranking function consumes the output unmodified.

A second, independent half — first-run orientation for the swipe surface — ships
afterwards as a dismissible hint on the first card.

## Current State Analysis

**Ranking is live and is the right shape.** `swipe_deck` was replaced in
[20260910180000_rank_swipe_deck.sql](supabase/migrations/20260910180000_rank_swipe_deck.sql)
with a four-key sort: untagged last, previously-skipped demoted, tag-overlap against the
collector's own likes descending, `created_at desc` as the floor. Taste is the distinct
union of tags across **liked** artworks only ([:22-32](supabase/migrations/20260910180000_rank_swipe_deck.sql#L22-L32));
skips are a demotion signal and never taste input. Any flow that produces `like` rows
feeds this without touching it.

**Nothing distinguishes a new collector from an established one.** No flag, no counter,
no timestamp check anywhere in `src/` or the migration set. `profiles.created_at` exists
and is granted for select but is never read.

**There is no UI primitive to build a picker from.** No component library is installed;
everything is hand-rolled Tailwind v4. [`Field`](src/components/ui/Field.tsx) supports
input / textarea / file only. There is no multi-step form, stepper, modal, or dialog
anywhere in `src/**/*.tsx`. `TagList` ([ArtCard.tsx:79-92](src/components/artworks/ArtCard.tsx#L79-L92))
is the only tag *display* primitive.

**`profiles` grants are column-scoped in both directions.** Update is
`grant update (display_name, role)` ([20260909160000_add_profile_role.sql:16-18](supabase/migrations/20260909160000_add_profile_role.sql#L16-L18));
select is `grant select (id, display_name, role, created_at, updated_at)`
([20260909160400_public_artist_profiles.sql:15-17](supabase/migrations/20260909160400_public_artist_profiles.sql#L15-L17)).
A new column is invisible and unwritable until both are widened. There is no insert
policy — rows exist only via the `handle_new_user` trigger.

**Two-layer guarding.** The proxy redirect is optimistic; `(app)/layout.tsx`'s
`requireProfile()` is authoritative ([layout.tsx:6-8](<src/app/(app)/layout.tsx#L6-L8>)).
A gate placed only in the proxy is bypassable.

**`EmptyDeck` still misreports exhaustion.** [SwipeDeck.tsx:188-201](src/components/artworks/SwipeDeck.tsx#L188-L201)
claims "You've seen everything in the catalog" when the fixed 20-card snapshot is
decided. The component was recently rewritten to key off `decidedIds` rather than an
ordinal, but the terminal copy was untouched. **This defect belongs to `S-02:
continuous-deck-refill` (status `ready`) and is explicitly out of scope here.**

## Desired End State

A collector who signs up cannot reach any page under `(app)/` until they have completed
onboarding. Onboarding shows the 20 `style` terms, takes 2–4 selections, then serves
starter artworks matching those terms one at a time with the same like/skip verdict the
main deck uses. The flow ends when the collector has liked `ONBOARDING_LIKE_TARGET`
pieces **or** the starter pool is exhausted, whichever comes first; either way
`profiles.onboarded_at` is stamped and they are redirected to `/discover`.

On that first `/discover`, the deck is ordered by tag-match against the likes just
recorded — verifiable by comparing it against the same account's pre-onboarding deck.

Verify by: signing up a fresh account, completing the flow, and confirming (a) direct
navigation to `/discover` mid-flow redirects back, (b) the resulting deck differs from
`created_at desc`, and (c) a collector who skips every starter piece still exits.

### Key Discoveries:

- Ranking consumes liked-artwork tags only — [rank_swipe_deck.sql:22-32](supabase/migrations/20260910180000_rank_swipe_deck.sql#L22-L32)
- `recordInteraction` upserts on `(user_id, artwork_id)` ([interactions.ts:36-43](src/app/actions/interactions.ts#L36-L43)), so re-rating is idempotent and starter pieces are anti-joined out of the later deck automatically
- `TAXONOMY_BY_FACET` is deliberately free of `server-only` ([taxonomy.ts:14-16](src/lib/ai/taxonomy.ts#L14-L16)) — a client picker can import the vocabulary directly with no round trip
- `artworks.tags` has a GIN index, `artworks_tags_idx` ([20260909160100_add_artworks.sql:29](supabase/migrations/20260909160100_add_artworks.sql#L29)) — array-overlap starter selection is indexed
- `becomeArtist` ([profile.ts:37-73](src/app/actions/profile.ts#L37-L73)) is the guided-flow Server Action precedent: `requireProfile()` → early redirect if already in target state → Zod `safeParse` → `fieldErrors` on failure → update → `revalidatePath("/", "layout")` → `redirect`
- The seed corpus already contains `seed-collector-cold@artswipe.local` with zero likes ([judgment.md:12-13](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L12-L13)) — a ready-made fixture
- `swipe_deck` excludes the caller's own artworks (`a.artist_id <> auth.uid()`); starter selection must do the same

## What We're NOT Doing

- **Not fixing `EmptyDeck`.** The false "seen everything" copy is `S-02`'s. Phase 5 must not touch it.
- **Not adding a preference table or a facet column.** The chosen style terms are transient selection input, discarded after the starter set is built. Only `onboarded_at` and the `like` rows persist.
- **Not modifying `swipe_deck` or any ranking behavior.** `S-01` is done and this plan consumes it as-is.
- **Not adding a skip button.** The gate is mandatory by decision; pool exhaustion is the only release other than reaching the like target.
- **Not backfilling existing accounts.** `onboarded_at` is nullable — see Migration Notes for the backfill decision.
- **Not building a general stepper, modal, or dialog abstraction.** Two purpose-built screens, no framework.
- **Not answering PRD Open Question 1** (tag weighting). Unweighted overlap is what ships.

## Implementation Approach

Six phases, ordered so the gate is wired **last among the functional phases**. Wiring a
mandatory `requireOnboarded` into `(app)/layout.tsx` before the flow it gates exists
would lock every account — including the local dev user — out of the entire
authenticated segment with no route to escape. Phases 1–3 build the flow while it is
still reachable only by direct navigation; Phase 4 makes it compulsory.

The flow lives in a new `(onboarding)` route group, a sibling of `(app)` and `(auth)`,
so it renders without the app nav chrome and so its own pages are not subject to the
gate they exist to satisfy.

## Critical Implementation Details

**State sequencing — the gate is a trap door.** `requireOnboarded` must be added to
`src/lib/auth/dal.ts` in Phase 1 but called from nowhere until Phase 4. If Phase 1 also
wires it into `(app)/layout.tsx`, every existing account is locked out for the duration
of Phases 2–3, because `onboarded_at` is null for all of them and the flow that would
stamp it does not exist yet.

**Timing — the deck is a one-shot server fetch.** `/discover` is `force-dynamic` and
`recordInteraction` revalidates only `/liked`. Likes recorded during onboarding take
effect on the *next* page load, which is exactly what the terminal `redirect("/discover")`
produces. No revalidation of `/discover` is needed, and adding one would not help
mid-flow.

**Starvation is a real terminal state, not an edge case.** The exit condition is
`likes >= ONBOARDING_LIKE_TARGET` **OR** starter pool exhausted. A collector who skips
every piece must reach the second branch and be released with `onboarded_at` stamped and
zero likes — landing them on today's newest-first deck, which is the proven-safe
fallback. Treating exhaustion as an error, or re-serving skipped pieces, reintroduces
the lockout.

## Phase 1: Schema and DAL

### Overview

Add the onboarding-completion flag to `profiles`, widen both column grants, regenerate
types, and add the `requireOnboarded` gate helper — defined but not yet called.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<timestamp>_add_profile_onboarded_at.sql`

**Intent**: Record when a collector finished onboarding, so a mandatory gate has a
DB-authoritative signal to read. Nullable rather than a boolean default-false because a
timestamp answers "when" as well as "whether", and null is the natural "not yet".

**Contract**: `alter table public.profiles add column onboarded_at timestamptz`
(nullable, no default). Widen the update grant to
`grant update (display_name, role, onboarded_at) on public.profiles to authenticated`
and the select grant to include `onboarded_at`. Both grants are currently exhaustive
`revoke`-then-`grant` statements — re-issuing the full grant is the established pattern
in this repo, not an additive `grant`.

Note the select grant is table-wide, so `onboarded_at` becomes readable on artist
profiles too. That is an opaque timestamp with no privacy weight, and narrowing it would
require splitting the grant per policy — not worth it. State this in a comment.

#### 2. Generated types

**File**: `src/types/database.ts`

**Intent**: Pick up the new column. **Never hand-edit** — regenerate.

**Contract**: `npm run db:types` (linked). Do not run `npm run db:types:local`.

#### 3. Profile DAL

**File**: `src/lib/auth/dal.ts`

**Intent**: Surface `onboarded_at` on the profile DTO and add the gate helper as a
sibling to `requireArtist`. The helper is defined here but deliberately called from
nowhere until Phase 4.

**Contract**: `UserProfile` gains `onboardedAt: string | null`. `getProfile`'s select
list widens from `display_name, role` to include `onboarded_at`. New export
`requireOnboarded(): Promise<UserProfile>` — calls `requireProfile()`, redirects to the
onboarding entry route when `onboardedAt` is null, otherwise returns the profile. Mirror
`requireArtist`'s shape exactly ([dal.ts:98-106](src/lib/auth/dal.ts#L98-L106)).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against a local reset
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Unit tests pass: `npm run test`
- `src/types/database.ts` contains `onboarded_at` on the `profiles` row type
- Build succeeds: `npm run build`

#### Manual Verification:

- Signing in as an existing account still reaches `/discover` — the gate is defined but not wired, so nothing is locked

**Implementation Note**: After completing this phase and all automated verification
passes, pause here for manual confirmation from the human before proceeding.

---

## Phase 2: Starter selection

### Overview

Build the style-term picker screen and the query that turns a term selection into a
starter artwork set.

### Changes Required:

#### 1. Onboarding constants

**File**: `src/lib/onboarding/config.ts`

**Intent**: One home for the tunable numbers, so the like target and pool size are named
rather than scattered as literals.

**Contract**: Exports `ONBOARDING_FACET = "style"`, `ONBOARDING_TERM_MIN = 2`,
`ONBOARDING_TERM_MAX = 4`, `ONBOARDING_LIKE_TARGET = 5`, `ONBOARDING_POOL_SIZE = 24`.
No `server-only` — the picker is a client component and imports the min/max to drive its
own validation.

#### 2. Starter query

**File**: `src/lib/artworks/queries.ts`

**Intent**: Select the pool of artworks a collector will rate during onboarding, matching
any of their chosen style terms.

**Contract**: New export `getStarterDeck(terms: string[]): Promise<ArtworkWithArtist[]>`.
Filters `artworks` on tag array-overlap against `terms` (PostgREST `overlaps`, which uses
`artworks_tags_idx`), excludes the caller's own pieces the way `swipe_deck` does, excludes
anything the caller has already interacted with, limits to `ONBOARDING_POOL_SIZE`, and
reuses the existing `attachArtists` helper. Runs under RLS like every other read here.

Returning fewer rows than `ONBOARDING_POOL_SIZE` — including zero — is a valid result,
not an error. Phase 3 depends on that.

#### 3. Term picker screen

**File**: `src/app/(onboarding)/onboarding/page.tsx` plus
`src/components/onboarding/StyleTermPicker.tsx`

**Intent**: Ask the collector to pick 2–4 style terms before they see any art, so the
starter set is narrowed by something they stated rather than by recency alone.

**Contract**: Route group `(onboarding)` is a new sibling of `(app)` and `(auth)` with
its own minimal layout — no app nav. The page calls `requireProfile()` (not
`requireOnboarded`, which would loop) and redirects to `/discover` if `onboardedAt` is
already set, mirroring `becomeArtist`'s early-redirect guard.

`StyleTermPicker` is a client component importing `TAXONOMY_BY_FACET.style` directly from
`@/lib/ai/taxonomy`. Chip-style toggle buttons, selection held in client state, submit
disabled outside the 2–4 range. This is the first multi-select in the product; build it
inline rather than extending `Field`, which is input/textarea/file only.

#### 4. Route group layout

**File**: `src/app/(onboarding)/layout.tsx`

**Intent**: A chrome-free shell so the flow reads as a distinct first-run surface.

**Contract**: Calls `requireProfile()` — the segment is authenticated but not
onboarding-gated. Renders children in a centered container with no nav and no sign-out
header.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Unit tests pass: `npm run test`
- New unit test covers `getStarterDeck` returning an empty array without throwing
- Build succeeds: `npm run build`

#### Manual Verification:

- Navigating directly to `/onboarding` renders 20 style chips with no app nav
- Submit is disabled at 0, 1 and 5 selections; enabled at 2, 3 and 4
- An account that has already onboarded is redirected away from `/onboarding`

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Rating loop and completion

### Overview

Serve the starter pool one card at a time, count likes, and end the flow on either exit
condition — stamping `onboarded_at` in both cases.

### Changes Required:

#### 1. Completion Server Action

**File**: `src/app/actions/onboarding.ts`

**Intent**: Stamp `onboarded_at` and hand the collector off to their now-ranked deck.
Separate from `recordInteraction` because the swipe write is already correct and
reusable as-is; this action owns only the terminal transition.

**Contract**: `"use server"`. Export `completeOnboarding(): Promise<never>` — every
export of a `"use server"` module is a public endpoint, so keep the surface to this one
function. Calls `requireProfile()`, returns early via `redirect("/discover")` if
`onboardedAt` is already set (idempotent under a double submit), updates
`profiles.onboarded_at` to `now()`, `revalidatePath("/", "layout")`, then
`redirect("/discover")`.

The like rows are already durable by this point — they were written card-by-card by
`recordInteraction`. This action must not batch or re-write them.

#### 2. Rating loop component

**File**: `src/components/onboarding/StarterDeck.tsx`

**Intent**: Present the starter pool with the same verdict affordances as the main deck,
tracking likes toward the target and releasing on exhaustion.

**Contract**: Client component taking the starter pool and rendering one `ArtCard` at a
time with Like / Skip buttons. Reuses `recordInteraction` for each verdict. Holds decided
ids in client state — follow the `decidedIds` pattern in
[SwipeDeck.tsx:22](src/components/artworks/SwipeDeck.tsx#L22) and `selectNextCard` from
`@/lib/artworks/deck` rather than an ordinal index, for the same reason recorded there.

Calls `completeOnboarding()` when **either** the like count reaches
`ONBOARDING_LIKE_TARGET` **or** the pool is exhausted. Both branches are normal
completion. Shows progress toward the target so the flow does not feel open-ended.

Optimistic advance with rollback on failure, mirroring `SwipeDeck`'s `decide`: a failed
write must not count toward the like target.

#### 3. Wiring the two steps

**File**: `src/app/(onboarding)/onboarding/page.tsx`

**Intent**: Move from term selection to rating without a second route.

**Contract**: The picker's selection drives `getStarterDeck`. Terms are **not**
persisted — they are selection input only, and nothing reads them after the pool is
built. Keep both steps under the one `/onboarding` route.

Handle the zero-result case explicitly: if `getStarterDeck` returns nothing for the
chosen terms, the collector must still be able to finish. Route that straight to
`completeOnboarding()` rather than rendering an empty rating loop.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Unit tests pass: `npm run test`
- New unit test: `completeOnboarding` redirects without re-stamping when `onboardedAt` is already set
- New unit test: exhaustion with zero likes still reaches completion
- Build succeeds: `npm run build`

#### Manual Verification:

- Liking `ONBOARDING_LIKE_TARGET` starter pieces ends the flow and lands on `/discover`
- **Skipping every starter piece also ends the flow** and lands on `/discover` — this is the lockout check
- Choosing terms that match no artworks completes rather than hanging
- The resulting `/discover` deck is visibly ordered by the tags of the pieces just liked, not by recency
- Starter pieces rated during onboarding do not reappear in the `/discover` deck

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Gate wiring

### Overview

Make onboarding compulsory. This is the trap-door phase — it must land only after Phase 3
proves the flow completes.

### Changes Required:

#### 1. Authenticated layout gate

**File**: `src/app/(app)/layout.tsx`

**Intent**: Enforce onboarding at the authoritative guard rather than the optimistic
proxy, so deep links to `/discover` or `/liked` cannot bypass it.

**Contract**: Swap `requireProfile()` for `requireOnboarded()`. The layout's existing use
of `profile.role` and `profile.email` is unaffected — `requireOnboarded` returns the same
`UserProfile`. No change to `src/proxy.ts`: adding a DB read to every request is the cost
the research flagged, and the layout catches what matters.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Unit tests pass: `npm run test`
- New DAL unit test: `requireOnboarded` redirects when `onboardedAt` is null and returns the profile when set
- Build succeeds: `npm run build`

#### Manual Verification:

- A fresh account navigating directly to `/discover` is redirected to `/onboarding`
- The same holds for `/liked`, `/account` and `/studio`
- `/onboarding` itself remains reachable — no redirect loop
- An account that completed onboarding in Phase 3 reaches `/discover` normally
- Signing out and back in does not re-trigger onboarding

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 5: First-run orientation

### Overview

The second, independent half: teach the swipe affordances on first contact with the real
deck. Depends on no ranking and stores no preference.

### Changes Required:

#### 1. Inline first-run hint

**File**: `src/components/artworks/SwipeDeck.tsx`

**Intent**: Make drag / buttons / arrow keys discoverable on the collector's first real
card, then get out of the way permanently.

**Contract**: A dismissible affordance rendered over or beside the top card, shown only
on first contact. `SwipeDeck` already carries static instructional copy at
[:175-177](src/components/artworks/SwipeDeck.tsx#L175-L177) — fold that into the hint
rather than adding a second explanation alongside it.

Dismissal is a per-viewer convenience, not durable state: keep it in `localStorage`,
wrapped in try/catch, and render correctly when the read throws or returns nothing. It
does **not** belong on `profiles` — `onboarded_at` answers a different question and
overloading it would make the gate depend on a UI dismissal.

**Do not touch `EmptyDeck`** ([:188-201](src/components/artworks/SwipeDeck.tsx#L188-L201)).
Its false "seen everything" copy is `S-02: continuous-deck-refill`'s to fix, and editing
it here means solving the same defect twice.

The PRD guardrail at [prd-v2.md:62](context/foundation/prd-v2.md#L62) — "Liking, the
liked-artworks view, and the swipe interaction itself remain intact and functional" —
constrains *how* this may modify `SwipeDeck`. The verdict path, the optimistic advance,
and the keyboard handler must all survive unchanged.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Unit tests pass: `npm run test`
- Existing `test/lib/deck.test.ts` still passes unmodified — card selection is untouched
- Build succeeds: `npm run build`

#### Manual Verification:

- The hint appears on the first card after onboarding and not on subsequent cards
- Dismissing it persists across a page reload
- With site data cleared the hint returns, and nothing throws in a private window
- Drag, buttons and arrow keys all still register verdicts with the hint on screen
- `EmptyDeck` copy is byte-identical to before this phase

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 6: Decision record

### Overview

Three foundation documents make claims this change falsifies. Amending them is part of
the change, not follow-up — the frame brief for this very change exists because a stale
decision record caused exactly this class of rework.

### Changes Required:

#### 1. PRD Non-Goal carve-out

**File**: `context/foundation/prd-v2.md`

**Intent**: The style-term picker is a collector-facing control over ranking, exercised
once at first run. Record it as a deliberate exception rather than leaving a flat
contradiction with shipped behavior.

**Contract**: Amend the Non-Goal at [:131](context/foundation/prd-v2.md#L131) to carve
out first-run term selection, stating that the choice is transient (never persisted, used
only to select starter artworks) and that ongoing tuning, filters and "more like this"
remain out of scope. Also reconcile [:111](context/foundation/prd-v2.md#L111) ("Every
collector begins with no learned taste") and [:114](context/foundation/prd-v2.md#L114)
("existing unranked ordering… becomes the cold-start path") — the first is now false by
design, the second survives as the exhaustion-release fallback. FR-003
([:87](context/foundation/prd-v2.md#L87)) needs no change: preferences still come only
from the collector's own likes.

#### 2. Roadmap

**File**: `context/foundation/roadmap.md`

**Intent**: `S-03: cold-start-and-untagged-placement` is `blocked` on Open Question 2
("how many likes switch ranking on?"). This change dissolves that question rather than
answering it — every collector now arrives with signal.

**Contract**: Record the dissolution against `S-03` and Open Question 2, note
`ONBOARDING_LIKE_TARGET` as the number that replaces the threshold, and update `S-03`'s
status accordingly. Add this change to the At-a-glance table and Backlog Handoff.

#### 3. Ranking eval baseline

**File**: `context/archive/2026-09-10-ranking-eval-corpus/judgment.md`

**Intent**: Walk B records "the cold-start deck should stay newest-first and **not
change**… If S-01 alters this deck, that is a cold-start regression"
([:52-54](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L52-L54)). That
expectation was written to catch an S-01 bug and is still correct *for S-01*. This change
deliberately invalidates its premise by ensuring the cold collector no longer exists
post-onboarding.

**Contract**: Annotate Walk B in place — do not delete it. State that the expectation
held for S-01 and remains the correct check for that slice, and that as of this change
`seed-collector-cold@artswipe.local` reaches `/discover` only after onboarding has given
it likes. Note explicitly that the fixture is still reachable pre-onboarding for anyone
re-running the S-01 walk.

This file lives under `context/archive/`. Editing archived *content* is fine; this is not
an attempt to re-open the archived change.

### Success Criteria:

#### Automated Verification:

- Formatting is clean: `npm run format:check`
- No source changes in this phase — `npm run test` and `npm run build` still pass

#### Manual Verification:

- `prd-v2.md` no longer contradicts shipped behavior on any of the three cited lines
- `roadmap.md` states what replaced Open Question 2 and why
- Walk B in `judgment.md` is annotated, not deleted, and still usable for an S-01 re-run

**Implementation Note**: This is the final phase. Pause for manual confirmation, then run
the epilogue commit.

---

## Testing Strategy

### Unit Tests (`npm run test` — the CI lane):

- `getStarterDeck` returns `[]` without throwing when no artwork matches the terms
- `completeOnboarding` redirects without re-stamping when `onboardedAt` is already set
- `completeOnboarding` rejects an unauthenticated caller
- `requireOnboarded` redirects on null `onboardedAt`, returns the profile otherwise
- Zod gate on the term selection: rejects fewer than 2, more than 4, and terms outside `TAXONOMY_BY_FACET.style`
- Exhaustion with zero likes reaches completion rather than erroring

Supabase and `next/*` are mocked in this lane. Share fixtures into `vi.mock` factories via
`vi.hoisted`, not module-level consts.

### Integration Tests (`npm run test:integration` — local only, opt-in):

- The new column grants actually permit an `onboarded_at` update under RLS as a plain
  authenticated user, and still forbid writing `email`
- `getStarterDeck` respects RLS and excludes the caller's own artworks

Mint **one test user per file** — `sign_in_sign_ups` is rate-limited to 30 per 5 minutes
per IP. No service-role key.

### Manual Testing Steps:

1. Reset local, sign up a brand-new account, confirm the redirect to `/onboarding`
2. Try to reach `/discover`, `/liked` and `/account` directly mid-flow — all redirect back
3. Pick 2 style terms, like 5 pieces, confirm the handoff to `/discover`
4. Compare that deck against a pre-onboarding deck for the same corpus — ordering must differ
5. Repeat with a fresh account, **skipping every starter piece** — confirm release and a newest-first deck
6. Repeat with terms matching nothing — confirm completion rather than a hang
7. Confirm the orientation hint shows once, dismisses, and stays dismissed across reload
8. Sign out and back in — onboarding must not re-trigger

## Performance Considerations

`getStarterDeck` filters on tag array-overlap, which uses the existing `artworks_tags_idx`
GIN index — the same access path the ranking function relies on. The pool is capped at
`ONBOARDING_POOL_SIZE`, so the flow is one bounded query plus one `interactions` upsert
per verdict, matching the main deck's per-swipe cost exactly.

The gate adds no new query: `getProfile` is already called by `(app)/layout.tsx` on every
authenticated page, is `cache()`-wrapped for the render pass, and this change only widens
its select list by one column.

## Migration Notes

`onboarded_at` is nullable with no default, so **every existing account is treated as
not-onboarded** and will be routed through the flow on next sign-in. With one real user
and a seed corpus this is the desired behavior — the local dev account and
`seed-collector-cold@artswipe.local` both *should* see the flow.

If that turns out to be unwanted for a specific account, stamp it directly rather than
adding a backfill to the migration: a blanket backfill would permanently exclude exactly
the accounts this change exists to serve.

The migration is additive and reversible — dropping the column and restoring the two
prior grant statements returns the schema to its current state. Pushing to `main`
auto-deploys it via `.github/workflows/migrations.yml`; never edit it after it applies.

## References

- Frame brief: `context/changes/add-onboarding-flow-for-collector/frame.md` — **note its D3 hypothesis is stale**; it was written at `85270a0`, before `S-01` merged in PR #14
- Related research: `context/changes/add-onboarding-flow-for-collector/research.md`
- Ranking this plan consumes unmodified: [20260910180000_rank_swipe_deck.sql](supabase/migrations/20260910180000_rank_swipe_deck.sql)
- Guided-flow Server Action precedent: [src/app/actions/profile.ts:37-73](src/app/actions/profile.ts#L37-L73)
- Gate precedent: [src/lib/auth/dal.ts:98-106](src/lib/auth/dal.ts#L98-L106)
- Card-selection pattern to reuse: [src/components/artworks/SwipeDeck.tsx:22-30](src/components/artworks/SwipeDeck.tsx#L22-L30)
- Out-of-scope defect owner: [roadmap.md:112-122](context/foundation/roadmap.md#L112-L122) (`S-02`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and DAL

#### Automated

- [x] 1.1 Migration applies cleanly against a local reset — ef83e6d
- [x] 1.2 Type checking passes: `npm run typecheck` — ef83e6d
- [x] 1.3 Linting passes: `npm run lint` — ef83e6d
- [x] 1.4 Formatting is clean: `npm run format:check` — ef83e6d
- [x] 1.5 Unit tests pass: `npm run test` — ef83e6d
- [x] 1.6 `src/types/database.ts` contains `onboarded_at` on the `profiles` row type — ef83e6d
- [x] 1.7 Build succeeds: `npm run build` — ef83e6d

#### Manual

- [x] 1.8 Signing in as an existing account still reaches `/discover` — the gate is defined but not wired — ef83e6d

### Phase 2: Starter selection

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck`
- [x] 2.2 Linting passes: `npm run lint`
- [x] 2.3 Formatting is clean: `npm run format:check`
- [x] 2.4 Unit tests pass: `npm run test`
- [x] 2.5 New unit test covers `getStarterDeck` returning an empty array without throwing
- [x] 2.6 Build succeeds: `npm run build`

#### Manual

- [x] 2.7 Navigating directly to `/onboarding` renders 20 style chips with no app nav
- [x] 2.8 Submit is disabled at 0, 1 and 5 selections; enabled at 2, 3 and 4
- [x] 2.9 An account that has already onboarded is redirected away from `/onboarding`

### Phase 3: Rating loop and completion

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Formatting is clean: `npm run format:check`
- [ ] 3.4 Unit tests pass: `npm run test`
- [ ] 3.5 New unit test: `completeOnboarding` redirects without re-stamping when `onboardedAt` is already set
- [ ] 3.6 New unit test: exhaustion with zero likes still reaches completion
- [ ] 3.7 Build succeeds: `npm run build`

#### Manual

- [ ] 3.8 Liking `ONBOARDING_LIKE_TARGET` starter pieces ends the flow and lands on `/discover`
- [ ] 3.9 Skipping every starter piece also ends the flow and lands on `/discover`
- [ ] 3.10 Choosing terms that match no artworks completes rather than hanging
- [ ] 3.11 The resulting `/discover` deck is visibly ordered by the tags of the pieces just liked
- [ ] 3.12 Starter pieces rated during onboarding do not reappear in the `/discover` deck

### Phase 4: Gate wiring

#### Automated

- [ ] 4.1 Type checking passes: `npm run typecheck`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Formatting is clean: `npm run format:check`
- [ ] 4.4 Unit tests pass: `npm run test`
- [ ] 4.5 New DAL unit test: `requireOnboarded` redirects when `onboardedAt` is null and returns the profile when set
- [ ] 4.6 Build succeeds: `npm run build`

#### Manual

- [ ] 4.7 A fresh account navigating directly to `/discover` is redirected to `/onboarding`
- [ ] 4.8 The same holds for `/liked`, `/account` and `/studio`
- [ ] 4.9 `/onboarding` itself remains reachable — no redirect loop
- [ ] 4.10 An account that completed onboarding in Phase 3 reaches `/discover` normally
- [ ] 4.11 Signing out and back in does not re-trigger onboarding

### Phase 5: First-run orientation

#### Automated

- [ ] 5.1 Type checking passes: `npm run typecheck`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 Formatting is clean: `npm run format:check`
- [ ] 5.4 Unit tests pass: `npm run test`
- [ ] 5.5 Existing `test/lib/deck.test.ts` still passes unmodified
- [ ] 5.6 Build succeeds: `npm run build`

#### Manual

- [ ] 5.7 The hint appears on the first card after onboarding and not on subsequent cards
- [ ] 5.8 Dismissing it persists across a page reload
- [ ] 5.9 With site data cleared the hint returns, and nothing throws in a private window
- [ ] 5.10 Drag, buttons and arrow keys all still register verdicts with the hint on screen
- [ ] 5.11 `EmptyDeck` copy is byte-identical to before this phase

### Phase 6: Decision record

#### Automated

- [ ] 6.1 Formatting is clean: `npm run format:check`
- [ ] 6.2 No source changes — `npm run test` and `npm run build` still pass

#### Manual

- [ ] 6.3 `prd-v2.md` no longer contradicts shipped behavior on any of the three cited lines
- [ ] 6.4 `roadmap.md` states what replaced Open Question 2 and why
- [ ] 6.5 Walk B in `judgment.md` is annotated, not deleted, and still usable for an S-01 re-run
