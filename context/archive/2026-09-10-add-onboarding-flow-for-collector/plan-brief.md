# Onboarding Flow for Collector — Plan Brief

> Full plan: `context/changes/add-onboarding-flow-for-collector/plan.md`
> Frame brief: `context/changes/add-onboarding-flow-for-collector/frame.md` — **superseded in part**, see Open Risks
> Research: `context/changes/add-onboarding-flow-for-collector/research.md`

## What & Why

A brand-new collector lands on `/discover` with zero likes, so the tag-match ranking
shipped in `S-01` has nothing to match on and falls back to `created_at desc`. For the
audience this targets — a course grader evaluating the app in a single session — that
fallback *is* the product they see, and the core thesis never demonstrates itself. This
change gives the collector real likes before they reach the deck, so their first
`/discover` is genuinely personalized.

## Starting Point

Ranking is live and correctly shaped: `swipe_deck` sorts on tag-overlap against the
collector's own **liked** artworks, with skips as a demotion signal only. But nothing in
the product distinguishes a new collector from an established one — no flag, no counter,
no first-run detection anywhere in `src/`. There is also no multi-select, stepper, modal
or dialog primitive to build a flow out of; everything is hand-rolled Tailwind.

## Desired End State

A new collector is redirected into a chrome-free first-run flow they cannot bypass. They
pick 2–4 `style` terms, rate starter artworks matching those terms, and exit once they've
liked five — or once the starter pool runs dry, whichever comes first. Either way
`profiles.onboarded_at` is stamped and they land on a `/discover` deck ordered by the
tags of the pieces they just liked. On that first real card, a dismissible hint teaches
drag, buttons and arrow keys.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Is this change plannable at all? | Yes — the frame's blocker lifted | The frame's `STRONG` verdict rested on "no ranking exists anywhere"; `S-01` merged in PR #14 after the frame was written, so the signal now has a consumer. | Plan |
| Scope | Both halves, sequenced | Taste bootstrap first, orientation after — the user holds both payoffs equally. | Plan |
| Audience | Course grader, one session | Unchanged from the frame; keeps the acceptance bar concrete and rules out accumulate-over-time rationales. | Frame |
| Bootstrap mechanism | Hybrid — pick style terms, then rate real artworks | Term choice narrows the starter set; rating writes ordinary `interactions` rows the live ranking consumes unmodified. | Plan |
| Term granularity | 2–4 terms within the `style` facet | Whole facets narrow nothing; all 100 terms is a full tag picker. One facet's 20 chips is the workable middle. | Plan |
| Do terms persist? | No — transient selection input | Nothing reads them after the pool is built, so no migration, no preference table, and post-onboarding ranking input is genuinely just the collector's own likes. | Plan |
| Gate placement | `requireOnboarded` in `(app)/layout.tsx`, mandatory | The authoritative guard, not the optimistic proxy — catches deep links to `/discover`. | Plan |
| Exit condition | 5 likes **or** starter pool exhausted | The like target alone traps a collector who skips everything behind a mandatory gate; exhaustion release removes the lockout without adding a skip button. | Plan |
| PRD Non-Goal conflict | Amend `prd-v2.md` in this change | Term selection is a collector-facing ranking control; leaving the record contradicting shipped behavior is the exact failure the frame exists to catch. | Plan |
| Orientation form | Inline dismissible hint on the first card | No modal primitive to build, and it leaves `EmptyDeck` untouched for `S-02`. | Plan |
| Hint dismissal state | `localStorage`, not `profiles` | A per-viewer UI convenience; overloading `onboarded_at` would make the gate depend on a dismissal. | Plan |

## Scope

**In scope:** `profiles.onboarded_at` + widened column grants · `requireOnboarded` DAL
gate · `(onboarding)` route group with term picker and rating loop · `getStarterDeck`
query · `completeOnboarding` Server Action · first-run hint in `SwipeDeck` · amendments to
`prd-v2.md`, `roadmap.md` and the archived `judgment.md`.

**Out of scope:** the false `EmptyDeck` copy (owned by `S-02: continuous-deck-refill`) ·
any change to `swipe_deck` or ranking behavior · a preference table or facet column · a
skip button · backfilling existing accounts · a reusable stepper/modal abstraction · PRD
Open Question 1 (tag weighting).

## Architecture / Approach

New `(onboarding)` route group, a sibling of `(app)` and `(auth)`, rendering without app
chrome and outside the gate it exists to satisfy. The term picker imports
`TAXONOMY_BY_FACET.style` client-side (that module is deliberately free of `server-only`).
Selected terms feed `getStarterDeck`, which filters `artworks` on tag array-overlap via
the existing `artworks_tags_idx` GIN index. Each verdict reuses the existing
`recordInteraction` upsert; completion stamps `onboarded_at` and redirects. Because the
output is ordinary `like` rows, the ranking function needs no change whatsoever.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema and DAL | `onboarded_at` column, both grants widened, `requireOnboarded` defined but uncalled | Wiring the gate here would lock every account out during phases 2–3 |
| 2. Starter selection | `getStarterDeck` query, style-term picker, `(onboarding)` route group | First multi-select in the product — no primitive exists to extend |
| 3. Rating loop and completion | Card-by-card rating, dual exit condition, `completeOnboarding` | The skip-everything path must reach completion, not hang |
| 4. Gate wiring | Onboarding becomes compulsory | Trap door — a redirect loop here locks the whole authenticated segment |
| 5. First-run orientation | Dismissible hint on the first real card | Must not touch `EmptyDeck` or regress the swipe verdict path |
| 6. Decision record | `prd-v2.md`, `roadmap.md`, `judgment.md` amended | Editing foundation docs from a change plan widens the blast radius |

**Prerequisites:** `S-01: personalized-deck-ranking` (done, merged PR #14) · a seeded
local corpus for judging the ordering change · linked Supabase project for
`npm run db:types`.

**Estimated effort:** ~3–4 sessions across 6 phases; phases 1, 4 and 6 are small, phases
2 and 3 carry most of the work.

## Open Risks & Assumptions

- **The frame brief is stale in its decisive respect.** Its `STRONG` D3 hypothesis — "no
  ranking implementation anywhere in the repo, verified across `main` and all 13 branches"
  — was true at `85270a0` but false as of PR #14. The frame's structural conclusion (this
  is `S-03` under a new name) survives; its "do not plan this change as written" verdict
  does not. Anyone reading the frame after this plan needs that context.
- **The mandatory gate has no escape hatch by design.** If the flow breaks in production,
  every collector is locked out of the entire authenticated segment. Phase 4's ordering
  mitigates this during development but not after deploy.
- **Every existing account is routed through the flow** — `onboarded_at` is nullable with
  no backfill. Intended, but it means the local dev account and the seeded cold collector
  both see onboarding on next sign-in.
- **Term selection is a collector-facing ranking control**, which the PRD lists as a
  Non-Goal. Phase 6 records the carve-out; until it lands, shipped behavior contradicts
  the decision record.
- **Five likes is an asserted number, not a measured one.** It replaces PRD Open Question 2
  rather than answering it. If the resulting ordering is not visibly different, the target
  is the first thing to tune.
- **Starter set quality depends on the corpus.** With a thin live catalogue, 2–4 style
  terms may match very few pieces, pushing most collectors down the exhaustion-release
  path with weak taste.

## Success Criteria (Summary)

- A grader who signs up and completes the flow sees a `/discover` deck demonstrably
  ordered by what they just liked, not by recency — within one session.
- A collector who skips every starter piece still reaches `/discover`, on the proven-safe
  newest-first fallback.
- The swipe interaction, liking, and the liked view are all unchanged, and the
  `EmptyDeck` defect is left intact for `S-02`.
