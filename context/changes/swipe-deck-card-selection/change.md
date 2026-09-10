---
change_id: swipe-deck-card-selection
title: Swipe deck picks the next card by artwork id, not by ordinal index
status: implementing
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

Fixes a live defect found during the S-01 judgment walk (2026-09-10) and recorded
on roadmap slice **S-02 `continuous-deck-refill`** as a known defect. Shipped to
production with PR #14, so this is a fix to live behavior, not a pre-release
cleanup.

### The defect

`src/components/artworks/SwipeDeck.tsx:17` holds `index` in client state and
renders `deck[index]` from a prop. That is sound only while the prop never
changes — and it can:

1. `recordInteraction` calls `await createClient()`
   (`src/app/actions/interactions.ts:32`).
2. That factory writes cookies via `cookieStore.set` whenever Supabase rotates
   the session (`src/utils/supabase/server.ts:16-26`).
3. Per `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510`
   — "When you set or delete a cookie in a Server Action, Next.js re-renders the
   current page and its layouts on the server" — and `:512`, "Client state is
   preserved for re-rendered components."
4. `/discover` is `force-dynamic` (`src/app/(app)/discover/page.tsx:12`), so the
   re-render re-runs `getSwipeDeck()` and hands `SwipeDeck` a freshly ranked
   array while `index` keeps counting against the old one.

The collector lands on a card they never swiped to. Intermittent — it needs an
actual session-cookie rotation, not merely a swipe.

**Diagnosed from the docs and the code; not reproduced in a browser.** Confirming
the repro is the first thing a plan should schedule, because it decides whether
this is the whole story or only part of it.

### Why now, when the code predates S-01

S-01 did not introduce this. It made it visible. The old `swipe_deck` anti-joined
on _any_ interaction row, so a refetched deck was roughly "everything left" and a
stale index mostly looked like an extra skipped card. S-01's demotion tier keeps
skipped pieces **in** the array, lower down — so a stale index can now resurface a
piece the collector already passed on.

### Proposed direction (not yet planned)

Key the client's position to artwork id rather than ordinal: track the set of ids
decided this session, and render the first artwork in `deck` not in that set. A
re-render then reorders the cards the collector has not yet seen — which is
correct, and is what S-02 will want anyway — instead of teleporting them to an
unrelated card. On a failed write, drop the id back out of the set.

Alternative considered: freeze `deck` into client state on mount so prop churn is
ignored entirely. Simpler, but it makes the deck permanently stale and S-02 would
have to undo it.

### Testing constraint — read before planning

**There is no DOM test lane in this repo.** `vitest.config.mts:17` is Node-only
("No jsdom; component tests would need their own environment") and neither jsdom
nor testing-library is a dependency. A component test is therefore not possible
without standing up a fourth lane.

Suggested way around it: extract the selection rule into a pure helper under
`src/lib/` (deck + decided-id set → next card) and unit-test that in the existing
default lane. Real regression coverage on the logic that actually broke, no new
dependencies, and `SwipeDeck` becomes a thin shell. Adding a DOM lane is the
alternative, and is a bigger decision than this fix should make on its own.

### Relationship to S-02

S-02 `continuous-deck-refill` owns deck lifecycle and will rework this component.
This change is deliberately scoped smaller than S-02 and should stay that way:
no refill, no cursor, no pagination — just stop showing the wrong card. Shape the
helper so S-02 extends it rather than replaces it.

### Pointers

- Roadmap entry with the same diagnosis: `context/foundation/roadmap.md` § S-02,
  "Known defect this slice must fix"
- Judgment walk that surfaced it:
  `context/archive/2026-09-10-personalized-deck-ranking/judgment-post-s01.md`
  § "Incidental finding"
- Branch: `fix/swipe-deck-card-selection`, cut from `main` at `cce9eca`
