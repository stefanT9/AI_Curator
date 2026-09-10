---
change_id: add-onboarding-flow-for-collector
title: Add onboarding flow for collector
status: implementing
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

**The frame brief is partly superseded.** `frame.md` concluded "do not plan this change
as written", on the strength of hypothesis D3: no ranking implementation existed anywhere
in the repo. That was verified at commit `85270a0` — the same commit `research.md` was
written against — and was true then. `S-01: personalized-deck-ranking` merged afterwards
in PR #14 (`cce9eca`), adding
`supabase/migrations/20260910180000_rank_swipe_deck.sql`.

What survives the update: the frame's structural conclusion that the taste-bootstrap half
is `S-03: cold-start-and-untagged-placement` under a new name, its reading that onboarding
*dissolves* PRD Open Question 2 rather than answering it, the four PRD conflicts, and the
note that `EmptyDeck` belongs to `S-02`. What does not survive: the verdict itself —
`S-03`'s only prerequisite was `S-01`, and it is now satisfied.

Read `frame.md` with this note alongside it.
