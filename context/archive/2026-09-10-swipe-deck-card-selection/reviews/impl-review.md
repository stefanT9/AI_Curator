<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Swipe deck picks the next card by artwork id

- **Plan**: context/changes/swipe-deck-card-selection/plan.md
- **Scope**: Full plan (Phases 1–3)
- **Date**: 2026-09-10
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Method

Two parallel sub-agents reviewed the diff since `cce9eca` (branch point):
`src/lib/artworks/deck.ts` (new), `test/lib/deck.test.ts` (new),
`src/components/artworks/SwipeDeck.tsx` (modified), plus the change folder.

- **Agent 1 (drift)**: verified every planned contract item field-for-field
  against the actual code and confirmed the "What We're NOT Doing" boundaries
  held.
- **Agent 2 (safety/pattern)**: scanned for security/performance/reliability/
  data-safety issues and compared against `tags.ts` / `top-up.test.ts` precedent.

Automated success criteria (`format:check`, `lint`, `typecheck`, `test`,
`build`) were re-run directly and passed.

## Findings

### F1 — Keydown effect's stale `current` closure is safe only by convention

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/artworks/SwipeDeck.tsx:62-78 (effect), `decide` at :34
- **Detail**: The keydown effect keys off `currentId` (correct, matches the
  plan) so a refetch returning the same artwork id doesn't tear down the
  listener. But its handler closure still captures the `current` *object*
  from whichever render registered it, which can be stale-but-same-id for a
  stretch between renders. Harmless today because `decide` only reads
  `artwork.id` off its argument — but a silent trap if `decide` (or anything
  it calls) is ever extended to read another field, since `current` remains
  a well-typed `ArtworkWithArtist` and nothing would flag the staleness.
- **Fix**: Added a one-line comment directly above `decide`'s declaration
  noting only `.id` may be relied on, since the keydown effect passes an
  intentionally-stale reference.
- **Decision**: FIXED

## Notes for the record

- Agent 1 flagged one **disclosed, reasoned** deviation worth naming even
  though it isn't a code-contract violation: `repro.md` documents that the
  *observed* Phase 1 symptom (silent drop of an unviewed card via a
  two-render flicker) differed from the plan's *predicted* symptom
  (resurfacing a demoted/skipped card). Per the plan's own instructions, this
  was evaluated and explicitly concluded not to require reconciliation before
  Phase 2, because the same id-set selection fix addresses both framings.
  Recorded here for traceability, not as a finding requiring action.
- Both agents independently confirmed the plan's "critical" correctness
  requirement — functional `setState` over a new `Set` in both the optimistic
  add and the failure-rollback delete — is implemented correctly in both
  directions.
