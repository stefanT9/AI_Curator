---
change_id: ranking-eval-corpus
title: Ranking evaluation corpus — seeded artworks, identities and like history
status: implementing
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

Roadmap item **F-01** from `context/foundation/roadmap.md`, the foundation that unlocks the
north star **S-01** (`personalized-deck-ranking`).

Original ask, from the roadmap:

> **Outcome:** (foundation) a seeded set of tagged artworks and a collector like-history exists
> in the development environment, so a tag-match ordering can be exercised and judged rather
> than guessed at.
>
> **Risk:** Deliberately minimal — seed data in the development environment only, no schema
> change, no production data, no migration. The failure mode to watch is scope creep: this must
> stay a corpus, not become a general fixtures framework.

Judged by a human swiping through `/discover`, not by an automated assertion. There is no
ranking to assert against until S-01 ships; a test written now would be written against a
contract that does not exist yet, and would be the fixtures framework the roadmap warned about.
