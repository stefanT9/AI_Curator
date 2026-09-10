# Repro log — swipe deck silently drops one unviewed artwork per swipe

**Date**: 2026-09-10
**Phase**: 1 (Confirm the repro)
**Branch**: `fix/swipe-deck-card-selection`

## Method

The defect needs a `deck` prop replacement mid-session, which in production only
happens when Supabase rotates the session cookie inside `createClient()` — timing
nobody can wait on. To make it deterministic, a throwaway cookie write was added to
`recordInteraction` immediately before `return { ok: true }`:

```ts
const probeCookies = await cookies();
probeCookies.set("repro-probe", String(Date.now()));
```

Per `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510-512`,
setting a cookie in a Server Action re-renders the current page on the server while
client state is preserved. `/discover` is `force-dynamic`
(`src/app/(app)/discover/page.tsx:12`), so `getSwipeDeck()` re-runs and `SwipeDeck`
receives a fresh array while `index` keeps counting against the old one.

A second throwaway probe in `SwipeDeck.tsx` logged the full deck (via `console.table`)
on every `[deck, index]` change, plus one line per verdict and per write completion.
That is what makes the mechanism below observable rather than inferred.

**Both probes are applied and reverted inside Phase 1 and are never committed.**

Run against the local `supabase/seed.sql` corpus, signed in as a collector with prior
likes so S-01's ranking produced a non-trivial order. Titles carry a `[n]` tier prefix
from the seed data; the logged `id` is truncated to 8 chars and collides across seed
rows, so **titles**, not ids, identify cards below.

## Observed sequence

Five swipes, all skips. Each swipe produces **two renders**, which is the crux:

### Swipe 1 — `Chalk Downs Under Cloud`

| Render | index | Deck state | Card shown |
| --- | --- | --- | --- |
| A (before) | 5 | `…4 Underpass, 5 Chalk Downs, 6 Old Friend, 7 Motel Sign, 8 Pale Pasture…` | `Chalk Downs` (pos 5) |
| B (optimistic) | 6 | **unchanged** — write not yet visible | `Old Friend in Umber` (pos 6) ✅ correct |
| C (after refetch) | 6 | `Chalk Downs` **gone**; `…5 Old Friend, 6 Motel Sign, 7 Pale Pasture…` | `Motel Sign` (pos 6) ❌ |

`Old Friend in Umber` was rendered in B, then replaced in C without ever being swiped.

### Swipe 2 — `Motel Sign, No Vacancy`

| Render | index | Deck state | Card shown |
| --- | --- | --- | --- |
| A | 6 | `…6 Motel Sign, 7 Pale Pasture, 8 Woman by a Rust Wall…` | `Motel Sign` |
| B | 7 | unchanged | `Pale Pasture at Noon` (pos 7) ✅ correct |
| C | 7 | `Motel Sign` gone; `…6 Pale Pasture, 7 Woman by a Rust Wall…` | `Woman by a Rust Wall` ❌ |

`Pale Pasture at Noon` lost the same way.

### The mechanism

On each swipe two things move in the same direction and cancel out one card:

1. `index` advances by one (`SwipeDeck.tsx:33`, the optimistic advance).
2. The refetched deck **loses the swiped card from above the cursor**, shifting every
   later entry up by one position.

Net effect: `deck[index]` lands one entry *past* where it should. Exactly one unviewed
artwork is dropped per swipe, and the losses compound across a session.

**Deck length stays 20.** The window is capped at 20 (`getSwipeDeck`'s default limit),
so as one card leaves the top a new one is pulled in at the bottom — `Fallow Field,
Overcast` appeared at pos 19 after swipe 1, `Terracotta Half-Length` after swipe 2.
This is why the `N left` counter looks plausible while being wrong: `deck.length - index`
decrements by one per swipe regardless of the churn beneath it.

## How this differs from the plan's predicted symptom

`plan.md` § Current State Analysis and `change.md` § The defect both describe the
symptom as *resurfacing a piece the collector already passed on*, via S-01's demotion
tier keeping skipped pieces in the array lower down. **That is not what was observed,**
and the difference is worth recording:

- A skipped piece is demoted **below the 20-entry window**, not to a lower visible slot.
  It leaves `deck` entirely and does not come back within the session.
- Because it leaves from *above* the cursor, the array shifts up and the victim is the
  card immediately **after** it — an artwork the collector never saw a verdict on.
- So the user-visible harm is **silent loss of unviewed work**, not a repeat. For a
  marketplace whose whole job is putting artists' pieces in front of collectors, losing
  one unviewed piece per swipe is the more serious framing of the same bug.

The predicted resurfacing is still *possible* — a demoted piece re-enters the window
once enough entries above it are consumed, and a refetch that races the write can
reorder within the window — but the deterministic, every-swipe symptom is the drop.

The two-render sequence was also not predicted: the correct card renders first
(optimistic advance, stale deck) and is then replaced when the refetch lands. The
defect presents as a **visible flicker onto the wrong card**, not a silent jump.

## Verdict

**The stale ordinal index fully explains the observed behavior. No second cause is in
play. Proceed to Phase 2.**

Every observation follows from the single fault the plan identifies — `SwipeDeck` holds
an ordinal position (`SwipeDeck.tsx:17`, `:25`) against a `deck` prop that the Server
Action's cookie write causes Next to replace. No state reset, no remount, no double
write, no error path was involved; `index` advanced correctly every time and was read
against the wrong array.

**No plan reconciliation is required.** The Phase 2/3 contract is unaffected: keying
position to artwork id fixes a shifted array exactly as it fixes a re-ranked one. In
swipe 1, `Old Friend in Umber` is not in `decidedIds`, so `selectNextCard` keeps it
current no matter which position it occupies.

| Observation | Addressed by |
| --- | --- |
| One unviewed card dropped per swipe | `current` = first deck entry whose id is not in `decidedIds` |
| Wrong card after refetch, correct one before | Selection no longer depends on array position at all |
| `N left` decrementing against `index` | `remaining` derives from the same id predicate |
| Counter's latent negative | `remaining` counts undecided entries; never `length - size` |

### Carried into Phase 3 verification

Phase 3's manual checks were written against the predicted symptom. Re-run them against
what was actually seen:

- **3.4** — after each swipe, the card shown in render B must still be the card shown in
  render C. No flicker onto a different piece.
- **3.5** — the plan asks that a skipped piece not reappear. Also confirm the stronger
  property this repro exposes: **no unviewed piece disappears**. Log the deck across a
  swipe and check that the entry following the swiped card becomes current.
