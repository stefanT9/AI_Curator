---
project: ArtSwipe
version: 1
status: draft
created: 2026-09-10
updated: 2026-09-10
prd_version: 2
main_goal: low-complexity
top_blocker: decisions
---

# Roadmap: ArtSwipe — Recommendation Engine

> Derived from `context/foundation/prd-v2.md` (v2) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

> **A note on requirement IDs.** `prd-v2.md` renders its requirements as `## Scope of Change`
> bullets without `FR-NNN` labels. Its upstream `context/foundation/shape-notes.md` numbers
> the same items, in the same order and with the same text, as `FR-001`–`FR-007`. This roadmap
> cites those IDs so every slice traces back to a specific requirement.

## Vision recap

Every collector is served artworks in the same order today — newest first, with no relationship
to what that collector has liked. The AI enrichment work that shipped before this change left
every artwork carrying normalized, machine-readable tags, so the signal needed to order pieces
per collector already exists and nothing consumes it. This change is the consumer: a
recommendation path that learns from a collector's own likes and orders what they are served by
how well each piece's tags match the tags on the pieces they liked. Personalization is
per-collector throughout — never a global popularity ranking, because everyone seeing the same
feed is the outcome this change exists to avoid.

## North star

**S-01: A collector is served artworks ordered by tag-match to their own likes** — this restates
the PRD's Primary success criterion almost verbatim, and the existing deck query already handles
everything except the ordering itself, so it is the smallest change that proves the idea works.

> "North star" here means the smallest end-to-end slice whose successful delivery would show the
> core product idea holds — placed as early as its Prerequisites allow, because everything else
> on this roadmap only matters if this one works.

## At a glance

| ID   | Change ID                           | Outcome (user can …)                                                              | Prerequisites | PRD refs                                    | Status   |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------- | ------------- | ------------------------------------------- | -------- |
| F-01 | `ranking-eval-corpus`               | (foundation) tag-match ordering can be exercised and judged, not guessed at       | —             | §Constraints, Open Questions 2 and 4        | ready    |
| S-01 | `personalized-deck-ranking`         | be served cards ordered by tag-match to their likes, with passed pieces demoted   | F-01          | US-01, FR-002, FR-003, FR-004, FR-006, OQ-3 | proposed |
| S-02 | `continuous-deck-refill`            | keep swiping past the end of the current cards without hitting a dead end         | —             | US-01, FR-001, FR-007, §Guardrails          | ready    |
| S-03 | `cold-start-and-untagged-placement` | get a deliberate ordering before they have liked much, and where tags are missing | S-01          | FR-005, Open Questions 2 and 4              | blocked  |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme            | Chain                    | Note                                                                                                          |
| ------ | ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A      | Ranking          | `F-01` → `S-01` → `S-03` | The ordering work itself. Ends in the blocked slice, so the stream stalls until OQ-2 and OQ-4 are answered.   |
| B      | Swipe continuity | `S-02`                   | Standalone — no foundation prerequisite, and deliberately ordering-agnostic so it can run alongside Stream A. |

## Baseline

What's already in place in the codebase as of `2026-09-10` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — per `tech-stack.md`: Next.js 16 App Router, React 19, Tailwind v4. Swipe UI is a client component holding a local card stack (`src/components/artworks/SwipeDeck.tsx`).
- **Backend / API:** present — Server Actions for mutations; the deck is served by a Postgres RPC, `swipe_deck` (`supabase/migrations/20260909160200_add_interactions.sql:50-68`).
- **Data:** present — Supabase Postgres. `artworks.tags text[]` with a GIN index (`supabase/migrations/20260909160100_add_artworks.sql:10,29`), app-layer normalized to trimmed/lowercased/deduped. `interactions` table stores one row per (user, artwork) with `action in ('like','skip')` and a unique constraint (`20260909160200_add_interactions.sql:4-14`).
- **Auth:** present — per `tech-stack.md`: Supabase email/password. RLS on `interactions` gates all four policies on `auth.uid() = user_id` (`20260909160200_add_interactions.sql:22-43`).
- **Deploy / infra:** present — per `tech-stack.md`: Vercel, GitHub Actions CI, migrations auto-deploy on merge to `main`.
- **Observability:** absent — `@vercel/analytics` only. No logging library, error tracking, metrics, or `console.*` calls in `src/`.

**Four baseline findings that shrink this roadmap:**

1. **FR-004 is already satisfied.** Likes persist across sessions in `interactions`, and the privacy NFR ("visible only to that collector") is already enforced by RLS.
2. **FR-006 is already satisfied.** `swipe_deck` anti-joins `interactions`, so already-liked pieces are not served again.
3. **Passed artworks are permanently excluded today.** That same anti-join fires on _any_ interaction row. Open Question 3 has since been resolved in the other direction — passed pieces should reappear, demoted — so this is a live behavior the roadmap now changes rather than preserves. See `S-01`.
4. **The real gaps are exactly two.** Ordering is `order by a.created_at desc` (`20260909160200_add_interactions.sql:66`), and the deck is a fixed 20 cards with no refill path — the client renders `EmptyDeck` on exhaustion and only a full page reload produces new cards.

## Foundations

### F-01: Ranking evaluation corpus

- **Outcome:** (foundation) a seeded set of tagged artworks and a collector like-history exists in the development environment, so a tag-match ordering can be exercised and judged rather than guessed at.
- **Change ID:** `ranking-eval-corpus`
- **PRD refs:** `## Constraints & Compatibility` ("Depends on the enrichment work being live: ranking is only meaningful for artworks that carry tags"), Open Questions 2 and 4
- **Unlocks:** S-01 — there is no way to tell whether tag-match ordering beats newest-first without a corpus to order. Also reduces Open Question 2 (how many likes switch ranking on) and Open Question 4 (where untagged pieces sit), by making both observable instead of hypothetical, which is what S-03 needs before it can be planned.
- **Prerequisites:** —
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Deliberately minimal — seed data in the development environment only, no schema change, no production data, no migration. Sequenced first because it is the cheapest way to stop OQ-2 and OQ-4 being argued in the abstract, and because with one user and no tag backfill for pre-enrichment artworks, the live catalogue may be too thin to judge ranking against. The failure mode to watch is scope creep: this must stay a corpus, not become a general fixtures framework.
- **Status:** ready

## Slices

### S-01: Deck ordered by tag-match to the collector's own likes

- **Outcome:** A collector who has liked several pieces is served their next cards ordered by how well each piece's tags match the tags on the pieces they liked, instead of newest-first — and pieces they previously passed on return below all fresh matches, rather than being gone for good.
- **Change ID:** `personalized-deck-ranking`
- **PRD refs:** US-01, FR-002, FR-003, FR-004, FR-006, Open Question 3 (resolved — see below) — (FR-004 and FR-006 are already satisfied by the baseline; this slice consumes both and must leave them intact rather than reimplement them)
- **Prerequisites:** F-01
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:**
  - How are tags weighted when matching? (PRD Open Question 1) — Owner: user. Block: no. The PRD already resolves v1 to unweighted tag-match ("kept for v1; simple tag-match is what ships in three weeks"), so a default exists and planning can proceed on it.
- **Decisions folded in:** Open Question 3 is resolved — passed artworks **reappear, demoted**. The ordering therefore has two tiers: unseen pieces by tag-match first, then previously-passed pieces by tag-match below all of them. Liked pieces never return (FR-006). The "after how long?" half of the question is answered structurally rather than by a timer: a demoted piece surfaces only once fresh matches are exhausted.
- **Risk:** The whole change is the ordering, so getting it wrong is quietly invisible — a bad ranking still returns cards. That is what F-01 is for. This slice also **narrows the existing exclusion predicate**: `swipe_deck` today anti-joins on _any_ `interactions` row, and the demotion decision means it must exclude on `action = 'like'` only. That is a live behavior change, not an addition, and it is the single most likely place to accidentally start re-serving liked pieces and break FR-006. Secondary risk: this slice and S-02 both touch `swipe_deck`, so running them in parallel invites an edit collision in one function even though neither depends on the other.
- **Status:** proposed

### S-02: Deck refills as the collector keeps swiping

- **Outcome:** A collector who swipes past the end of their current cards is served more automatically, with a brief and visibly signposted wait rather than a dead end.
- **Change ID:** `continuous-deck-refill`
- **PRD refs:** US-01, FR-001, FR-007, `## Success Criteria § Guardrails` ("Swiping is never blocked waiting for ordering work; where the collector must wait between batches, the wait is brief and visibly signposted rather than silent")
- **Prerequisites:** —
- **Parallel with:** F-01, S-01
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Genuinely ordering-agnostic, which is why it carries no dependency on S-01: every swiped card writes an `interactions` row and `swipe_deck` anti-joins on it, so a refill is just another call to the same RPC with no cursor to invalidate when S-01 changes the sort key. Cards held in the client stack but not yet swiped are the one overlap case to handle. The part most likely to get quietly skipped is the guardrail — a refill that works but stalls silently satisfies FR-001 and violates the guardrail. Note the interaction with `S-01`: continuous refill against a permanently-excluding deck query would exhaust a small catalogue fast, so if this slice ships before `S-01`'s demotion tier, expect `EmptyDeck` to be reached quickly and do not mistake that for a refill bug.
- **Status:** ready

### S-03: Cold start and untagged pieces sit where they belong

- **Outcome:** A collector who has not liked enough yet, and a catalogue that still contains untagged pieces, both produce a deliberate ordering rather than an accidental one.
- **Change ID:** `cold-start-and-untagged-placement`
- **PRD refs:** FR-005, Open Questions 2 and 4
- **Prerequisites:** S-01
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - How many likes switch ranking on? (PRD Open Question 2) — Owner: user. Block: yes. FR-005 has no acceptance criteria a test can assert until this is a number.
  - Where do untagged artworks sit in the ordering? (PRD Open Question 4) — Owner: user. Block: yes. There is no tag backfill for pre-enrichment artworks, so this is a live population, not an edge case.
- **Risk:** Split out from S-01 precisely because it is the blocked half — S-01 can ship with a naive fallback (a collector with no likes scores zero against everything and lands back on newest-first), while this slice makes that behavior deliberate and testable. Sequencing it inside S-01 instead would have blocked the north star on two decisions that do not actually gate it. The risk in deferring is that "accidentally correct" fallback behavior is mistaken for designed behavior and never revisited.
- **Status:** blocked

## Backlog Handoff

| Roadmap ID | Change ID                           | Suggested issue title                                                                  | Ready for `/10x-plan` | Notes                                                            |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| F-01       | `ranking-eval-corpus`               | Seed a tagged-artwork corpus and like history for ranking work                         | yes                   | Run `/10x-plan ranking-eval-corpus`                              |
| S-01       | `personalized-deck-ranking`         | Order the swipe deck by tag-match to the collector's own likes, demoting passed pieces | no                    | Needs F-01 first, to have anything to judge the ordering against |
| S-02       | `continuous-deck-refill`            | Refill the swipe deck automatically as the collector swipes                            | yes                   | Run `/10x-plan continuous-deck-refill`                           |
| S-03       | `cold-start-and-untagged-placement` | Define cold-start fallback and untagged-artwork placement                              | no                    | Blocked on Open Questions 2 and 4                                |

## Open Roadmap Questions

1. **How are tags weighted when matching?** Raw overlap treats every tag as equally important, so "blue" weighs the same as "oil-on-canvas". — Owner: user. Block: none — held as a non-blocking Unknown on `S-01`; the PRD's stated v1 answer (unweighted tag-match) is a usable default.
2. **How many likes switch ranking on?** FR-005 falls back to the existing ordering until a collector has liked "enough"; the threshold is undefined. — Owner: user. Block: `S-03`.
3. ~~**Do artworks a collector passed on reappear, and after how long?**~~ — **RESOLVED 2026-09-10 by the user: they reappear, but at lower priority.** Recorded as a two-tier ordering in `S-01` (unseen by tag-match, then previously-passed by tag-match). This is a change to live behavior, not a confirmation of it — `swipe_deck` currently excludes passed artworks permanently, so the exclusion predicate must narrow to `action = 'like'`. Note this decision is not yet reflected in `prd-v2.md`, whose FR-006 still reads "Whether artworks they passed on reappear is unresolved."
4. **Where do untagged artworks sit in the ordering?** No backfill exists for pre-enrichment artworks, so untagged pieces are a real population. — Owner: user. Block: `S-03`.
5. **Two Scope-of-Change items are untestable as written.** Carried from the PRD: the cold-start item depends on Question 2 and the already-liked/passed item on Question 3. — Owner: user. Block: half closed — Question 3 is now decided, so the already-liked/passed item is testable; only the cold-start item remains, held in `S-03` pending Question 2.

## Parked

- **Collector-facing controls over ranking** (filters, "show me more like this", tuning, resetting learned taste) — Why parked: `prd-v2.md` §Non-Goals — ranking is invisible and automatic in v1; controls are a whole product surface of their own.
- **Explanation of why a piece was served** (match score, "because you liked X") — Why parked: `prd-v2.md` §Non-Goals — explanation implies a defensible scoring model that does not exist yet.
- **Any change to the artist side** (visibility into ranking, analytics, influence over placement) — Why parked: `prd-v2.md` §Non-Goals — the artist is a secondary beneficiary, not a participant.
- **Cross-collector or popularity signal** — Why parked: `prd-v2.md` §Non-Goals — everyone's feed looking the same is the outcome this change exists to avoid. Note the PRD narrows this to _this change only_; a future blend is left open rather than ruled out.
- **Migration or backfill of historical likes** — Why parked: `prd-v2.md` §Non-Goals and §Constraints — preference collection starts fresh; backfill is separable work.
- **Storage of passes as preference signal** — Why parked: `prd-v2.md` §Non-Goals — a pass is ambiguous. Note that passes _are_ already stored as `action = 'skip'`; the Non-Goal binds their use as taste input, not their existence.
- **Retro-tagging of pre-enrichment artworks** — Why parked: carried from the v1 enrichment PRD's Non-Goals as a separable batch job. Surfaces here because it is the underlying cause of Open Question 4; F-01 works around it rather than solving it.
- **Observability instrumentation** (logging, error tracking, metrics) — Why parked: the baseline reports it absent, but no PRD guardrail or NFR gates this change on it, and `main_goal: low-complexity` says do not add a layer nothing is asking for.

## Done

_(Empty on first generation. `/10x-archive` appends entries here.)_
