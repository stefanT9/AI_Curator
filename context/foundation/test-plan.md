# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-09-10

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the risk wins. Do not promote to e2e because e2e "feels safer." Do not put a vision model on top of a deterministic visual diff that already catches the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team is worried about X, and the failure would surface somewhere in this area" carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents _what could fail_ and _why we believe it's likely_ — drawn from documents, interview, and codebase _signal_ (churn, structure, test base). It does NOT claim to know which line owns the failure. That knowledge is produced by `/10x-research` during each rollout phase. If the plan and research disagree about where the failure lives, research is the ground truth.

A fourth principle is specific to this rollout, and it comes from the Phase 2 interview: **this project's existing suite mocks Supabase at every seam, and every top risk below lives at the database or storage boundary.** Adding more mocked unit tests would raise coverage and prove nothing about any of them. The centre of gravity of this rollout is therefore establishing real-boundary lanes, not extending the mocked one. Phases 1–3 each require amending the `AGENTS.md` rule that states Supabase is never hit for real; that is a deliberate convention change, not an oversight, and it lands explicitly in Phase 1.

Hot-spot scope used for likelihood weighting: `src/`, `supabase/migrations/`.

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by risk = impact × likelihood. Risks are failure scenarios in user / business terms, not test names. The Source column cites the _evidence that surfaced this risk_ — never a specific file as "where the failure lives" (that is research's job, see §1 principle #3).

| #   | Risk (failure scenario)                                                                                                                                                 | Impact | Likelihood | Source (evidence — not anchor)                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An artwork is published whose stored image key resolves to nothing — the card renders broken for every collector, and the artist's piece is effectively lost            | High   | High       | interview Q1; interview Q3; hot-spot dir `src/app/actions/` (8 commits/30d, holds the single top-churn file); an upload fix landed on `main` the day before this plan |
| 2   | Published artworks are never served to any collector — they exist in the artist's studio but no feed ever reaches them                                                  | High   | High       | interview Q1; `prd-v2.md` §Scope of Change (continuous refill) and §Open Questions 4 (untagged placement); `roadmap.md` §Slices S-02, S-03                            |
| 3   | A signed-in user reads or writes rows belonging to someone else — most sharply, one collector's likes or derived taste becoming visible to another user or to an artist | High   | Medium     | `prd-v2.md` §Success Criteria Guardrails ("visible only to that collector"); `AGENTS.md` ("RLS is the security boundary"); no policy tests exist                      |
| 4   | A policy regression reaches production unreviewed — a schema change alters or drops an authorization rule and deploys automatically on merge with nothing gating it     | High   | Medium     | CI configuration: migrations deploy on push to `main`; the verify gate does not cover policies; hot-spot scope `supabase/migrations/`                                 |
| 5   | A swipe verdict is lost or double-written, permanently corrupting the collector's taste signal — there is no un-like affordance to recover with                         | Medium | Medium     | interview Q1; `prd-v2.md` §Scope of Change (likes persist across sessions); hot-spot dir `src/components/artworks/` (7 commits/30d)                                   |
| 6   | Unbounded AI operations on a single upload produce runaway per-artwork cost                                                                                             | Medium | Low        | `prd.md` §Success Criteria Guardrails ("bounded and known regardless of artist behavior")                                                                             |
| 7   | A collector completes onboarding and likes pieces, but the deck that follows is not ordered toward what they liked — the product's central promise silently fails | High   | Medium     | `PROJECT_PLAN.md` §Certification requirements mapping ("one E2E test covering the core flow"); `prd-v2.md` §Scope of Change; the `personalized-deck-ranking` change   |

Risk #7 was added on 2026-09-13 by the `course-completion` change and is **appended out of rank order** — by impact × likelihood it belongs above #5, but the existing numbers are cited across this document, the archive and the plans, so renumbering would cost more than the ordering is worth.

Risks 3 and 4 are the abuse-lens rows: 3 is authorization/ownership (does the boundary check that a resource belongs to you, not merely that you are signed in), 4 is the deployment path that can silently weaken it. Both are scored on the same two axes as everything else.

### Risk Response Guidance

| Risk | What would prove protection                                                                      | Must challenge                                                                                                                  | Context `/10x-research` must ground                                                                                                                              | Likely cheapest layer                            | Anti-pattern to avoid                                                                              |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| #1   | A published artwork always has a retrievable image; a failed upload never leaves a published row | "The existence check passed, so the object is there" — the check and the insert are not atomic                                  | Every error path and whether each cleans up; whether the existence check can succeed for an unusable object; what happens if the object is removed after publish | real-boundary integration (database + storage)   | Mocking the storage client — that erases the exact seam the risk lives in                          |
| #2   | Every published artwork is reachable by some collector within a bounded number of swipes         | "It is in the table, so it is in the feed" — an ordering plus a limit plus no pagination can make a row permanently unreachable | How deck composition behaves past the limit; where untagged pieces land; what changes when ranking is introduced                                                 | database-backed integration over a seeded corpus | Asserting that the query returns rows — reachability is a property of the tail, not the first page |
| #3   | A user's likes are invisible to every other user, including artists, at the database level       | "The query filters by user id, so it is safe" — ownership filters are correctness, not the boundary                             | Which policies exist per table; what each denies for a non-owner; which role a request actually carries                                                          | policy tests against the real database           | Testing through the application, which only ever proves the happy caller                           |
| #4   | A policy-weakening change cannot reach production without failing a check                        | "Review will catch it" — nothing currently runs on migration merge                                                              | Which workflow deploys migrations, what gates it today, and whether the policy suite can run in that context                                                     | CI wiring over the Risk #3 suite                 | Adding a gate that runs the mocked suite — it cannot observe policies at all                       |
| #5   | A recorded verdict survives a failed write and is never double-written                           | "The optimistic update rolled back, so state is clean" — client rollback says nothing about the row                             | Uniqueness guarantees on the write; what a retried or concurrent write does; whether rollback and persistence can diverge                                        | integration on the write path                    | Asserting UI state instead of persisted state                                                      |
| #6   | One upload triggers a bounded, known number of model calls regardless of artist behavior         | "It is opt-in, so it is bounded" — the publish-time top-up is not artist-triggered                                              | Every trigger point; the condition that fires the top-up; whether any path can loop                                                                              | unit, with the model boundary mocked             | Testing tag quality — explicitly negative space, see §7                                            |
| #7   | A deck rendered after five likes carries tags overlapping what was liked, in a real browser      | "The RPC orders correctly, so the collector sees it" — auth, the proxy, RLS and rendering all sit between the SQL and the eye  | Where taste is computed; what the onboarding hand-off actually navigates to; what of a card reaches the accessibility tree                                       | end-to-end browser, over a seeded corpus         | A deck assertion satisfiable by any non-empty deck — it must be falsifiable by the ranking alone   |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder via `/10x-new`. Status moves left-to-right through the values below; the orchestrator updates Status as artifacts appear on disk.

| #   | Phase name                                | Goal (one line)                                                                                                                      | Risks covered     | Test types                  | Status        | Change folder                                 |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------------- | ------------- | --------------------------------------------- |
| 1   | Real-boundary lane and upload consistency | Prove a published artwork always has a retrievable image, and establish the lane that can observe real database and storage behavior | #1                | real-boundary integration   | change opened | `context/changes/testing-upload-consistency/` |
| 2   | Feed reachability                         | Prove every published artwork reaches some collector, and pin where untagged pieces sit in the ordering                              | #2, #5            | database-backed integration | not started   | —                                             |
| 3   | Authorization boundary                    | Prove ownership holds at the database level for likes, artworks and profiles                                                         | #3, #4            | policy tests                | not started   | —                                             |
| 4   | Quality-gates wiring                      | Make the new lanes blocking, and gate migration deploys on the policy suite                                                          | #4, cross-cutting | gates                       | not started   | —                                             |

Order rationale: Phases 1 and 2 carry the two High × High risks and both were named unprompted in the interview. Phase 3 uses the cheapest new lane available — the pinned CLI already ships a policy-test runner at zero dependency cost — but ranks below them on likelihood. Phase 4 comes last because a gate is only worth wiring once there is a suite behind it worth blocking on.

Phase 2 depends on the seeded corpus produced by the `ranking-eval-corpus` change; if that change has not landed, Phase 2's research must confirm the corpus exists before planning against it.

## 4. Stack

The classic test base for this project. AI-native tools (if any) carry a `checked:` date so future readers can see which lines need re-verification. Recommendations in this section are grounded in local manifests and configs plus the tools actually exposed in the current session.

| Layer                     | Tool                     | Version | Notes                                                                                       |
| ------------------------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| unit (mocked)             | Vitest                   | 4.1.11  | Node environment, `server-only` stubbed; 8 test files over Server Actions and lib helpers   |
| real-boundary integration | none yet — see Phase 1   | —       | The lane that can observe database and storage truth does not exist                         |
| policy tests              | none yet — see Phase 3   | —       | The pinned Supabase CLI ships a pgTAP runner; no new dependency required                    |
| live smoke                | Vitest (separate config) | 4.1.11  | Existing precedent for tests that hit a real service; excluded from the default test glob   |
| API mocking               | none                     | —       | Module mocking only; no MSW or equivalent, and none needed while the boundary is the target |
| e2e                       | Playwright               | 1.63.0  | `test/e2e/**/*.spec.ts` via `playwright.config.ts`; local stack + production build, opt-in, never in CI; covers Risk #7 |
| accessibility             | none                     | —       | Not planned in this rollout                                                                 |

**Stack grounding tools (current session):**

- Docs: none — no Context7 or framework docs MCP exposed; the pinned CLI's own help output was used as the authoritative source instead; checked: 2026-09-10
- Search: web search available but not used — the local CLI answered the only stack-sensitive question (policy-test runner availability) directly; checked: 2026-09-10
- Runtime/browser: none — no browser automation MCP, and no browser driver in the dependency tree; not used; checked: 2026-09-10
- Provider/platform: Supabase CLI available locally at the pinned version and used for capability verification; the Vercel MCP is present but unauthenticated in this session and therefore unavailable; checked: 2026-09-10

## 5. Quality Gates

The full set of gates that must pass before a change reaches production. "Required for §3 Phase N" means the gate is enforced once that rollout phase lands; before that, the gate is planned.

| Gate                                   | Where               | Required?                 | Catches                                                    |
| -------------------------------------- | ------------------- | ------------------------- | ---------------------------------------------------------- |
| format + lint + typecheck              | local + CI          | required                  | syntactic, style and type drift                            |
| build                                  | local + CI          | required                  | framework and compile-time breakage                        |
| unit suite (mocked)                    | local + CI          | required                  | logic regressions in Server Actions and lib helpers        |
| real-boundary integration              | local + CI          | required after §3 Phase 1 | database and storage falling out of sync                   |
| feed-reachability integration          | local + CI          | required after §3 Phase 2 | published work becoming unreachable                        |
| policy suite                           | local + CI          | required after §3 Phase 3 | ownership and authorization regressions                    |
| migration deploy gated on policy suite | CI on merge to main | required after §3 Phase 4 | a policy-weakening schema change auto-deploying unreviewed |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the relevant rollout phase ships; before that, the sub-section reads "TBD — see §3 Phase N."

### 6.1 Adding a unit test (mocked)

- **Location**: `test/actions/` for Server Actions, `test/lib/` for helpers. Tests live outside `src/`, mirroring the module they cover.
- **Naming**: `<module>.test.ts`.
- **Mocking policy**: Supabase and `next/*` are mocked; `server-only` resolves to a stub via the Vitest config. Share fixtures into `vi.mock` factories through `vi.hoisted`, never through module-level constants.
- **Reference test**: `test/actions/artworks.test.ts`.
- **Run locally**: `npm run test`.
- **When this is the wrong layer**: any behavior whose failure mode is at the database or storage boundary. The mocks erase it. Use the Phase 1 lane instead.

### 6.2 Adding a real-boundary integration test

- TBD — see §3 Phase 1. This is the lane that will prove the database-and-storage consistency behind Risk #1.

### 6.3 Adding a policy test

- TBD — see §3 Phase 3. This is the lane that will prove ownership behind Risks #3 and #4.

### 6.4 Adding a test for a new Server Action

- **Test type**: unit for the validation gate, real-boundary integration for anything that persists.
- **Pattern**: assert the Zod boundary rejects malformed input before any side effect, then assert the happy path's persisted result. Validation-gate coverage belongs in the mocked lane; persistence assertions do not.
- **Reference test**: `test/actions/artworks.test.ts` for the validation half; the persistence half is TBD — see §3 Phase 1.

### 6.5 Adding a live smoke test

- **Location**: `test/smoke/`.
- **Naming**: `<subject>.live.ts` — the `.live.ts` suffix is deliberately invisible to the default test glob, so these never run in the normal suite.
- **Pattern**: read credentials from the environment inside the function under test, never at module scope; branch on the unconfigured case and assert the documented fallback rather than skipping.
- **Reference test**: `test/smoke/enrich.live.ts`.
- **Run locally**: `npm run test:smoke`.

### 6.6 Per-rollout-phase notes

(Filled in as phases land.)

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout (Phase 2 interview, Q5). Future contributors should respect these unless the underlying assumption changes.

- **Credential mechanics** — login, signup, session refresh and email confirmation are the auth provider's code, called rather than implemented here. Re-evaluate if a custom auth path, a second provider, or a bespoke session store is introduced. Note the deliberate narrowing: this exclusion covers the credential exchange only. Ownership and authorization are Risks #3 and #4 and are firmly in scope. (Source: Phase 2 interview Q5.)
- **AI output quality** — whether generated tags or descriptions are _good_ is nondeterministic and belongs to the model vendor. Re-evaluate if output quality becomes a product guarantee rather than an assist. Note the deliberate narrowing: the deterministic contract around the model — normalization, the tag ceiling, never overwriting artist input, and behavior when unconfigured — is in scope, and Risk #6 covers the cost bound. (Source: Phase 2 interview Q5.)
- **~~End-to-end browser coverage~~ — reversed 2026-09-13.** The original exclusion read: "no browser driver is installed and no risk in §2 requires the full deployed shape to reproduce." The second clause stopped being true. Risk #7 — _a collector completes onboarding and likes pieces, but the deck that follows is not ordered toward what they liked_ — spans auth, the proxy, RLS, the `swipe_deck` RPC and the rendered deck at once, and no other lane spans all five. It is also the one certification criterion in `PROJECT_PLAN.md` that nothing in this repo demonstrated. The `course-completion` change built the lane (`playwright.config.ts`, `test/e2e/`) and one test against that risk. What stays excluded is **breadth**: one risk, one test, opt-in and never in CI. Coverage count is explicitly not the goal, and a second browser test needs a risk of its own to justify it.

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-09-10
- Stack versions last verified: 2026-09-10
- AI-native tool references last verified: 2026-09-10

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.

Two known staleness sources already exist and are worth noting rather than acting on: `context/foundation/health-check.md` and `context/foundation/stack-assessment.md` both predate the test runner and the verify gate, and describe this project as having neither. Treat the live repository as truth over both until they are refreshed.
