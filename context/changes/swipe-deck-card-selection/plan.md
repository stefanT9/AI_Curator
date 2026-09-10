# Swipe deck picks the next card by artwork id — Implementation Plan

## Overview

`SwipeDeck` holds an ordinal `index` in client state and renders `deck[index]` from a
prop that can be replaced underneath it. When a Server Action writes a session cookie,
Next re-renders `/discover` (which is `force-dynamic`), `getSwipeDeck()` re-runs, and a
freshly ranked array arrives while `index` keeps counting against the old one — landing
the collector on a card they never swiped to.

This change keys the client's position to **artwork id** instead of ordinal: track the
set of ids decided this session, and render the first artwork in `deck` whose id is not
in that set. A re-ranked deck then simply reorders the cards the collector has not yet
seen, which is correct and is what S-02 will want anyway.

The selection rule moves into a pure helper under `src/lib/` so it can be regression-tested
in the existing default lane — the repo has no DOM test lane, and adding one is a bigger
decision than this fix should make.

## Current State Analysis

`src/components/artworks/SwipeDeck.tsx` has **three ordinal readers** over one piece of
state:

| Line | Reader | Breaks how |
| --- | --- | --- |
| `:17`, `:25` | `const [index, setIndex] = useState(0)` / `deck[index]` | Renders an unrelated card once `deck` is replaced. |
| `:33`, `:39` | `setIndex(prev + 1)` / `setIndex(prev - 1)` on failure | The rollback un-advances *whichever card is current*, not the one that failed — already wrong with two swipes in flight, independent of prop churn. |
| `:152` | `` `${deck.length - index} left` `` | Second derivation of the same position; drifts from the rendered card on any refetch. |

The causal chain, verified against the code and the bundled docs:

1. `recordInteraction` calls `await createClient()` — `src/app/actions/interactions.ts:32`.
2. That factory writes cookies via `cookieStore.set` whenever Supabase rotates the
   session — `src/utils/supabase/server.ts:16-26`.
3. `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510` —
   "When you set or delete a cookie in a Server Action, Next.js re-renders the current
   page and its layouts on the server"; `:512` — "Client state is preserved for
   re-rendered components."
4. `/discover` is `force-dynamic` — `src/app/(app)/discover/page.tsx:12` — so the
   re-render re-runs `getSwipeDeck()` and hands `SwipeDeck` a new array.

**S-01 made this visible rather than causing it.** The old `swipe_deck` anti-joined on
*any* interaction row, so a refetched deck was roughly "everything left" and a stale index
mostly looked like an extra skipped card. S-01's demotion tier keeps skipped pieces **in**
the array, lower down, so a stale index can now resurface a piece the collector already
passed on.

That same demotion tier is why an id set is load-bearing beyond the stale-index bug: on
any refetch, a piece the collector just skipped is still present in `deck` — the server may
not have seen the write yet, and once it has, a skip only demotes. No ordinal scheme can
express "not this session"; only an id set can.

**Testing constraint.** `vitest.config.mts:17` is Node-only ("No jsdom; component tests
would need their own environment") and neither jsdom nor testing-library is a dependency.
A component test is not possible without standing up a fourth lane. `src/lib/artworks/tags.ts`
and `src/lib/artworks/upload.ts` establish the precedent for a pure, browser-importable
module under `src/lib/` that the default lane can import directly.

## Desired End State

A collector swiping through `/discover` never sees a card they did not swipe to, even when
the `deck` prop is replaced mid-session. A re-ranked deck reorders the cards ahead of them;
it does not move them. A piece they skipped this session does not come back this session,
even though `swipe_deck` now returns it in the demotion tier. A failed write returns that
specific card, not whichever card happens to be current.

Verified by: the Phase 1 probe sequence, re-run in Phase 3, producing the correct next card
instead of an unrelated one; and by `test/lib/deck.test.ts` passing in the default CI lane.

### Key Discoveries:

- The defect has three call sites, not one — `SwipeDeck.tsx:25`, `:33`/`:39`, and `:152`.
  Fixing only the rendered card leaves the counter lying.
- The failure rollback at `SwipeDeck.tsx:39` is *already* incorrect under concurrent
  in-flight swipes. Deleting an id from a set fixes that as a side effect.
- The keydown effect at `SwipeDeck.tsx:47-62` depends on the `current` **object**, whose
  identity changes on every refetch even when it is the same artwork. It should key off
  `current.id`.
- `src/lib/artworks/tags.ts` has no `import "server-only"` — a pure sibling module is the
  established shape here, and `src/lib/artworks/queries.ts` (which *is* `server-only`) must
  not be where this lands.
- `test/lib/top-up.test.ts` sets the default-lane test idiom for `src/lib` helpers.

## What We're NOT Doing

- **No deck refill, cursor, or pagination.** That is S-02 `continuous-deck-refill`. This
  change is deliberately scoped smaller and must stay that way.
- **No change to `swipe_deck`**, `getSwipeDeck`, or any migration. The server side is correct;
  the client's reading of it is not.
- **No change to `recordInteraction`'s shipped behavior.** The Phase 1 probe is applied and
  reverted within the phase and is never committed.
- **No DOM/component test lane.** No jsdom, no testing-library, no fourth Vitest config.
- **No persistence of the decided set across mounts.** It is session-scoped client state; a
  reload correctly re-derives position from the server, because `swipe_deck` excludes likes
  and demotes skips.
- **No fix for the counter's deeper fiction** — "N left" against a fixed 20-card window is
  approximate until S-02 refills. This change only makes it agree with the rendered card.

## Implementation Approach

Prove, extract, rewire.

Prove first, because `change.md` flags the diagnosis as "diagnosed from the docs and the
code; not reproduced in a browser" and says confirming the repro decides whether this is the
whole story or only part of it. A throwaway cookie write in the Server Action makes the
re-render path fire on *every* swipe, converting an intermittent bug into a deterministic
one without waiting on Supabase's rotation schedule.

Extract second, because the selection rule is the thing that actually broke and the only way
to get CI-lane regression coverage on it is to make it a pure function. Landing the helper
and its tests before touching the component keeps the two reviewable independently.

Rewire last, replacing all three ordinal readers in one move so none is left behind.

## Critical Implementation Details

**The probe must never be committed.** It is a deliberate defect-inducer in a Server Action
on the mutation path. Apply it, observe, `git checkout src/app/actions/interactions.ts`
before staging anything. `context/foundation/lessons.md` § "Check the branch before the first
commit of a change" is the neighbouring failure mode; this is the same class. Confirm
`git status` is clean of `interactions.ts` before each phase-end commit.

**State sequencing on a failed write.** `decide` adds the id optimistically *before* awaiting
the round trip — that is existing intent (`SwipeDeck.tsx:31-33`: "Advance first — waiting on
the round trip would make every swipe feel like a page load") and must be preserved. The
rollback deletes that specific id. Both updates must use the functional `setState` form over
a **new** Set: concurrent in-flight transitions mean the closed-over set is stale, which is the
same class of bug being fixed.

## Phase 1: Confirm the repro

### Overview

Force the Server-Action re-render path on every swipe and observe the wrong card, so the
fix is aimed at a defect that has been seen rather than inferred. Nothing from this phase
is committed.

### Changes Required:

#### 1. Temporary cookie probe (applied and reverted within this phase)

**File**: `src/app/actions/interactions.ts`

**Intent**: Make every successful `recordInteraction` call write a throwaway cookie, so the
"Server Action set a cookie → Next re-renders the page" path fires deterministically instead
of only when Supabase happens to rotate the session. This reproduces the *effect* under
investigation without waiting on rotation timing.

**Contract**: Insert an `await cookies()` + `.set()` call inside `recordInteraction` before
its `return { ok: true }`. `cookies()` is async in Next 16 — see
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`. This edit is
reverted at the end of the phase and must not reach a commit.

#### 2. Repro log

**File**: `context/changes/swipe-deck-card-selection/repro.md`

**Intent**: Record what was actually observed — the deck order before the swipe, the card
swiped, the card that appeared, and the card that should have appeared — so Phase 3 has a
concrete sequence to re-run rather than a vague "try swiping". Also record whether anything
*other* than the stale index showed up, which is the open question this phase exists to close.

**Contract**: A dated note with the observed sequence and an explicit verdict line stating
whether the docs-based diagnosis fully explains the behavior seen.

### Success Criteria:

#### Automated Verification:

- Probe reverted, working tree clean of `src/app/actions/interactions.ts`: `git status --porcelain src/app/actions/interactions.ts` prints nothing
- Full gate still passes after revert: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build`

#### Manual Verification:

- With the probe applied, swiping in `/discover` lands the collector on a card that is not the next one they swiped to, and the sequence is written down in `repro.md`
- `repro.md` states explicitly whether the observed behavior is fully explained by the stale index, or whether a second cause is in play
- If a second cause appears, stop and reconcile the plan before Phase 2 rather than proceeding

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful
before proceeding to the next phase.

---

## Phase 2: Extract the selection rule

### Overview

Move "which card is next" out of the component and into a pure, testable function, and cover
it with the regression cases that define this defect. No component change in this phase.

### Changes Required:

#### 1. The selection helper

**File**: `src/lib/artworks/deck.ts` (new)

**Intent**: Own the single predicate — "the first artwork in `deck` whose id is not in
`decidedIds`" — and derive the remaining-count from that same predicate, so the rendered card
and the counter cannot disagree. Placed alongside `tags.ts` rather than `queries.ts` because
it is pure and must be importable from a Client Component; `queries.ts` is `server-only`.

**Contract**:

```ts
export type DeckSelection = {
  current: ArtworkWithArtist | null;
  remaining: number;
};

export function selectNextCard(
  deck: readonly ArtworkWithArtist[],
  decidedIds: ReadonlySet<string>,
): DeckSelection;
```

`remaining` counts deck entries whose id is not in `decidedIds` — **not** `deck.length -
decidedIds.size`, which undercounts and can go negative once the server drops liked pieces
from a refetched deck. `current` is `null` when every entry is decided or the deck is empty.
Ids present in `decidedIds` but absent from `deck` are ignored, not subtracted. S-02 extends
this by appending refilled pages to `deck`; the signature does not change.

#### 2. Helper tests

**File**: `test/lib/deck.test.ts` (new)

**Intent**: Encode the defect so a future refactor cannot quietly reintroduce it. The core
cases prove the contract; the churn cases are the actual regression net.

**Contract**: Follows the `test/lib/top-up.test.ts` idiom — plain Vitest, no mocks needed
(the module is pure). Cases:

*Core*
- Empty deck → `{ current: null, remaining: 0 }`
- Nothing decided → first entry is current, `remaining === deck.length`
- Everything decided → `{ current: null, remaining: 0 }`
- Leading entries decided → current is the first undecided entry, not `deck[n]`

*Churn regressions*
- Deck re-ordered between renders with the same decided set → current is still an undecided
  piece, never a decided one (this is the defect)
- A decided (skipped) piece reappearing lower in the deck, per S-01's demotion tier → it is
  skipped over, not served again
- Decided ids that are absent from `deck` → `remaining` is not reduced by them and does not
  go negative
- After a rollback (id removed from the set) with an unchanged deck → that artwork is current
  again

### Success Criteria:

#### Automated Verification:

- New tests pass: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Build passes: `npm run build`

#### Manual Verification:

- The churn tests fail when `selectNextCard` is temporarily reverted to ordinal indexing — observe them red before accepting them green, per `context/foundation/lessons.md` § "Prove each Progress item before checking it off"

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful
before proceeding to the next phase.

---

## Phase 3: Rewire SwipeDeck to the helper

### Overview

Replace all three ordinal readers with the helper, and re-run the Phase 1 probe sequence to
confirm the same input now produces the right card.

### Changes Required:

#### 1. Id-keyed client state

**File**: `src/components/artworks/SwipeDeck.tsx`

**Intent**: Swap `index` for a set of artwork ids decided this session and route the rendered
card, the remaining-count, and the failure rollback through `selectNextCard`, so there is one
definition of position rather than three.

**Contract**:

- `const [index, setIndex] = useState(0)` (`:17`) becomes a `Set<string>` of decided ids.
- `const current = deck[index]` (`:25`) becomes `const { current, remaining } = selectNextCard(deck, decidedIds)`.
- `decide` (`:27-43`) adds `artwork.id` to the set optimistically before `startTransition`,
  and on `!result.ok` deletes that same id — replacing `setIndex(prev ± 1)`. Both updates take
  the functional form and construct a new `Set`; mutating the existing one will not re-render
  and is stale under concurrent transitions.
- `` `${deck.length - index} left` `` (`:152`) becomes `` `${remaining} left` ``.
- The keydown effect's dependency (`:62`) keys off `current.id` rather than the `current`
  object, so a refetch that returns the same artwork does not tear down and re-register the
  listener.
- `if (!current) return <EmptyDeck />` (`:64-66`) is unchanged in behavior — `current` is now
  `null` rather than `undefined`, so the guard must accept both.

`EmptyDeck`, the pointer handlers, the drag/verdict rendering, and `recordInteraction`'s
signature are all untouched.

### Success Criteria:

#### Automated Verification:

- Full verify gate passes: `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build`
- No ordinal reader survives: `grep -n "setIndex\|deck\[" src/components/artworks/SwipeDeck.tsx` returns nothing
- Probe not committed: `git status --porcelain src/app/actions/interactions.ts` prints nothing before the phase-end commit

#### Manual Verification:

- With the Phase 1 probe re-applied, the sequence recorded in `repro.md` now advances to the correct next card on every swipe
- A piece skipped earlier in the session does not reappear after a refetch, despite S-01's demotion tier returning it in `deck`
- The "N left" counter agrees with the rendered card across a refetch and never goes negative
- A failed write (induced by taking the network offline mid-swipe) returns that specific card and shows the error
- Arrow keys, drag-to-commit, and the Skip/Like buttons all still work, and `/discover` still reaches `EmptyDeck` when the deck is exhausted
- Probe reverted and `git status` confirms it before committing

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit Tests:

- `test/lib/deck.test.ts` — the full case list in Phase 2. This is the only automated
  regression coverage on the logic that broke, and it is the reason the rule is extracted at
  all.
- Key edge cases: deck re-ordered between renders; a decided piece resurfacing in the
  demotion tier; decided ids absent from the deck; rollback restoring a card.

### Integration Tests:

None added. The defect lives in React client state, which the integration lane cannot reach,
and `test/integration/swipe-deck.int.ts` already covers `swipe_deck`'s real behavior including
the demotion tier.

### Manual Testing Steps:

1. Apply the Phase 1 cookie probe to `recordInteraction`.
2. Sign in as a collector with enough likes for S-01's ranking to produce a non-trivial order,
   open `/discover`, and note the first several cards.
3. Swipe one card. Confirm — before the fix — the next card is not the one that was second in
   the list; after the fix, confirm it is.
4. Skip a piece, keep swiping until a refetch occurs, and confirm the skipped piece does not
   reappear.
5. Watch "N left" across a refetch: it must match the number of undecided cards and never go
   negative.
6. Go offline, swipe, and confirm that specific card returns with an error.
7. Revert the probe and confirm `git status` is clean before committing.

## Performance Considerations

`selectNextCard` is O(n) over a deck capped at 20 entries (`getSwipeDeck`'s default limit),
run once per render. That is not a hotspot and does not warrant memoization. S-02's refill
will grow `deck`; if it ever becomes large enough to matter, the count and the scan can share
one pass — but not on speculation now.

## Migration Notes

None. No schema change, no migration, no data backfill. The decided-id set is session-scoped
client state, so a deployment mid-session simply resets a collector's position to whatever
`swipe_deck` returns — which is correct, since likes are excluded and skips are demoted
server-side.

## References

- Change brief with the full diagnosis: `context/changes/swipe-deck-card-selection/change.md`
- Roadmap entry recording the same defect: `context/foundation/roadmap.md` § S-02,
  "Known defect this slice must fix"
- Judgment walk that surfaced it:
  `context/archive/2026-09-10-personalized-deck-ranking/judgment-post-s01.md`
  § "Incidental finding"
- Next.js cookie/re-render contract:
  `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510-512`
- Pure `src/lib` module precedent: `src/lib/artworks/tags.ts`
- Default-lane test idiom: `test/lib/top-up.test.ts`
- Commit discipline: `context/foundation/lessons.md` §§ "Prove each Progress item before
  checking it off", "Check the branch before the first commit of a change"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Confirm the repro

#### Automated

- [x] 1.1 Probe reverted, working tree clean of `src/app/actions/interactions.ts` — 9b232f0
- [x] 1.2 Full gate still passes after revert — 9b232f0

#### Manual

- [x] 1.3 Wrong card observed with the probe applied and the sequence written to `repro.md` — 9b232f0
- [x] 1.4 `repro.md` states whether the stale index fully explains the behavior — 9b232f0
- [x] 1.5 If a second cause appeared, plan reconciled before Phase 2 — 9b232f0

### Phase 2: Extract the selection rule

#### Automated

- [x] 2.1 New tests pass: `npm run test` — 37df63f
- [x] 2.2 Type checking passes: `npm run typecheck` — 37df63f
- [x] 2.3 Linting passes: `npm run lint` — 37df63f
- [x] 2.4 Formatting is clean: `npm run format:check` — 37df63f
- [x] 2.5 Build passes: `npm run build` — 37df63f

#### Manual

- [x] 2.6 Churn tests observed red against ordinal indexing before being accepted green — 37df63f

### Phase 3: Rewire SwipeDeck to the helper

#### Automated

- [x] 3.1 Full verify gate passes
- [x] 3.2 No ordinal reader survives in `SwipeDeck.tsx`
- [x] 3.3 Probe not committed

#### Manual

- [x] 3.4 `repro.md` sequence now advances to the correct next card
- [x] 3.5 A skipped piece does not reappear despite the demotion tier
- [x] 3.6 "N left" agrees with the rendered card across a refetch and never goes negative
- [x] 3.7 A failed write returns that specific card with an error
- [x] 3.8 Arrow keys, drag, buttons, and `EmptyDeck` all still work
- [x] 3.9 Probe reverted and `git status` confirmed before committing
