# Frame Brief: Add onboarding flow for collector

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

**None was stated.** The change arrived as a title — "Add onboarding flow for
collector" — with an empty `change.md` and no symptom, complaint, or metric
attached. This is recorded as-is because it is load-bearing: the change was
conceived as a solution, and the problem half had to be established during
framing rather than challenged.

Under questioning, the nearest thing to an observation was: *a brand-new
collector arrives with no taste signal, and the recommendation engine has
nothing to work with in their session.*

## Initial Framing (preserved)

- **User's stated cause or approach**: Not stated explicitly. Implied — new
  collectors need an onboarding flow that the product currently lacks.
- **User's proposed direction**: Add one, covering two surfaces selected during
  research: taste bootstrap (cold start) and first-run orientation.
- **Pre-dispatch narrowing**:
  - _Trigger_: "Product-completeness instinct" **and** "Ranking has nothing to
    work with". Explicitly **not** comprehension ("a new collector wouldn't
    understand it") and **not** the dead-end after 20 cards.
  - _Audience_: "A course grader / demo viewer" — someone opening the app once
    to evaluate it. Not a future public user, not the developer testing.
  - _Scope_: "Two independent concerns" — seeding the recommender and
    explaining the UI share only a trigger and could ship separately.

## Dimension Map

The observation could originate at any of these dimensions:

1. **Signal acquisition** — assumes a collector's taste signal must be
   gathered explicitly, up front, because swiping alone starts empty. ← initial framing
2. **Signal sufficiency** — assumes the "no signal" state persists long enough
   to matter. If ranking switches on after a handful of likes, a grader crosses
   that threshold in seconds and cold start is a non-event.
3. **Ranking consumption** — assumes something exists that would consume the
   seeded signal and turn it into a different ordering.
4. **Demo legibility** — assumes a single session can make personalization
   *perceptible* at all, regardless of how good the underlying ordering is.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **D3: No consumer exists for the signal** | No ranking implementation anywhere in the repo — verified across `main` and all 13 local/remote branches. The only `rank` identifier in `src/` is an unrelated sort-order map at [queries.ts:116](src/lib/artworks/queries.ts#L116). `swipe_deck` is defined exactly once and orders `by a.created_at desc` ([20260909160200_add_interactions.sql:66](supabase/migrations/20260909160200_add_interactions.sql#L66)). Slice `S-01: personalized-deck-ranking` status `proposed` ([roadmap.md:49](context/foundation/roadmap.md#L49)) — never planned, never built. | **STRONG** |
| **D1: Signal must be gathered up front** (initial framing) | The premise is factually true — a new collector has zero `interactions` rows and the deck's anti-join is vacuous for them ([research.md §1](context/changes/add-onboarding-flow-for-collector/research.md)). But `interactions` cannot store a facet preference (`artwork_id not null`, `action in ('like','skip')`, [20260909160200_add_interactions.sql:4-14](supabase/migrations/20260909160200_add_interactions.sql#L4-L14)), and four recorded PRD positions contradict seeding taste from anything but likes ([prd-v2.md:87,111,114,131](context/foundation/prd-v2.md#L111)). True premise, but it describes an input to a system that does not exist. | **WEAK** |
| **D2: The no-signal state persists long enough to matter** | Undecidable on current evidence. PRD Open Question 2 — "How many likes switch ranking on?" — is unanswered and recorded as **blocking** `S-03` ([roadmap.md:150](context/foundation/roadmap.md#L150)). Whether cold start lasts 3 swipes or 30 is precisely the undecided quantity. | **NONE** (undecidable) |
| **D4: A first session cannot show personalization** | Partial. No explanation of why a piece was served is permitted ([prd-v2.md:132](context/foundation/prd-v2.md#L132), Non-Goal); the deck is a fixed 20 cards with no refill and `EmptyDeck` falsely claims the catalogue is exhausted ([SwipeDeck.tsx:169-182](src/components/artworks/SwipeDeck.tsx#L169-L182)); `/discover` renders identical static copy for every user ([discover/page.tsx:21-23](<src/app/(app)/discover/page.tsx#L21-L23>)). A grader has no affordance for perceiving an ordering change. Real, but downstream of D3. | **PARTIAL** |

## Narrowing Signals

- **The decisive one.** Asked what they believed the swipe deck did today, the
  user answered: *"Assumed ranking was live — I thought tag-match ordering had
  already shipped with the enrichment work, and that a new collector was the one
  case it couldn't serve."* The entire framing rested on this premise, and it is
  false. Cold start was conceived as the residual gap in a working recommender;
  there is no recommender.
- **Audience is a grader, not a returning user.** This rules out the
  accumulate-taste-across-sessions rationale entirely — a grader has exactly one
  session, so "preferences accumulate" has no time to pay off.
- **Trigger excludes comprehension.** The user did not select "a new collector
  wouldn't understand it", which removes the usual justification for a first-run
  tutorial and leaves the orientation half resting on completeness alone.
- **User holds both payoffs equally** — "the feed adapted to me" *and* "this is a
  finished product". So demo legibility is not dismissed by the reframe; it is
  sequenced behind the thing that makes it true.

## Cross-System Convention

This project's own convention is explicit and was written **before this change
existed**, which makes it independent evidence rather than hindsight:

- The roadmap already contains a cold-start slice — `S-03:
  cold-start-and-untagged-placement` — with **Prerequisites: S-01**
  ([roadmap.md:129](context/foundation/roadmap.md#L129)).
- It states the reason for the split: *"S-01 can ship with a naive fallback (a
  collector with no likes scores zero against everything and lands back on
  newest-first), while this slice makes that behavior deliberate and testable…
  Sequencing it inside S-01 instead would have blocked the north star on two
  decisions that do not actually gate it."*
  ([roadmap.md:135](context/foundation/roadmap.md#L135))
- The archived judgment walkthrough records the cold deck as deliberately
  unchanged across S-01: *"With no likes there is nothing to match on, so the
  cold-start deck should stay newest-first and **not change**."*
  ([judgment.md:52-54](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L52-L54))

Three documents, none aware of this change, place cold-start work strictly after
ranking exists. The leading hypothesis matches the convention exactly.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: the product's core thesis —
> personalized, tag-matched discovery — is not built at all, so a grader's single
> session cannot demonstrate it; "the new collector has no signal" is a
> downstream symptom of that, not an independent problem.

The initial framing assumed ranking was live and that cold start was the one case
it failed to serve. Ranking does not exist. Taste bootstrap would therefore seed a
carefully-designed preference signal into a system with no consumer — the deck
would still return `created_at desc`, and the grader would see no difference
whatsoever. Building `S-01` is what makes the collector's likes matter; only then
does the question "what about a collector who has none yet" have observable
stakes, which is exactly where the roadmap already puts it (`S-03`).

Two corollaries worth carrying into planning:

- **The taste-bootstrap half is `S-03` re-opened out of sequence, under a new
  name.** Its own blocker (Open Question 2, the like threshold) is a question
  onboarding would *dissolve* rather than answer — which is a genuinely useful
  idea, but it is a roadmap-level decision about `S-03`, not a new change.
- **The first-run orientation half survives the reframe intact.** The user
  classified the two surfaces as independent, and orientation depends on no
  ranking. It is small, unblocked, and carries no PRD conflicts — but note that
  its most concrete defect (the false "You've seen everything in the catalog"
  after 20 cards) is already owned by `S-02: continuous-deck-refill`, status
  `ready` ([roadmap.md:112-122](context/foundation/roadmap.md#L112-L122)).

## Confidence

**HIGH** — strong evidence (no ranking code on any branch), matches convention
(three independent documents sequence cold start after S-01), and a decisive
narrowing signal (the user's stated premise that ranking was already live is
verifiably false).

## What Changes for /10x-plan

Do not plan this change as written. The taste-bootstrap half should be returned to
the roadmap as a question about `S-03`'s framing — specifically, whether
onboarding replaces the like-threshold answer to Open Question 2 — and taken up
after `S-01: personalized-deck-ranking` ships. If planning proceeds now, the
candidates that actually serve the stated goal ("the feed adapted to me" for a
one-session grader) are `S-01`, then `S-02`. The first-run orientation half can be
planned independently at any time, but should be scoped against `S-02` first to
avoid solving the same `EmptyDeck` defect twice.

## References

- Source files: [queries.ts:116](src/lib/artworks/queries.ts#L116),
  [20260909160200_add_interactions.sql:4-14,66](supabase/migrations/20260909160200_add_interactions.sql#L4-L14),
  [SwipeDeck.tsx:169-182](src/components/artworks/SwipeDeck.tsx#L169-L182),
  [discover/page.tsx:21-23](<src/app/(app)/discover/page.tsx#L21-L23>)
- Decision record: [roadmap.md:49,112-122,129,135,150](context/foundation/roadmap.md#L129),
  [prd-v2.md:87,111,114,131-132](context/foundation/prd-v2.md#L111),
  [judgment.md:52-54](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L52-L54)
- Related research: `context/changes/add-onboarding-flow-for-collector/research.md`
- Investigation tasks: none — `TaskCreate` is unavailable in this environment;
  dimensions 3 and 4 were verified inline (branch-wide grep for ranking code,
  cross-document sequencing check) rather than via sub-agents.
