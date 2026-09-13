# Course-Completion Evidence — Plan Brief

> Full plan: `context/changes/course-completion/plan.md`

## What & Why

ArtSwipe is finished; the evidence for it is not. Five of the six certification criteria in
`PROJECT_PLAN.md` are met and over-met, one — "one E2E test covering the core flow" — has never been
built, and the front door to all of it is still the untouched `create-next-app` README. This change
closes the E2E gap with a real browser test, then writes the two documents that make the project
legible to someone who has never seen it.

## Starting Point

158 commits, 19 PRs, 28 migrations, 14 archived changes each with a plan and a brief, three PRD
generations, 41 test files across three lanes. `README.md` names none of it and points at a file
that does not exist. `PROJECT_PLAN.md` promises "no artist uploads" and "no marketplace" — both
shipped — and describes an `embedding vector` column that was never built. `test-plan.md:144`
records browser coverage as deliberately not planned.

## Desired End State

A reviewer clones the repo and within two minutes knows what ArtSwipe is, how the recommendation and
auction loops work, where each criterion is met, and what to run. Every criterion is genuinely met,
including the E2E one, by a Playwright test that signs a collector up, walks them through
onboarding, has them like five pieces, and asserts the deck that follows is ordered toward what they
liked — verified by watching it go red when the ranking is removed.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| The E2E gap | Close it, don't explain it | Owner's call mid-planning: "we need at least one e2e test before" |
| Which flow | The taste loop | Verbatim the criterion's own wording; exercises the AI logic that makes this non-CRUD |
| Lane execution | Local stack, production build, opt-in | Matches the existing three-lane convention; headless Chromium can't hydrate `next dev` |
| Who writes the test | `/10x-e2e` in Phase 2 | Seed exemplar + named anti-patterns + break-verification beats a hand-rolled spec |
| Why Phase 1 exists | The skill won't install Playwright | Its Setup step 5 stops outright with no config and no spec — both absent here |
| Rubric | The six rows already in `PROJECT_PLAN.md` | The criteria committed to on day one, not a re-derived list |
| README audience | Reviewer first, developer second | Certification mapping goes above setup |
| Delivery story location | `docs/delivery-story.md` | `context/` is Prettier-ignored and reads as agent territory |
| `PROJECT_PLAN.md` | Updated to reality, decision log appended | The drift is the interesting part; erasing it makes the file less true |
| Ordering | Test before docs | The certification table can only claim a test that exists |

## Scope

**In scope:** a fourth Playwright lane; one reviewed, break-verified E2E test; a rewritten README
with a mermaid architecture diagram and the six-row certification mapping; `docs/delivery-story.md`;
`PROJECT_PLAN.md` reconciled; corrections to `test-plan.md` and `data-driven-picker/change.md`; one
new paragraph in `AGENTS.md`.

**Out of scope:** fixing `data-driven-picker` (routed around, not repaired); E2E in CI; a second E2E
test; `storageState` auth fixtures; rewriting `AGENTS.md`; S-06, S-07, or merging S-05 to `main`;
restating `.env.example` or `supabase/seed-assets/README.md`.

## Architecture / Approach

Two movements, strictly ordered. **Phases 1–2** build the lane, then hand test-writing to
`/10x-e2e`. **Phases 3–5** write outward-in: the README a reviewer reads first, the delivery story
it links to, then the founding document reconciled last — by which point the other two have settled
what the shipped product actually is.

The lane is a fourth Vitest-disjoint glob (`test/e2e/**/*.spec.ts`) driven by `playwright.config.ts`,
whose `webServer` runs `npm run build && npm run start` against local Supabase, reusing
`requireLocalRunningStack` from `test/integration/setup.ts` as its `globalSetup` guard.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. The E2E lane | Playwright config, guard, helpers, registered risk | **`.env.local` points at production.** `NEXT_PUBLIC_*` are inlined at build time, so the override must cover `build` as well as `start` or the browser signs real users up on the live project |
| 2. The taste-loop test | One reviewed, break-verified spec | A test that passes because any non-empty deck satisfies it — protecting nothing. The break-verification is the real deliverable |
| 3. The README | Reviewer-first rewrite, diagram, criteria mapping | Claiming a criterion the code doesn't meet; mitigated by ordering Phase 2 first |
| 4. The delivery story | `docs/delivery-story.md` across 14 changes | Inventing or missing changes; every id must resolve under `context/archive/` |
| 5. Reconciliation | `PROJECT_PLAN.md` true again | Erasing the original commitments — the decision log is append-only by instruction |

**Prerequisites:** a running local Supabase stack with `.env.test.local` regenerated;
`npm run db:seed:fetch` done once (~260 MB, gitignored); `npx playwright install chromium`.

**Estimated effort:** ~3 sessions. Phase 1 is fiddly configuration, Phase 2 is a skill-driven loop
plus a deliberate break, Phases 3–5 are one sustained writing pass.

## Open Risks & Assumptions

- **`/10x-e2e` uses Playwright MCP browser tools** to explore the running app. If that MCP server is
  not connected when Phase 2 runs, the skill falls back to its prompt-template path — slower, and
  the generated locators are less likely to be right first time.
- **The taste assertion has to be falsifiable.** With 1000 artworks and only 196 enriched, a deck
  filtered to `figurative`/`realism` may overlap the liked set by coincidence. If the break-verification
  in 2.5 does not go red, the assertion is wrong and must be tightened before the phase closes.
- **The two user-creating lanes share one rate limit.** `[auth.rate_limit] sign_in_sign_ups` is 30 per
  5 minutes per IP, shared by the integration and E2E lanes. Running both in quick succession can
  produce a failure that looks like a bug and is not.
- **`data-driven-picker` stays open.** The E2E test pins two populated terms; a future term change or
  corpus reseed can break it for a reason that has nothing to do with ranking.

## Success Criteria (Summary)

- `npm run test:e2e` passes on a fresh local stack, and goes red when the ranking is removed.
- A reviewer reading `README.md` alone can locate all six criteria and run the project.
- `PROJECT_PLAN.md`, `README.md` and `docs/delivery-story.md` read in sequence without contradiction.
