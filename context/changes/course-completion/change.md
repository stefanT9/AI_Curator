---
change_id: course-completion
title: Course-completion evidence — the missing E2E test, a real README, and the delivery story
status: implemented
created: 2026-09-13
updated: 2026-09-13
archived_at: null
---

## Notes

Closes out the project against the six certification criteria recorded in `PROJECT_PLAN.md`
(§Certification requirements mapping, 10xDevs 4.0). Five of the six are met and over-met; one —
"one E2E test covering the core flow" — has never been built, and the repo's own
`context/foundation/test-plan.md:144` records browser coverage as deliberately **not planned**.

Scope was widened during planning, on the owner's call: the first framing was documentation only,
and the answer to "how should the docs handle the missing E2E test?" was *"we need at least one
e2e test before"*. So this change ships a fourth test lane and one real browser test, then writes
the documents.

### Owner's decisions, taken during planning (2026-09-13)

- **Audience:** README is written reviewer-first, developer-second — what ArtSwipe is and where the
  criteria are met, then setup.
- **Rubric:** the six rows already in `PROJECT_PLAN.md`. Not a re-derived list.
- **The E2E gap gets closed, not explained.** One test, covering the taste loop — verbatim the
  criterion's own wording ("user likes 5 pieces, 6th recommendation matches").
- **Lane:** local Supabase + a production build, opt-in like `test:integration` and `test:smoke`.
  Not in CI.
- **Delivery story** lives at `docs/delivery-story.md` — a new root `docs/`, not under `context/`,
  because `context/` is Prettier-ignored and reads as agent-workflow territory.
- **`PROJECT_PLAN.md` gets updated to match reality** rather than frozen as a historical artifact.
- **README carries a flow diagram plus a load-bearing-decision table**, with depth deferred to the
  delivery story.

### Two verified facts that shape the plan

1. **`/10x-e2e` will not install Playwright.** Its Setup step 5 stops outright when there is no
   `playwright.config.*` and no `*.spec.ts` — and this repo has neither. The lane must exist before
   the skill can be invoked, which is why Phase 1 is infrastructure and Phase 2 is the test.
2. **Style-term coverage is much better than the `data-driven-picker` note claims, but still
   uneven.** That note (2026-09-10) says "17 of 20 terms are empty". Counted against
   `supabase/seed-assets/corpus.json` on 2026-09-13, 13 of 20 are populated and 7 are empty:

   | populated | count | | empty |
   | --- | --- | --- | --- |
   | figurative | 88 | | hyperrealism, cubist, pop art, |
   | realism | 55 | | art deco, brutalist, naive, |
   | illustrative | 39 | | psychedelic |
   | geometric / folk art | 17 each | | |
   | abstract | 15 | | |
   | art nouveau | 10 | | |
   | expressionist / gestural | 5 each | | |
   | impressionist | 4 | | |
   | minimalist | 3 | | |
   | surrealist / street art | 1 each | | |

   Only 196 of the 1000 corpus rows are enriched, which is where nearly all style tags come from.
   The E2E test must pin `figurative` + `realism` — picking any of the seven empty terms lands on
   the onboarding exhaustion path and fails red for the wrong reason. `data-driven-picker` stays
   open and unplanned; this change does not fix it, it routes around it deliberately.
