---
project: ArtSwipe
version: 1
status: draft
created: 2026-09-10
updated: 2026-09-10
prd_version: 2
main_goal: low-complexity
top_blocker: none
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

| ID   | Change ID                           | Outcome (user can …)                                                                           | Prerequisites | PRD refs                                        | Status     |
| ---- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------- | ---------- |
| F-01 | `ranking-eval-corpus`               | (foundation) tag-match ordering can be exercised and judged, not guessed at                    | —             | §Constraints, Open Questions 2 and 4            | done       |
| F-02 | `real-artwork-corpus`                | (foundation) ranking is judged against 1000 real sampled artworks, not four designed clusters   | F-01          | §Constraints, Open Question 1                   | done       |
| S-01 | `personalized-deck-ranking`         | be served cards ordered by tag-match to their likes, with passed pieces demoted                | F-01          | US-01, FR-002, FR-003, FR-004, FR-006, OQ-3     | done       |
| S-02 | `continuous-deck-refill`            | keep swiping past the end of the current cards without hitting a dead end                      | —             | US-01, FR-001, FR-007, §Guardrails              | ready      |
| S-03 | `cold-start-and-untagged-placement` | get a deliberate ordering before they have liked much, and where tags are missing              | S-01          | FR-005, Open Question 2                         | superseded |
| S-04 | `add-onboarding-flow-for-collector` | be walked through a first-run flow that leaves them holding real likes before their first deck | S-01          | FR-005, §Non-Goals, Open Question 2 (dissolved) | done       |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme            | Chain                    | Note                                                                                                                                                               |
| ------ | ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A      | Ranking          | `F-01` → `S-01` → `S-04` | The ordering work itself. No longer stalls: `S-04` dissolved OQ-2 instead of answering it, which superseded `S-03` (OQ-4 had already been answered inside `S-01`). |
| B      | Swipe continuity | `S-02`                   | Standalone — no foundation prerequisite, and deliberately ordering-agnostic so it can run alongside Stream A.                                                      |

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
- **Status:** done

### F-02: Real sampled artwork corpus

> Added 2026-09-10. Not in the original slice set — it was planned directly as
> `real-artwork-corpus` and is recorded here after the fact, because it removes a limitation
> `F-01` declared about itself.

- **Outcome:** (foundation) the ranking-evaluation corpus is 1000 real public-domain artworks sampled from the Art Institute of Chicago, tagged from museum metadata plus the live enrichment pipeline, so ranking is judged against a realistic tag distribution instead of four designed clusters.
- **Change ID:** `real-artwork-corpus`
- **PRD refs:** `## Constraints & Compatibility` (ranking is only meaningful for artworks that carry tags), Open Question 1
- **Prerequisites:** F-01 — this replaces the corpus F-01 delivered; the mechanism (a `seed.sql` applied by `supabase db reset`) is unchanged.
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:** —
- **Decisions folded in:**
  - **It closes the off-vocabulary starter-pool defect.** F-01's hand-authored tags were largely outside `src/lib/ai/taxonomy.ts`, so 17 of 20 onboarding style pickers returned an empty starter pool. Corpus tags are now vocabulary-constrained by construction, from both sources.
  - **Open Question 1 (how tags are weighted when matching) is now answerable against real data.** Raw overlap over four uniform clusters could only show that ranking discriminates; over a real distribution — 20 populated terms with counts spanning 1 to 132 — the question of whether `oil painting` should weigh the same as `figurative` has evidence behind it. The question stays open; what changed is that it can now be settled by measurement rather than argument. The instrument is `context/changes/real-artwork-corpus/judgment.md`.
  - **The corpus is generated from a committed manifest, not hand-authored.** `supabase/seed-assets/corpus.json` is the durable artifact; everything below the marker in `seed.sql` is written by `npm run db:seed:generate`. The images (~260 MB) are gitignored and fetched by `npm run db:seed:fetch` — a one-time step every existing clone must run before its next `db:reset`.
  - **Curatorial tag overrides were considered and dropped.** The picker will instead offer only terms with artworks behind them, computed from the catalogue, as a separate application-code change. A 19th-century CC0 collection genuinely lacks `street art` and `psychedelic`, and a brand-new production deployment hits the same empty-pool bug whatever the seed contains — so the picker, not the seed data, is where the fix belongs.
- **Residual — two kinds of uncovered term, and they are not the same thing.** `npm run db:seed:coverage` reports **67 of 100 taxonomy terms** covered. Style and mood gaps (`street art` at 1 piece; `psychedelic`, `pop art`, `cubist`, `art deco`, `brutalist`, `hyperrealism`, `naive` at none) are facts about public-domain art and will narrow as enrichment resumes — **196 of 1000 pieces are enriched at time of writing**, with the remainder driven manually via `npm run db:seed:enrich:resume` / `:retry`. But **13 of 20 palette terms are unreachable by construction**: `paletteTags` in `scripts/build-corpus.ts` derives palette from the museum's HSL reading and emits only eight terms, and enrichment's palette suggestions are deliberately discarded in its favour. That is a design consequence of our own mapper, not a property of the collection — the data-driven picker change must not treat the two categories as one.
- **Risk:** The branch is non-functional for local dev between its first and fourth phases — the placeholder PNGs are deleted before `seed.sql` is regenerated — so those phases land together. Beyond that the risk profile is F-01's: development-environment seed data only, no schema change, no production data, no migration.
- **Status:** done

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
- **Decisions folded in:** Open Question 4 is resolved — untagged artworks sit **below every tagged piece**, including previously-passed ones. Decided inside this slice rather than deferred to S-03 because the ordering has to place them somewhere: any sort key that scores tag overlap already puts untagged pieces at zero, so leaving the question open would have shipped an accidental placement and called it a fallback. Demoting them explicitly costs one outermost sort key and makes the placement assertable. This is what narrows S-03 to OQ-2 alone. Open Question 3 is resolved — passed artworks **reappear, demoted**. The ordering therefore has two tiers: unseen pieces by tag-match first, then previously-passed pieces by tag-match below all of them. Liked pieces never return (FR-006). The "after how long?" half of the question is answered structurally rather than by a timer: a demoted piece surfaces only once fresh matches are exhausted.
- **Risk:** The whole change is the ordering, so getting it wrong is quietly invisible — a bad ranking still returns cards. That is what F-01 is for. This slice also **narrows the existing exclusion predicate**: `swipe_deck` today anti-joins on _any_ `interactions` row, and the demotion decision means it must exclude on `action = 'like'` only. That is a live behavior change, not an addition, and it is the single most likely place to accidentally start re-serving liked pieces and break FR-006. Secondary risk: this slice and S-02 both touch `swipe_deck`, so running them in parallel invites an edit collision in one function even though neither depends on the other.
- **Status:** done

### S-02: Deck refills as the collector keeps swiping

- **Outcome:** A collector who swipes past the end of their current cards is served more automatically, with a brief and visibly signposted wait rather than a dead end.
- **Change ID:** `continuous-deck-refill`
- **PRD refs:** US-01, FR-001, FR-007, `## Success Criteria § Guardrails` ("Swiping is never blocked waiting for ordering work; where the collector must wait between batches, the wait is brief and visibly signposted rather than silent")
- **Prerequisites:** —
- **Parallel with:** F-01, S-01
- **Blockers:** —
- **Unknowns:** —
- **Known defect this slice must fix (found 2026-09-10 during S-01's judgment walk):** the deck prop can be swapped underneath the client's cursor. `SwipeDeck.tsx:17` keeps `index` in client state and reads `deck[index]` from a prop; `recordInteraction` calls the cookie-aware server Supabase client, which writes cookies when Supabase rotates the session, and per `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md:510` a Server Action that sets a cookie makes Next re-render the current page and its layouts — client state preserved (`:512`). `/discover` is `force-dynamic`, so `getSwipeDeck()` re-runs and a freshly ranked array arrives while `index` still counts against the old one, landing the collector on an unrelated card. Intermittent: only when the session cookie actually rotates. Latent before S-01 (the anti-join dropped every interacted piece, so a refetch looked like "the remainder"); S-01's demotion tier keeps skipped pieces in the array, so a stale index can now resurface something already passed. Candidate fixes: key client state to artwork id rather than ordinal, or freeze the deck in client state on mount. Diagnosed from the docs and code, not reproduced in a browser.
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
  - ~~How many likes switch ranking on? (PRD Open Question 2)~~ — **Dissolved 2026-09-10 by `S-04`,** not answered. See below.
  - ~~Where do untagged artworks sit in the ordering? (PRD Open Question 4)~~ — **Answered 2026-09-10 inside S-01:** untagged pieces sort below every tagged piece, including previously-passed ones. Nothing left for this slice to decide; it inherits the placement.
- **Risk:** Split out from S-01 precisely because it is the blocked half — S-01 can ship with a naive fallback (a collector with no likes scores zero against everything and lands back on newest-first), while this slice makes that behavior deliberate and testable. Sequencing it inside S-01 instead would have blocked the north star on two decisions that do not actually gate it. The risk in deferring is that "accidentally correct" fallback behavior is mistaken for designed behavior and never revisited.
- **Status:** superseded by `S-04` (2026-09-10)

  > **Superseded 2026-09-10 by `S-04: add-onboarding-flow-for-collector`.** Both
  > halves of this slice are now closed elsewhere, so nothing is left for it to
  > decide and it is not worth planning.
  >
  > The untagged half was answered inside `S-01` (Open Question 4 above). The
  > cold-start half was **dissolved rather than answered** by `S-04`. Open Question 2
  > asked how many likes switch ranking on; it presumed a population of collectors
  > sitting below the threshold, and `S-04`'s mandatory first-run gate removes that
  > population. A collector cannot reach `/discover` without passing through the
  > flow, and the flow ends only when they have liked `ONBOARDING_LIKE_TARGET`
  > (currently 5, in `src/lib/onboarding/config.ts`) pieces or exhausted the starter
  > pool.
  >
  > **`ONBOARDING_LIKE_TARGET` is the number that replaces the threshold** — but it
  > is a different kind of number. The threshold would have been a condition
  > `swipe_deck` tested before deciding whether to rank; the target is a stopping
  > condition for the onboarding loop. `swipe_deck` is unchanged and still tests
  > nothing: it ranks on whatever likes exist, which is now never zero for a
  > collector who liked anything during onboarding.
  >
  > **What this slice worried about still exists, in one branch.** A collector who
  > skips every starter piece, or picks terms matching no artwork, is released with
  > `onboarded_at` stamped and zero likes, and lands on the newest-first deck. The
  > unranked ordering therefore survives exactly as this slice's Risk note described
  > it — an accidental fallback presented as a deliberate one — but it is now an
  > exhaustion release reached by choice, not the default first experience of every
  > new account. If that branch ever needs deliberate ordering of its own, open a new
  > slice against it rather than reviving this one.

### S-04: A collector arrives at their first deck already holding likes

> Added 2026-09-10. Not in the original slice set — it was planned directly as
> `add-onboarding-flow-for-collector` and is recorded here after the fact, because it is
> what closed `S-03` and Open Question 2.

- **Outcome:** A brand-new collector cannot reach the app until they have picked 2–4 style terms and rated a starter set built from them, so their first `/discover` deck is genuinely ranked rather than newest-first.
- **Change ID:** `add-onboarding-flow-for-collector`
- **PRD refs:** FR-005, `## Non-Goals` ("no collector-facing controls over ranking" — amended with a carve-out for first-run term selection), `## Constraints & Compatibility` (amended), Open Question 2 (dissolved)
- **Prerequisites:** S-01 — the flow exists to feed the ranking function, so there has to be one.
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:** —
- **Decisions folded in:** Open Question 2 is dissolved, not answered — see `S-03` above. The chosen style terms are **transient**: never persisted, discarded once the starter pool is built, so no preference table and no facet column. `onboarded_at` is nullable with no backfill, so every pre-existing account is routed through the flow. The gate lives in `(app)/layout.tsx` via `requireOnboarded()`, not in `src/proxy.ts` — the proxy redirect is optimistic and bypassable.
- **Risk:** The gate is a trap door. Wiring `requireOnboarded` into the authenticated layout before the flow that satisfies it exists locks every account, including the dev user, out of the whole segment with no escape — which is why the plan sequenced the gate last among functional phases. The second risk is starvation: a collector who skips everything must still be released with `onboarded_at` stamped and zero likes. Treating pool exhaustion as an error reintroduces the lockout.
- **Status:** done

## Backlog Handoff

| Roadmap ID | Change ID                           | Suggested issue title                                                                  | Ready for `/10x-plan` | Notes                                                                                |
| ---------- | ----------------------------------- | -------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ |
| F-01       | `ranking-eval-corpus`               | Seed a tagged-artwork corpus and like history for ranking work                         | yes                   | Run `/10x-plan ranking-eval-corpus`                                                  |
| S-01       | `personalized-deck-ranking`         | Order the swipe deck by tag-match to the collector's own likes, demoting passed pieces | done                  | Shipped — F-01 delivered the corpus it was judged against                            |
| F-02       | `real-artwork-corpus`               | Replace the synthetic corpus with 1000 real public-domain artworks                     | done                  | Shipped — closed the off-vocabulary starter-pool defect; OQ-1 now answerable on real data |
| S-02       | `continuous-deck-refill`            | Refill the swipe deck automatically as the collector swipes                            | yes                   | Run `/10x-plan continuous-deck-refill`                                               |
| S-03       | `cold-start-and-untagged-placement` | Define the cold-start fallback (untagged placement settled by S-01)                    | superseded            | Nothing left to decide — OQ-4 answered in S-01, OQ-2 dissolved by S-04. Do not plan. |
| S-04       | `add-onboarding-flow-for-collector` | Gate first run behind a style picker and starter deck so the first real deck is ranked | done                  | Shipped — dissolved OQ-2 and superseded S-03                                         |

## Open Roadmap Questions

1. **How are tags weighted when matching?** Raw overlap treats every tag as equally important, so "blue" weighs the same as "oil-on-canvas". — Owner: user. Block: none — held as a non-blocking Unknown on `S-01`; the PRD's stated v1 answer (unweighted tag-match) is a usable default. **Now answerable on real data, 2026-09-10 by `F-02` (`real-artwork-corpus`) — still open, but no longer arguable only in the abstract.** The corpus is 1000 sampled public-domain pieces whose 20 populated style terms range from 1 to 132 members, so the cost of weighting `oil painting` like `figurative` can be measured by swiping rather than reasoned about. The instrument is `context/changes/real-artwork-corpus/judgment.md`.
2. ~~**How many likes switch ranking on?**~~ — **DISSOLVED 2026-09-10 by `S-04` (`add-onboarding-flow-for-collector`), not answered.** The question presumed collectors sitting below a threshold; the mandatory first-run gate removes that population, so there is no threshold for `swipe_deck` to test and it was never changed. The number that replaces it is `ONBOARDING_LIKE_TARGET` (currently 5, `src/lib/onboarding/config.ts`) — a stopping condition for the onboarding loop, not a switch on ranking. The unranked ordering survives only as the exhaustion release for a collector who skipped every starter piece. Block: none — this was `S-03`'s last blocker, and `S-03` is superseded.
3. ~~**Do artworks a collector passed on reappear, and after how long?**~~ — **RESOLVED 2026-09-10 by the user: they reappear, but at lower priority.** Recorded as a two-tier ordering in `S-01` (unseen by tag-match, then previously-passed by tag-match). This is a change to live behavior, not a confirmation of it — `swipe_deck` currently excludes passed artworks permanently, so the exclusion predicate must narrow to `action = 'like'`. Note this decision is not yet reflected in `prd-v2.md`, whose FR-006 still reads "Whether artworks they passed on reappear is unresolved."
4. ~~**Where do untagged artworks sit in the ordering?**~~ — **RESOLVED 2026-09-10 inside `S-01` (`personalized-deck-ranking`): untagged artworks sort below every tagged piece, including previously-passed ones.** Rationale: the tag-overlap sort key already scores an untagged piece at zero, so the placement existed whether or not anyone decided it — the choice was between an explicit, assertable demotion and an accidental one. Demotion is the outermost key of the four-key sort, so it holds for every collector, cold or warm. Cost: it changes the cold-start deck, so the archived Walk B expectation in `context/archive/2026-09-10-ranking-eval-corpus/judgment.md` was amended (tagged newest-first, untagged tail) rather than preserved. No backfill exists for pre-enrichment artworks, so this remains a real population — but it now has a defined home. Block: none — `S-03` no longer waits on this.
5. ~~**Two Scope-of-Change items are untestable as written.**~~ — **CLOSED 2026-09-10.** Carried from the PRD: the cold-start item depended on Question 2 and the already-liked/passed item on Question 3. Question 3 was decided inside `S-01`, making the already-liked/passed item testable. Question 2 was dissolved by `S-04`, which gives the cold-start item concrete criteria at last — not a like threshold, but the two flow exits: a collector reaching `ONBOARDING_LIKE_TARGET` gets a ranked deck, and one who skips everything gets newest-first. Both are assertable. Block: none.

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

- **F-01: (foundation) a seeded set of tagged artworks and a collector like-history exists in the development environment, so a tag-match ordering can be exercised and judged rather than guessed at.** — Archived 2026-09-10 → `context/archive/2026-09-10-ranking-eval-corpus/`. Lesson: —.
- **S-01: A collector who has liked several pieces is served their next cards ordered by how well each piece's tags match the tags on the pieces they liked, instead of newest-first — and pieces they previously passed on return below all fresh matches, rather than being gone for good.** — Archived 2026-09-10 → `context/archive/2026-09-10-personalized-deck-ranking/`. Lesson: —.
- **S-04: A new collector is walked through a first-run flow — pick 2–4 style terms, rate a starter set built from them — so they reach `/discover` already holding likes and their first deck is genuinely ranked.** — Archived 2026-09-10 → `context/archive/2026-09-10-add-onboarding-flow-for-collector/`. Dissolved Open Question 2 and superseded `S-03`. Lesson: —.
