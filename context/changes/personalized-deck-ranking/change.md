---
change_id: personalized-deck-ranking
title: Deck ordered by tag-match to the collector's own likes
status: implemented
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

Roadmap item **S-01** from `context/foundation/roadmap.md` — the north star of the
recommendation-engine roadmap. Prerequisite **F-01** (`ranking-eval-corpus`) is done and
archived, so the seeded corpus and the recorded pre-S-01 baseline both exist to judge this
against.

Planned after `/10x-frame add-onboarding-flow-for-collector` established that no ranking
implementation exists anywhere in the repo, and that onboarding work was sequenced ahead of
the thing that would give it meaning. See
`context/changes/add-onboarding-flow-for-collector/frame.md`.

Decisions taken during planning that are **not** in the PRD or roadmap:

- Untagged artworks are explicitly demoted below every tagged piece, **including
  previously-skipped ones**. This answers PRD Open Question 4 inside S-01 and narrows S-03
  to the like-threshold question (OQ-2) alone.
- Because that changes the cold-start deck, the archived Walk B expectation in
  `context/archive/2026-09-10-ranking-eval-corpus/judgment.md` is amended rather than
  preserved. Chosen deliberately over scoping demotion to ranked collectors only.
