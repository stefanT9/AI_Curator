# Swipe deck picks the next card by artwork id — Plan Brief

> Full plan: `context/changes/swipe-deck-card-selection/plan.md`
> Change brief (functions as the frame): `context/changes/swipe-deck-card-selection/change.md`

## What & Why

`SwipeDeck` holds an ordinal `index` in client state and renders `deck[index]` from a prop
that can be swapped underneath it — a Server Action writes a session cookie, Next re-renders
`force-dynamic` `/discover`, `getSwipeDeck()` re-runs, and a freshly ranked array arrives
while `index` still counts against the old one. The collector lands on a card they never
swiped to. This is live production behavior, shipped with PR #14.

## Starting Point

`SwipeDeck.tsx` has three readers over that one ordinal: the rendered card (`:25`), the
optimistic advance and failure rollback (`:33`/`:39`), and the "N left" counter (`:152`).
The defect was diagnosed from the Next.js docs and the code during S-01's judgment walk but
**never reproduced in a browser** — and it needs a real Supabase session rotation to fire,
so it is intermittent. S-01 did not cause it; its demotion tier made it visible, because
skipped pieces now stay in the returned array instead of being anti-joined away.

## Desired End State

A collector never sees a card they did not swipe to, even when the deck prop is replaced
mid-session. A re-ranked deck reorders the cards ahead of them rather than moving them. A
piece skipped this session does not come back this session, despite the demotion tier
returning it. A failed write returns that specific card, not whichever one is current.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Position key | Artwork id set, not ordinal | Only an id set can express "not this session" once skipped pieces stay in the deck. | Change brief |
| Rejected alternative | Not freezing the deck on mount | Simpler, but makes the deck permanently stale and S-02 would have to undo it. | Change brief |
| Repro | Forced-cookie probe, applied and reverted | Turns an intermittent bug deterministic in two lines instead of waiting on Supabase's rotation schedule. | Plan |
| Helper contract | `selectNextCard(deck, decidedIds) → { current, remaining }` | One call feeds both the card and the counter, killing every ordinal reader; S-02 extends it by appending to `deck`. | Plan |
| Rollback | Delete the id, let the card re-rank | Correct under concurrent in-flight swipes, where today's `setIndex(prev - 1)` un-advances the wrong card. | Plan |
| Counter | Count undecided entries in `deck` | `deck.length - decidedIds.size` undercounts and goes negative once the server drops liked pieces. | Plan |
| Test scope | Core + prop-churn regressions, default lane | The churn cases encode the defect; no DOM lane exists and adding one is a bigger decision than this fix. | Change brief + Plan |

## Scope

**In scope:** id-keyed client state in `SwipeDeck`; a pure `src/lib/artworks/deck.ts` helper;
`test/lib/deck.test.ts`; a browser-confirmed repro before and after.

**Out of scope:** deck refill / cursor / pagination (S-02); any change to `swipe_deck`,
`getSwipeDeck`, or migrations; shipped changes to `recordInteraction`; a DOM test lane;
persisting the decided set across mounts; fixing the counter's deeper "20-card window"
approximation.

## Architecture / Approach

Prove, extract, rewire. A throwaway cookie write in `recordInteraction` forces the
Server-Action re-render on every swipe, making the defect observable on demand. The
selection rule then moves into a pure module beside `tags.ts` — the only way to get CI-lane
regression coverage, since `vitest.config.mts` is Node-only with no jsdom. The component
becomes a thin shell that calls `selectNextCard(deck, decidedIds)` and holds a `Set<string>`
instead of a number.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Confirm the repro | A written `repro.md` sequence and a verdict on whether the stale index is the whole story | The probe is a defect-inducer in a mutation path — committing it by accident |
| 2. Extract the selection rule | `src/lib/artworks/deck.ts` + `test/lib/deck.test.ts`, no component change | Writing the churn tests already-green, so they never prove anything |
| 3. Rewire `SwipeDeck` | Id-keyed state, helper-driven card + counter + rollback | Leaving one of the three ordinal readers behind |

**Prerequisites:** a local Supabase stack with the S-01 seed corpus and a collector account
with enough likes for ranking to produce a non-trivial order; branch
`fix/swipe-deck-card-selection`, already cut from `main` at `cce9eca`.
**Estimated effort:** ~1 session across 3 phases; Phase 1 is the only one whose length is
uncertain.

## Open Risks & Assumptions

- **The repro may not be the whole story.** The diagnosis is docs-and-code only. Phase 1
  exists to close this, and explicitly instructs stopping to reconcile the plan if a second
  cause appears.
- **The probe proves the mechanism under a forced cookie write**, not that Supabase's natural
  rotation is the production trigger — that inference stays on the Next.js docs.
- **S-02 will rework this component.** The helper is shaped so S-02 extends it by appending
  refilled pages to `deck`; if S-02 chooses a reducer instead, the extraction still holds but
  the signature may move.
- **Manual verification carries most of the proof.** With no DOM lane, the unit tests cover
  the rule but not its wiring into React — steps 3.4–3.8 are the only check on that.

## Success Criteria (Summary)

- Swiping with the probe applied advances to the correct next card, on the same sequence that
  previously produced the wrong one.
- A piece skipped this session stays gone this session, even though `swipe_deck` returns it
  demoted.
- "N left" agrees with the rendered card across a refetch, and a failed write returns exactly
  the card that failed.
