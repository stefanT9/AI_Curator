# Personalized Deck Ranking — Plan Brief

> Full plan: `context/changes/personalized-deck-ranking/plan.md`
> Frame brief: `context/changes/add-onboarding-flow-for-collector/frame.md`

## What & Why

Every collector is served the same newest-first deck today, with no relationship to what they
have liked — while every artwork already carries machine-readable tags that nothing consumes.
This slice is the consumer: it orders each collector's deck by how well a piece's tags overlap
the tags on the pieces they liked. It is roadmap **S-01**, the north star; a framing pass on a
proposed onboarding flow established that no ranking exists at all, and that everything
downstream of it was being planned ahead of the thing that gives it meaning.

## Starting Point

`swipe_deck` is a single Postgres function that orders `by a.created_at desc` and anti-joins
against *any* interaction row, so skipped pieces vanish permanently. No ranking code exists on
`main` or any of the 13 branches. The evaluation corpus from F-01 is seeded and a pre-S-01
baseline is recorded: the warm collector's first ~18 cards contained cluster 1 exactly once,
despite all eight of their likes being cluster 1.

## Desired End State

A collector who has liked several pieces sees their next cards ordered by tag overlap against
those likes — for the seeded warm collector, Blue-abstraction pieces concentrate at the front
instead of appearing once in eighteen cards. Pieces they skipped return below all fresh
matches rather than disappearing. Untagged pieces sit at the very bottom. Liked pieces never
come back.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Match metric | Raw overlap count | What the PRD resolved for v1 — simplest thing that works and easy to eyeball in the judgment walk. | Plan |
| Taste construction | Distinct union of liked tags | The literal meaning of "unweighted", keeping PRD Open Question 1 genuinely open. | Plan |
| Tie-break | `created_at desc` | Preserves today's ordering as the floor wherever scores tie. | Plan |
| Untagged placement | Explicitly demoted below every tagged piece, skipped ones included | Deliberate and testable rather than accidentally correct — answers PRD Open Question 4. | Plan |
| Cold-deck conflict | Demote always; amend the archived Walk B expectation | One unconditional rule over two conditional code paths, at the cost of rewriting a forward-looking expectation in an archived file. | Plan |
| Skipped pieces | Return, demoted below all unseen pieces | Roadmap resolution of Open Question 3. | Research |
| Where ranking lives | In the SQL function | Keeps the RPC contract and the `security invoker` RLS boundary; avoids pulling the catalogue into Node. | Plan |
| FR-006 proof | Integration test against real Postgres | The predicate narrowing is the roadmap's named break risk, and only real SQL can prove it. | Plan |
| Test coverage | Integration lane only, honestly labelled | Ordering against a mocked Supabase would assert nothing; CI's green badge will not cover this. | Plan |

## Scope

**In scope:** the four-key ordering; the taste aggregate; narrowing the exclusion predicate to
likes only; a collector fixture and a deck ordering spec in the integration lane; the post-S-01
judgment reading; reconciling the roadmap and the archived Walk B expectation.

**Out of scope:** any like-count threshold (OQ-2 stays open, still blocking S-03); tag weighting
(OQ-1 stays open); client changes including continuous refill (S-02); schema changes; storing
skips as taste input; surfacing any explanation of ranking; tag backfill.

## Architecture / Approach

One `create or replace function` in a new migration. Taste is a single aggregate — the distinct
union of tags across the collector's liked artworks — and the deck is sorted on four keys:
tagged before untagged, unseen before previously-skipped, tag overlap descending, then
`created_at desc` as the floor. Signature, volatility and `security invoker` are unchanged, so
no TypeScript and no generated types move.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Ranked deck function | The migration: taste aggregate, four-key ordering, narrowed exclusion | The skip tier expressed as a bare boolean cast is null for unseen rows and silently inverts the tier |
| 2. Real-boundary proof | Collector fixture + ordering spec against real Postgres | The lane never runs in CI, so the proof only exists when someone runs it |
| 3. Judgment walk and record | Post-S-01 reading, amended baseline, reconciled roadmap | Answering OQ-4 here changes S-03's scope; leaving it unwritten makes the roadmap stale |

**Prerequisites:** F-01 (`ranking-eval-corpus`) — done and archived. A running local Supabase
stack with seed images uploaded, and `.env.test.local` pointing at loopback, for Phases 2 and 3.

**Estimated effort:** ~2–3 sessions across 3 phases; Phase 1 is small, Phase 2 carries most of
the work, Phase 3 is manual observation plus documentation.

## Open Risks & Assumptions

- **A bad ranking still returns cards.** Getting this wrong is quietly invisible, which is the
  entire reason F-01 built a corpus and a recorded baseline to judge against.
- **The exclusion predicate is the break risk.** Narrowing it to `action = 'like'` is where a
  mistake starts re-serving liked pieces and breaks FR-006.
- **Untagged demotion outranks the skip tier**, so a fresh untagged upload sorts below a piece
  the collector actively skipped. That follows from the chosen rule and is worth confirming at
  review.
- **Assumption to verify in Phase 2:** that a client-side insert honours an explicitly supplied
  `created_at` rather than the `now()` default. `seed.sql` does this, but as superuser.
- **S-02 touches the same function.** Running the two slices in parallel invites an edit
  collision even though neither depends on the other.

## Success Criteria (Summary)

- The warm collector's deck leads with Blue-abstraction pieces, measurably different from the
  recorded baseline where cluster 1 appeared once in eighteen cards.
- No previously-liked piece is ever served again; previously-skipped pieces reappear below all
  fresh matches.
- Untagged pieces sit at the bottom of every deck, by design rather than by accident.
