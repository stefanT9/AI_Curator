# Judgment walkthrough — post-S-01 reading

The "after" half of the procedure in
`context/archive/2026-09-10-ranking-eval-corpus/judgment.md`. Same corpus, same
cluster codes, same first-~20 window — so this reading and the recorded pre-S-01
baseline are directly comparable.

- **Date:** 2026-09-10
- **Commit under test:** `fd9f9d9` (`test(personalized-deck-ranking): real-boundary proof (p2)`), branch `feat/personalized-deck-ranking`
- **Migration under test:** `supabase/migrations/20260910101500_rank_swipe_deck.sql`
- **How the decks were read:** `swipe_deck` called directly over psql against the
  local stack, once per collector, inside a transaction with
  `set local role authenticated` and `request.jwt.claims` set to that collector's
  id — so RLS and `auth.uid()` resolve exactly as they do for a signed-in
  request. This is the same query `/discover` renders; reading it here rather
  than by swiping keeps the walk immune to the client defect recorded at the
  bottom of this file, and lets Walk C's likes be rolled back instead of left
  behind. Verified before each walk that the collector's interaction rows were
  the seeded ones and nothing else, and after Walk C that the rollback left the
  database at 8 likes / 0 skips.

Cluster codes: 1 = Blue abstraction, 2 = Warm portraiture, 3 = Muted landscape,
4 = Neon street, U = untagged. Every seeded title now leads with its own code
(`[1] Cobalt Grid`, `[U] Untitled Study I`, …), so a walk is read straight off the
cards rather than inferred from four near-identical placeholder images.

## Setup

1. `npm run db:reset` — resets the local database (applying `seed.sql`) and
   re-uploads the seed images, which `db reset` clears. See
   `supabase/seed-assets/README.md`.
2. `npm run dev`

Walks are order-dependent: **A, then B, then C.** Walk C deliberately dirties the
cold collector's interaction history, so Walk B must be recorded first.

## Predicted orderings

Derived from `supabase/seed.sql` and the four-key sort in the migration, written
down _before_ the walk so the reading is a check rather than a rationalization.

The four keys, outermost first: tagged before untagged · unseen before skipped ·
tag overlap descending · `created_at` descending.

**Walk A (warm collector).** Taste is the union of tags across the eight likes,
all Blue abstraction: `{abstract, blue, geometric, minimal}`. The four unliked
Blue-abstraction pieces score 4; every other tagged piece scores **0**, including
Warm portraiture and Muted landscape — `oil` is shared between those two clusters
but is not in this collector's taste set. So clusters 2, 3 and 4 tie at zero and
separate only on recency, which is the round-robin stagger:

```text
1, 1, 1, 1, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4
```

No `U` in the first 20 — the two untagged pieces that fell inside the pre-S-01
window (baseline slots 7, 13, 16) are now below all 48 tagged pieces.

**Walk B (cold collector).** Empty taste, so every piece scores 0 and the tagged
tier is pure `created_at desc` — the round-robin cycle, with the untagged pieces
lifted out of it:

```text
4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1
```

**Walk C (partial match).** See "Walk C" below for why this walk exists. After the
cold collector likes two Warm portraiture pieces, taste is
`{portrait, figurative, warm, oil}`. Warm portraiture scores 4; Muted landscape
scores **1** on the shared `oil`; Blue abstraction and Neon street score 0. The
five pieces skipped on the way are demoted below every unseen tagged piece, so
neither cluster 1 nor cluster 4 should appear at all in the first 20:

```text
2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3
```

## Walk A — warm collector

`seed-collector-warm@artswipe.local` / `seedpassword`. Open `/discover`, do **not**
swipe, record the first 20 cluster codes.

- **Observed (first 20):** `1, 1, 1, 1, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4, 3, 2, 4`
  — matches the prediction exactly.
- **Recorded pre-S-01 baseline, for comparison:**
  `4, 2, 4, 2, 4, 2, U, 3, 1, 3, 2, 3, U, 3, 4, U, 4, 2`
- **Observed at `p_limit = 50`:** four `1`s, then `4, 3, 2` repeating for 36
  cards, then `U U U U U U`. All 46 servable pieces, no exceptions to the tiering.
- **Untagged positions:** 41–46 of 46 — the entire untagged population, contiguous
  at the tail, below every tagged piece. Pre-S-01 they sat at 7, 13 and 16.
- **Blue abstraction concentrated at the front? (Y/N):** **Y.** All four unliked
  Blue-abstraction pieces (`b…09`–`b…0c`) occupy positions 1–4 — `[1] Midnight
  Modulus`, `[1] Steel Blue Cadence`, `[1] Powder Blue Quadrant`, `[1] Cyan
  Meridian`, in `created_at desc` order within the overlap-4 tier. Baseline: one
  cluster-1 card in the first 18.
- **Any of the eight liked pieces (`b…01`–`b…08`) present? (Y/N):** **N.** Counted
  directly by joining the 50-card deck against the collector's `like` rows: 0.

**Verdict: pass.** The change S-01 exists to make is visible and unambiguous.
Every piece scoring 4 against the collector's taste leads the deck; everything
scoring 0 follows in pure recency order; untagged sinks to the tail. Against a
baseline where the collector's own eight Blue-abstraction likes bought them a
single cluster-1 card in eighteen, the deck is now built around them. FR-006
holds.

One property worth naming, because it looks like a flaw and is not: positions
5–40 are a clean `4, 3, 2` cycle. Clusters 2, 3 and 4 all score **0** against
Blue-abstraction taste, so `created_at desc` is doing all the work there — the
round-robin stagger of the corpus, surfacing intact. That is the recency floor
behaving as designed, not the ranking failing to discriminate.

## Walk B — cold collector

`seed-collector-cold@artswipe.local` / `seedpassword`. Open `/discover`, do **not**
swipe, record the first 20 cluster codes.

Judged against the **amended** expectation in the archived procedure — tagged
pieces newest-first with an untagged tail. The original expectation ("must not
change from pre-S-01") was amended by this change, because explicit untagged
demotion alters the cold-start deck by design.

- **Observed (first 20):** `4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1`
  — matches the prediction exactly.
- **Observed at `p_limit = 50`:** the `4, 3, 2, 1` cycle unbroken across all 48
  tagged pieces, then `U U` (the clamp truncates the remaining four untagged).
- **Tagged pieces in `created_at desc` order? (Y/N):** **Y.** The unbroken cycle
  is exactly the corpus's round-robin stagger — with an empty taste set every
  piece scores 0, so the recency floor is the whole ordering.
- **Any untagged piece above a tagged one? (Y/N — Y is a regression):** **N.**

**Verdict: pass, against the amended expectation.** The cold-start deck did
change — the two untagged pieces that sat mid-deck pre-S-01 are now at the tail.
Under the original expectation ("must not change") this would have been filed as
a cold-start regression; under the amended one it is the untagged demotion doing
precisely what it was added to do, with tagged recency ordering untouched
beneath it. This is the case the amendment was written for.

## Walk C — partial match

**Why this walk exists.** The plan's manual criterion 3.5 asks that `oil`-sharing
Warm portraiture / Muted landscape pieces rank above unrelated clusters as a
partial match. That is **not observable in Walk A**: the warm collector's taste is
`{abstract, blue, geometric, minimal}`, `oil` is not in it, and clusters 2, 3 and 4
therefore all score zero. The archived procedure hedged this ("may rank above");
the plan hardened the hedge into a criterion. The `oil` discriminator only fires
for a collector whose likes are in cluster 2 or 3, so this walk creates one.

Continue as `seed-collector-cold@artswipe.local`, immediately after recording
Walk B. Swipe until you have **liked two Warm portraiture cards** (cluster 2 —
"[2] Portrait in Burnt Orange", then "[2] Seated Figure, Firelight"); skip every
card you pass on the way. Reload `/discover` and record the first 20 cluster
codes.

- **Observed (first 20):** `2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3`
  — matches the prediction exactly.
- **Muted landscape (shares `oil`, overlap 1) above Blue abstraction and Neon street (overlap 0)? (Y/N):** **Y**, decisively — all ten remaining
  Muted-landscape pieces occupy positions 11–20, and **not one** Blue-abstraction
  or Neon-street piece appears in the first 20 at all. A single shared tag is
  enough to lift an entire cluster over two unrelated ones.
- **The five skipped pieces demoted out of the first 20? (Y/N):** **Y.** The two
  skipped Muted-landscape pieces (`[3] Moorland, Fading Day`, `[3] Coastal Flats,
  Grey Light`) are the two newest of their cluster and score the same 1 as the ten
  that are served — yet they are absent, sitting below every unseen tagged piece.
  Same for the skipped Neon-street and Blue-abstraction cards.
- **State after the walk:** rolled back; the database is at the seeded 8 likes /
  0 skips, so this walk left nothing behind for the next reader.

**Verdict: pass.** This is the partial-match discrimination the corpus's shared
`oil` tag was put there to expose, and Walk A structurally cannot show it. Note
the skip tier is doing visible work here too: overlap alone would have placed the
two skipped Muted-landscape pieces at 11 and 12.

**Standing proof, independent of this walk:** `test/integration/swipe-deck.int.ts`
asserts partial overlap directly against real Postgres — a fixture with overlap 1
(`weak`) ranks above one with overlap 0 (`zero`). Walk C is the human-legible
confirmation of a rule the integration lane already holds green.

## Incidental finding — the client's deck can be swapped mid-session

Not an ordering defect, and out of scope for this change (the plan holds
`SwipeDeck.tsx` and `getSwipeDeck` untouched) — recorded here because it was found
during this walk and it changes how a UI-based walk should be read.

`SwipeDeck.tsx:17` keeps `index` in client state and reads `deck[index]` from a
prop. `recordInteraction` calls the cookie-aware server Supabase client, which
writes cookies when Supabase rotates the session; a Server Action that sets a
cookie makes Next re-render the current page
(`node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510`,
with client state preserved per `:512`). `/discover` is `force-dynamic`, so
`getSwipeDeck()` re-runs and a freshly ranked array arrives while `index` still
counts against the old one — the collector lands on an unrelated card.
Intermittent, because it needs an actual cookie rotation.

S-01 did not cause this, but made it visible: the old anti-join dropped every
interacted piece, so a refetched deck looked like "the remainder"; the demotion
tier keeps skipped pieces in the array, so a stale index can resurface something
already passed. Assigned to **S-02 `continuous-deck-refill`** as a known defect.

**Consequence for this reading:** a walk conducted by swiping in the UI can be
perturbed by a mid-walk refetch. The readings above are taken from `swipe_deck`
directly via psql, which is the same query `/discover` renders and is immune to
this.

## Open Question 4 — where untagged artworks sit

**Answered.** Untagged pieces sort below every tagged piece, including
previously-skipped ones — the outermost of the four sort keys. Pre-S-01 they sat
wherever `created_at` put them (baseline slots 7, 13, 16, mid-deck, no deliberate
placement). Recorded in `context/foundation/roadmap.md` § Open Roadmap Questions 4;
this narrows S-03 to Open Question 2 (the like threshold) alone.
