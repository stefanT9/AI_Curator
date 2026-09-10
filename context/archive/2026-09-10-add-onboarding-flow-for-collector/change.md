---
change_id: add-onboarding-flow-for-collector
title: Add onboarding flow for collector
status: archived
created: 2026-09-10
updated: 2026-09-10
archived_at: 2026-09-10T17:59:42Z
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

## TODO — seed a style-tagged artwork corpus

**Open. Not a blocker for Phase 3 — all of 3.8–3.12 were walked by hand using
the three usable terms — but it constrains the flow's real-world and demo value.**

The onboarding picker offers the 20 `style` terms from
`TAXONOMY_BY_FACET.style`. The local seed corpus in `supabase/seed.sql` was
built for the S-01 ranking evaluation and its 54 artworks carry only four
clusters of ad-hoc tags — `{abstract,blue,geometric,minimal}`,
`{portrait,figurative,warm,oil}`, `{landscape,muted,oil,pastoral}`,
`{street,neon,high-contrast,photography}` — plus six untagged.

Intersecting those with the style vocabulary leaves exactly three usable terms:
`abstract`, `figurative`, `geometric`. Near misses do not match — `minimal` is
not `minimalist`, `street` is not `street art`, and `photography` is a `medium`
term, not a `style` one. So a collector picking any 2–4 style terms outside
those three gets an **empty starter pool** and drops straight to the
release-to-Discover path.

Phase 3's manual rows 3.8, 3.9, 3.11 and 3.12 were all verified against this
corpus, but only by steering the pick toward `abstract` / `geometric` so cluster
1's twelve pieces came back. Any other selection lands on 3.10's path — terms
matching nothing — which is the *default* outcome today rather than the edge
case it is meant to be. A collector picking honestly is more likely to get an
empty pool than a starter deck.

**What is needed:** enough artworks tagged with real `style` terms that any
plausible 2–4 term pick returns a pool of at least `ONBOARDING_LIKE_TARGET`
pieces, spread across the vocabulary rather than concentrated in three terms.

**Constraint:** `supabase/seed.sql` is the ranking-evaluation corpus, and its
existing shape is deliberate — the four clusters, the shared `oil` tag, the
round-robin `created_at` stagger and the `[N]` title prefixes all exist to make
a broken ranking visible. The archived S-01 walkthroughs in
`context/archive/2026-09-10-ranking-eval-corpus/judgment.md` are recorded
against it. New rows must extend the corpus without invalidating those walks,
and `supabase/seed-assets/README.md` covers the image-upload half. Per
`AGENTS.md`, do not add a second seeding mechanism.

Sizing it and deciding whether the style tags go onto the existing clusters or
onto new rows is a design call, not a mechanical edit — hence a todo rather
than an in-phase fix.
