# Course-Completion Evidence Implementation Plan

## Overview

Close the one unmet certification criterion with a real browser test, then write the two documents
that make ArtSwipe legible to someone who has never seen it — a reviewer-first README and a
delivery story — and reconcile `PROJECT_PLAN.md` with the product that actually shipped.

## Current State Analysis

**The product is finished; the evidence for it is not.** 158 commits across 19 PRs, 28 migrations,
14 archived changes each carrying a plan and a brief, three PRD generations, three roadmap
generations, 41 test files across three lanes. None of that is reachable from the front door.

- **`README.md` is the untouched `create-next-app` boilerplate.** It does not name ArtSwipe. It
  tells a reader to open `app/page.tsx`, which does not exist (the app is under `src/app/`). It
  mentions neither Supabase, nor the env vars, nor the three test lanes, nor how to get a local
  stack up.
- **`PROJECT_PLAN.md` is substantially wrong.** It promises "no artist uploads in MVP" (there is a
  full artist studio), "hard boundary: no marketplace in Layer 1" (there is a complete auction
  mechanism with sealed bids, a `pg_cron` close, and contact exchange), a data model with an
  `embedding vector` column (there is none — ranking is tag-overlap in SQL), and a file layout that
  matches nothing on disk. Its decision log stops at 2026-09-09, four days and thirteen changes ago.
- **The E2E criterion has never been met.** `PROJECT_PLAN.md` lists "one E2E test covering the core
  flow" as a certification requirement. `context/foundation/test-plan.md:75` records the e2e row as
  "none / Not planned. No browser driver…", and `:144` states the omission deliberately. There is no
  `@playwright/test` dependency, no `playwright.config.*`, and no spec file.
- **Documentation that *is* excellent is aimed at agents, not people.** `AGENTS.md` (17 KB) is a
  dense rulebook — it tells you what not to do without ever describing the system. `.env.example`
  and `supabase/seed-assets/README.md` are genuinely first-rate operational docs, and the README
  should route to them rather than restate them.

**Constraint discovered during planning:** `/10x-e2e` explicitly refuses to bootstrap the lane. Its
Setup step 5 stops with "This skill assumes Playwright is already installed; it won't set it up"
when there is no `playwright.config.*` **and** no `*.spec.ts`. Both are absent, so the lane is
prerequisite work, not part of the skill's loop.

## Desired End State

A reviewer clones the repo, reads `README.md`, and within two minutes knows what ArtSwipe is, how
the recommendation and auction loops work, where each of the six certification criteria is met, and
what to run to see it working. Every criterion in the mapping is genuinely met — including the E2E
one, by a Playwright test that signs a collector up, walks them through onboarding, has them like
five pieces, and asserts the deck that follows is ordered toward what they liked.

Verify by: `npm run test:e2e` passes against a freshly reset local stack; `PROJECT_PLAN.md`'s
certification table has six rows and no unmet row; `docs/delivery-story.md` exists and every change
it names resolves to a folder under `context/archive/`; the full verify gate stays green.

### Key Discoveries

- **`/10x-e2e` needs a config to start** — `.claude/skills/10x-e2e/SKILL.md` Setup step 5. It *does*
  create its own two quality levers (`seed.spec.ts` and an E2E rules file) from
  `references/seed-test-pattern.md` and `references/e2e-quality-rules.md` once a config exists, so
  Phase 1 must not pre-empt those.
- **Local signup needs no email round trip.** `supabase/config.toml:225` sets
  `enable_confirmations = false`, so a UI signup yields a session immediately. No Inbucket/Mailpit
  step, no magic-link parsing.
- **`supabase/config.toml:158` sets `site_url = "http://127.0.0.1:3000"`** — the Playwright
  `baseURL` must be `127.0.0.1`, not `localhost`, or auth redirects cross an origin boundary.
- **Artwork tags render into the DOM.** `src/components/artworks/ArtCard.tsx:73` renders `TagList`
  whenever `artwork.tags.length > 0`, which is what makes "the deck is ordered toward my taste"
  assertable from the accessibility tree instead of from the database.
- **A `.spec.ts` glob under `test/e2e/` is disjoint from all three existing lanes** —
  `vitest.config.mts` includes `test/**/*.test.ts`, the integration config `test/integration/**/*.int.ts`,
  the smoke config `test/smoke/**/*.live.ts`. None match `.spec.ts`, so the fourth lane cannot be
  picked up by `npm run test` or CI, matching the isolation discipline the other three already keep.
- **The loopback guard already exists and should be reused, not rewritten.**
  `test/integration/setup.ts` exports `requireLocalRunningStack`, whose whole purpose is refusing to
  run a user-creating suite against anything but 127.0.0.1 — exactly the hazard the E2E lane
  reintroduces.
- **Ranking is tag overlap in SQL, not an embedding.** `supabase/migrations/20260910180000_rank_swipe_deck.sql`
  computes taste as an inline CTE inside `swipe_deck`. Both the README's architecture section and the
  E2E test's break-verification target that function.

## What We're NOT Doing

- **Not fixing `data-driven-picker`.** The onboarding picker still offers seven style terms with no
  artworks behind them. The E2E test routes around it by pinning populated terms; the change folder
  stays open and unplanned.
- **Not adding E2E to CI.** No Supabase service container, no seeded corpus in the workflow, no
  Chromium download on every PR. The lane is opt-in like `test:integration` and `test:smoke`.
- **Not writing a second or third E2E test.** One reviewed, break-verified test protecting one risk.
  Coverage count is explicitly not the goal.
- **Not building `storageState` auth infrastructure.** The only risk in scope begins at a signed-out
  signup page, so a pre-authenticated fixture would be unused scaffolding. Phase 1 records this as a
  deliberate absence so `/10x-e2e` does not go looking for it.
- **Not rewriting `AGENTS.md`.** It gets one new lane paragraph and nothing else.
- **Not touching S-06, S-07, or the open `data-driven-picker` change**, and not merging this branch's
  S-05 work to `main` as part of this change.
- **Not restating `.env.example` or `supabase/seed-assets/README.md` in the README.** Both are better
  than anything a summary would produce; the README links to them.

## Implementation Approach

Two movements, strictly ordered. The test comes first because the README's certification table can
only claim it once it exists — writing the table against an intended test is how a documentation
task quietly becomes a false claim.

Movement one (Phases 1–2) builds the lane and then hands the actual test-writing to `/10x-e2e`,
which is better at it than a hand-rolled spec would be: it starts from a seed exemplar, reviews
against named anti-patterns, and verifies the test fails when the risk materializes.

Movement two (Phases 3–5) writes outward-in: the README a reviewer reads first, then the delivery
story it links to, then the founding document reconciled last — by which point the other two have
already settled what the shipped product actually is.

## Critical Implementation Details

**`NEXT_PUBLIC_*` are inlined at build time, and `.env.local` points at production.** This is the
one genuinely dangerous detail in the change. Next.js loads `.env.local` automatically and this
repo's `.env.local` holds the **linked production** Supabase project — the exact reason
`test/integration/setup.ts` exists. A Playwright `webServer` that runs `npm run build && npm run
start` without an env override would build the app against production, and the browser would sign
real accounts up on the live project while the lane's own guard reported "local" from a different
file. Next.js skips any variable already present in `process.env`, so passing the local URL and key
through `webServer.env` wins over `.env.local` — but only if they are set for the **build** step as
well as `start`, because the `NEXT_PUBLIC_` values are baked into the client bundle at build time,
not read at runtime. Both commands must therefore run inside the same `webServer` invocation with
the same `env` block.

**The server must be a production build, not `next dev`.** Headless Chromium does not hydrate
`next dev` pages reliably in this environment and fails silently when it doesn't — the page renders,
the test clicks, nothing responds, and the failure looks like a bad selector.

**Onboarding is a two-step GET form on one route.** `src/app/(onboarding)/onboarding/page.tsx`
renders the picker when `?term=` is absent and the starter deck when it is present, so the flow is
two navigations on the same URL, not two routes. A test waiting for a route change after the picker
submits will hang.

## Phase 1: The E2E lane

### Overview

Everything `/10x-e2e` needs in order to start, and nothing it will create for itself. At the end of
this phase, invoking the skill gets past its Setup gate.

### Changes Required:

#### 1. Playwright dependency and run script

**File**: `package.json`

**Intent**: Add `@playwright/test` as a dev dependency and a `test:e2e` script, so the fourth lane
is invoked the same way the other three are.

**Contract**: New script `"test:e2e": "playwright test"`. Unlike the Vitest lanes, the Playwright
CLI is not `node`, so the `--env-file-if-exists` trick those scripts use does not apply — the config
loads the lane's credentials itself (see below). Chromium is installed once by the developer with
`npx playwright install chromium`; the README documents it as a prerequisite rather than a
`postinstall` hook, because CI must never download a browser it does not use.

#### 2. The Playwright config

**File**: `playwright.config.ts` (new)

**Intent**: Define the lane — where its specs live, what server they run against, and the
credentials that server is built with.

**Contract**: `testDir: "test/e2e"`, matching `**/*.spec.ts` — disjoint from all three Vitest globs.
`baseURL: "http://127.0.0.1:3000"` to match `supabase/config.toml`'s `site_url`. A single chromium
project. `fullyParallel: false` and `workers: 1`, for the reason `vitest.integration.config.mts`
gives for `fileParallelism: false` — one shared Postgres, so concurrent specs mutate each other's
fixtures. `globalSetup` pointing at the guard below.

The `webServer` block is the load-bearing part and is worth writing out, because the ordering is
what the Critical Implementation Details section warns about:

```ts
// Node 24 (see .nvmrc) — the lane's credentials, same file the integration lane uses.
process.loadEnvFile?.(".env.test.local");

const stackEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
};

webServer: {
  // Build AND start under the same env: NEXT_PUBLIC_* are inlined into the
  // client bundle at build time, so overriding them only for `start` would
  // ship a bundle pointing at whatever .env.local holds — production.
  command: "npm run build && npm run start",
  url: "http://127.0.0.1:3000",
  env: stackEnv,
  reuseExistingServer: false,
  timeout: 180_000, // a cold `next build` on this repo is slow
}
```

#### 3. The loopback guard, reused

**File**: `test/e2e/global-setup.ts` (new)

**Intent**: Refuse to run the lane against anything but a local stack, and fail with an instruction
rather than thirty connection errors when the stack is down.

**Contract**: A default-exported async function that calls `requireLocalRunningStack()` imported
from `test/integration/setup.ts`. Deliberately a reuse, not a copy: this lane creates users and
writes interactions, which is precisely the hazard that function was written for, and two
definitions of "is this local?" is one more than the codebase should hold. The cross-lane import is
intentional and gets a comment saying so.

#### 4. Test helpers

**File**: `test/e2e/helpers.ts` (new)

**Intent**: Mint a unique collector email per run, and name the pinned style terms in one place.

**Contract**: A `uniqueEmail(prefix)` helper mirroring `test/integration/helpers.ts`, and an
exported `POPULATED_STYLE_TERMS = ["figurative", "realism"]` with a comment recording why those two
and not others — 88 and 55 artworks respectively against seven terms with zero, counted from
`supabase/seed-assets/corpus.json`. Note the rate limit that already governs the integration lane:
`[auth.rate_limit] sign_in_sign_ups` is 30 per 5 minutes per IP, and this lane signs up too.

#### 5. Register the risk the test will protect

**File**: `context/foundation/test-plan.md`

**Intent**: `/10x-e2e` reads this file to find the risk a phase protects — the risk, not a file, is
its unit of work. Today the file says browser coverage is not planned, which is the opposite of what
the next phase needs to find.

**Contract**: Amend the e2e row at `:75` from "none / Not planned" to the lane this phase builds, and
replace the deferral note at `:144` with the risk itself, given an id so Phase 2 can cite it: *a
collector completes onboarding and likes pieces, but the deck that follows is not ordered toward
what they liked — the product's central promise fails across auth, the proxy, RLS, the `swipe_deck`
RPC and the rendered deck at once, and no existing lane spans all five.*

#### 6. Ignore lists and the agent rulebook

**Files**: `.gitignore`, `.prettierignore`, `AGENTS.md`

**Intent**: Keep Playwright's output out of git and out of the formatter, and tell the next agent the
fourth lane exists.

**Contract**: `test-results/`, `playwright-report/` and `blob-report/` added to both ignore files.
`AGENTS.md`'s Tests section gains a fourth lane entry in the shape of the existing three: its
config, its glob, that it is opt-in and never in CI, that it needs `.env.test.local` plus a
production build plus `npx playwright install chromium`, that `storageState` is deliberately absent,
and the build-time env-inlining hazard.

### Success Criteria:

#### Automated Verification:

- `npx playwright test --list` resolves the config and reports zero tests without erroring
- Guard fires: `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co npx playwright test` exits non-zero with the local-stack message
- `npm run format:check` passes
- `npm run lint` passes
- `npm run typecheck` passes
- `npm run test` passes and its file count is unchanged — the new lane is invisible to it
- `npm run build` passes

#### Manual Verification:

- With the stack up, the `webServer` builds and serves; `http://127.0.0.1:3000` is reachable
- The served app is talking to the **local** stack, not production — confirmed by signing up in that browser and seeing the user appear in Supabase Studio at `127.0.0.1:54323`
- `/10x-e2e course-completion phase 2` gets past its Setup gate instead of stopping on missing Playwright

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding. The second manual item is the one that matters — it is
the check that the build-time env override actually took.

---

## Phase 2: The taste-loop test

### Overview

One reviewed, break-verified browser test, produced by `/10x-e2e` driving the risk Phase 1
registered. This phase is executed with `/10x-e2e course-completion phase 2`, not by hand.

### Changes Required:

#### 1. The test

**File**: `test/e2e/taste-loop.spec.ts` (new — name may change; `/10x-e2e` owns it)

**Intent**: Prove the criterion `PROJECT_PLAN.md` names: a collector who likes five pieces gets a
sixth recommendation matching demonstrated preference.

**Contract**: The flow, which the skill will map against the running app but which is fixed here so
it cannot drift:

1. Sign up a fresh collector at `/signup` with a unique email. Local `enable_confirmations = false`
   means a session exists immediately; the proxy then redirects into `/onboarding`.
2. On the picker, select `figurative` and `realism` — `ONBOARDING_TERM_MIN` is 2, and these are the
   two best-populated terms in the corpus. Submit.
3. The picker is a GET form back to the same route, so the starter deck appears at
   `/onboarding?term=…`. Do not wait for a route change.
4. Like `ONBOARDING_LIKE_TARGET` (5) pieces. The flow hands off to `/discover` on the fifth.
5. Assert the deck that follows is ordered toward the demonstrated taste: the cards rendered on
   `/discover` carry tags overlapping the union of tags on the liked pieces, read from the `TagList`
   that `ArtCard` renders. The precise assertion is `/10x-e2e`'s to shape against the real
   accessibility tree — the invariant is that it must be **falsifiable by the ranking**, not
   satisfiable by any non-empty deck.

Boundaries: nothing is mocked. Real auth, real RLS, real Storage, real `swipe_deck`.

#### 2. The two quality levers

**Files**: `test/e2e/seed.spec.ts` and the E2E rules file (both new)

**Intent**: `/10x-e2e` creates these itself on first use from its `references/`. They are listed
here only so they land in this phase's commit rather than appearing unexplained.

**Contract**: Adapted to this app's real routes and roles. `getByRole`-based, no `waitForTimeout` —
the seed is the exemplar every future generated test inherits from.

### Success Criteria:

#### Automated Verification:

- `npm run test:e2e` passes against a freshly reset local stack
- The test passes twice in a row without a reset in between — proving it does not depend on being the first collector
- `npm run format:check`, `npm run lint`, `npm run typecheck` pass
- `npm run test` and `npm run test:integration` are both still green — the new lane changed nothing they cover

#### Manual Verification:

- **Break-verification**: temporarily neutralise the tag-overlap ordering in `swipe_deck` (a local-only edit, reverted immediately) and confirm the test goes **red**. A test that stays green when the ranking is gone is protecting nothing.
- The test is reviewed against the five agent E2E anti-patterns in `.claude/skills/10x-e2e/references/e2e-anti-patterns.md`
- No `waitForTimeout` and no CSS-selector locators anywhere in the spec

**Implementation Note**: Pause for manual confirmation after this phase. The break-verification is
the phase's real deliverable — `context/foundation/lessons.md` records "Prove each Progress item
before checking it off", and a green E2E test nobody has seen fail is exactly the item that lesson
is about.

---

## Phase 3: The README

### Overview

Replace the `create-next-app` boilerplate with a reviewer-first document.

### Changes Required:

#### 1. The README

**File**: `README.md` (full rewrite)

**Intent**: Let a reviewer understand and evaluate ArtSwipe without cloning it, and let a developer
run it without asking anyone.

**Contract**: Sections in this order.

- **What ArtSwipe is** — one paragraph. The discovery engine and what got built on top of it.
- **The two loops** — the collector loop (onboard → swipe → ranked deck) and the auction loop (list
  → targeted notification → sealed bid → timed close → contact exchange), a few sentences each.
- **Architecture** — one flow diagram plus a table of load-bearing decisions, each row one line with
  a link into the code or the delivery story: RLS is the security boundary and ownership filters are
  not; images go browser→Storage and only the key travels through a Server Action (1 MB action cap);
  AI enrichment never throws and never blocks a mutation; email has exactly one send path and the
  `pg_cron`→`pg_net`→`/api/email/drain` bridge exists because Postgres cannot call Node; the drain's
  two secrets are split because `net.http_request_queue` grants `PUBLIC` everything.
- **Certification mapping** — the six rows from `PROJECT_PLAN.md`, each pointing at the code or
  command that demonstrates it. This is where the reviewer looks; it goes above setup.
- **Getting started** — Node from `.nvmrc`, `npm ci`, `npx supabase start`, `npm run db:seed:fetch`
  (the one-time ~260 MB prerequisite), `npm run db:reset`, `npm run dev`. Env: point at
  `.env.example`, do not restate it.
- **Testing** — the four lanes in a table: command, config, glob, what it owns, whether CI runs it.
- **Project layout and further reading** — `src/` map in a few lines, then links to `AGENTS.md`
  (agent rules), `docs/delivery-story.md`, `context/foundation/` (PRDs, roadmap, test plan) and
  `supabase/seed-assets/README.md` (seed and corpus workflow).

The diagram is a mermaid `flowchart` — GitHub renders it natively and it stays diffable, unlike an
image.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes — Prettier formats Markdown and the README is not ignored
- Every relative link in the README resolves to an existing path
- No occurrence of "create-next-app", "bootstrapped with", or "app/page.tsx" remains

#### Manual Verification:

- The mermaid diagram renders on GitHub
- Following the Getting started steps on a clean clone produces a running app
- A reader who has never seen the project can state what ArtSwipe does after the first screen

---

## Phase 4: The delivery story

### Overview

A front door onto `context/archive/` — the narrative the 14 change folders already contain but
which nobody will reconstruct by reading them in order.

### Changes Required:

#### 1. The document

**File**: `docs/delivery-story.md` (new, and the new `docs/` directory)

**Intent**: Show how the product was built, not just what it became — the process evidence that is
the point of an AI-assisted engineering course.

**Contract**: Sections in this order.

- **How the work was organised** — the `/10x-*` cycle (shape → PRD → roadmap → per-change frame /
  research / plan / implement / review / archive), and what each artifact is for. One short
  paragraph plus the `context/` tree.
- **Three generations** — `prd.md` (AI enrichment) → `prd-v2.md` (recommendation engine) →
  `prd-v3.md` (auction mechanism), each with its roadmap, and why the scope moved each time.
- **The changes, in order** — a table of all 14 archived changes: change id, what shipped, the PR,
  the decision worth remembering. Then longer notes on the five that carry real engineering:
  `ai-artwork-enrichment` (and the silently-failing Storage-key defect that followed),
  `personalized-deck-ranking` (tag overlap in SQL, judged against a recorded baseline),
  `testing-upload-consistency` (why a real-boundary lane had to exist at all),
  `outbound-email-foundation` + `close-outcomes-and-contact-exchange` (the Postgres→Node bridge and
  the two-secret split), `auction-notifications-for-likers` (unsubscribe without a session).
- **What went wrong and what it taught** — the three entries in `context/foundation/lessons.md`,
  each with the incident behind it: the AI call on a mutation's critical path, the Progress items
  checked off without proof, the commit that landed on `main`.
- **Where it stands** — S-05 on a branch awaiting merge; S-06 and S-07 not built; the
  `data-driven-picker` defect open and why it was routed around rather than fixed.

Written for a reader who was not there. Every change id it names must resolve to a folder under
`context/archive/`.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- Every change id named in the document resolves to a directory under `context/archive/`
- Every relative link resolves

#### Manual Verification:

- The table has one row per archived change — 14 rows, none invented, none missed
- Each of the three lessons is traceable to the incident described
- A reader unfamiliar with the project can follow the arc without opening `context/`

---

## Phase 5: Reconcile the founding documents

### Overview

Bring `PROJECT_PLAN.md` in line with what shipped, and correct the two places that now describe the
project wrongly because this change moved them.

### Changes Required:

#### 1. The project plan

**File**: `PROJECT_PLAN.md`

**Intent**: Make the founding document true, while keeping the fact that it changed legible.

**Contract**: Update in place — core flow, business logic, tech stack, data model (drop the
`embedding vector` that was never built; add `auctions`, `bids`, `email_sends`, `email_outbox`,
notification preferences), layered delivery (Layers 2 and 3 are substantially delivered, not
deferred), and project structure (match the real `src/` tree). Rewrite the certification table so
each row says how the requirement is met **now**, with the E2E row citing the Phase 2 test.

The decision log is **extended, not replaced**: the four 2026-09-09 rows stay exactly as they are,
and new rows record the decisions that moved the scope — artist uploads added, marketplace scope
reversed, embeddings dropped for SQL tag overlap, email added as a foundation, E2E deferred at
`test-plan.md` and then reinstated for certification. The drift is the interesting part of the
document; erasing it would be the one edit that makes the file less true.

#### 2. Two corrections this change causes

**Files**: `context/foundation/test-plan.md`, `context/changes/data-driven-picker/change.md`

**Intent**: Leave no document asserting something this change made false.

**Contract**: In `test-plan.md`, confirm the e2e row and the §144 note now describe the lane that
exists (Phase 1 amended them; this is the check that they still read correctly after Phase 2 shipped
a real test). In `data-driven-picker/change.md`, append a dated note correcting "17 of 20 terms are
empty" to the counted figure — 7 of 20 empty, 13 populated, with the top six named — since the
corpus grew and enrichment ran after that note was written. The change stays open and unplanned.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` passes
- `PROJECT_PLAN.md` contains no reference to `embedding vector`, and its structure block matches the real `src/` tree
- The certification table has six rows and no row reads as unmet
- Full gate green: `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`

#### Manual Verification:

- The decision log still contains the four original 2026-09-09 rows verbatim
- Reading `PROJECT_PLAN.md`, `README.md` and `docs/delivery-story.md` in sequence produces no contradiction
- `data-driven-picker` is still `status: new` — corrected, not closed

---

---

## Phase 6: The screenshot tour

> **Added 2026-09-13, mid-implementation, at the owner's request** — after Phase 4 landed and
> before Phase 5 runs, so that Phase 5's reconciliation reads the final README. The original
> five-phase plan had no screenshots in it; this section records what was actually built rather
> than leaving it to appear unexplained in the diff.

### Overview

Ten screenshots of the real app, captured by driving it, and a README section built around them.
Documentation tooling that happens to use Playwright — not a fifth test lane.

### Changes Required:

#### 1. The capture lane

**Files**: `playwright.screenshots.config.ts` (new), `test/screenshots/tour.shot.ts` (new),
`package.json`

**Intent**: Regenerate the README's images from the real product on demand.

**Contract**: Its own config and its own `**/*.shot.ts` glob — disjoint from all four test globs,
so `npm run test:e2e` keeps running exactly one test. Reuses `requireLocalStack` and the browser
lane's `globalSetup` rather than restating either. Same production-build `webServer`, same
build-time env hazard, same reasoning. `npm run docs:screenshots` runs it under
`--conditions=react-server` so the unsubscribe shot can import the real token minter instead of
restating its HMAC. A throwaway `UNSUBSCRIBE_TOKEN_SECRET` per run; `OPENROUTER_API_KEY` lifted
from `.env.local` by name only, never by `loadEnvFile`.

Nothing in the file asserts a product property — every `expect` is a wait condition.

#### 2. The README section, and the rulebook

**Files**: `README.md`, `AGENTS.md`

**Contract**: A "Both loops, in the app" section between the prose loops and Architecture, ten
captioned images, grouped collector-then-auction. `AGENTS.md` gains a subsection stating that the
capture is **not** a lane, that it is additive, and why it never uses `.first()`.

#### 3. The enrichment shot that is deliberately absent

**File**: `context/changes/ai-enrichment-budget/change.md` (new)

**Intent**: The obvious eleventh shot — AI enrichment filling the upload form — cannot be taken
truthfully. OpenRouter's free vision roster now answers in 26–70s against a 25s budget, and the
pinned lead model rejects the request outright, so the form renders a timeout. Rather than
photograph an outage or quietly fake it, the shot is dropped, the README says why, and the
regression is opened as its own change with the measurements attached.

**Contract**: `src/lib/ai/` is **not** touched by this change. The fix is a budget-per-caller
decision with test implications and belongs to a planned change of its own.

### Success Criteria:

#### Automated Verification:

- `npm run docs:screenshots` passes and writes ten PNGs into `docs/screenshots/`
- `npx playwright test --list` still reports exactly one test — the capture is invisible to the browser lane
- Every relative link and image path in `README.md` resolves
- `npm run format:check` · `npm run lint` · `npm run typecheck` pass

#### Manual Verification:

- The shots render on GitHub and show the piece each run creates, not a previous run's
- No screenshot advertises a feature that is currently degraded
- `npm run test` and the browser lane are unaffected

---

## Testing Strategy

### Unit Tests:

No new unit tests. This change adds no `src/` logic; Phases 3–5 are prose and Phase 1 is
configuration. The existing 41 files across three lanes must stay green throughout — that is the
regression signal.

### Integration Tests:

None added. `npm run test:integration` is run at the end of Phase 2 to confirm the new lane's
fixtures do not collide with it — both create users against the same local stack, and
`[auth.rate_limit] sign_in_sign_ups` (30 per 5 minutes per IP) is shared between them.

### Manual Testing Steps:

1. `npx supabase start`, regenerate `.env.test.local`, `npm run db:seed:fetch` (once), `npm run db:reset`.
2. `npx playwright install chromium` (once).
3. `npm run test:e2e` — passes.
4. Neutralise the tag-overlap ordering in `swipe_deck` locally; re-run; confirm **red**. Revert.
5. Run `npm run test:e2e` a second time without resetting the database — still green.
6. Point `NEXT_PUBLIC_SUPABASE_URL` at a non-loopback host and confirm the lane refuses to start.
7. Follow the README's Getting started on a clean clone.

## Performance Considerations

The `webServer` runs a full `next build` before the first test, so a cold `npm run test:e2e` takes
minutes rather than seconds. That is the cost of the production-build requirement and is why the
lane is opt-in and out of CI; the `timeout: 180_000` on the `webServer` block exists to survive it
rather than to mask a hang.

## Migration Notes

No schema changes, no data migration. The only reversible-by-deletion artifacts are
`playwright.config.ts`, `test/e2e/`, `docs/`, and one dev dependency. Phase 5's edits to
`PROJECT_PLAN.md` are the only ones that overwrite existing prose; the decision log is append-only
by instruction, so the original commitments survive the edit.

## References

- Certification criteria: `PROJECT_PLAN.md` §Certification requirements mapping
- E2E deferral being reversed: `context/foundation/test-plan.md:75`, `:144`
- Skill contract for Phase 2: `.claude/skills/10x-e2e/SKILL.md` (Setup step 5; the two quality levers)
- Loopback guard being reused: `test/integration/setup.ts`
- Lane isolation precedent: `vitest.integration.config.mts`
- Ranking under test: `supabase/migrations/20260910180000_rank_swipe_deck.sql`
- Onboarding flow under test: `src/app/(onboarding)/onboarding/page.tsx`, `src/lib/onboarding/config.ts`
- Corpus the test's term choice depends on: `supabase/seed-assets/corpus.json`
- Accepted rules that shaped this plan: `context/foundation/lessons.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The E2E lane

#### Automated

- [x] 1.1 `npx playwright test --list` resolves the config and reports zero tests without erroring — 98f4697
- [x] 1.2 Guard fires against a non-loopback `NEXT_PUBLIC_SUPABASE_URL`, exiting non-zero with the local-stack message — 98f4697
- [x] 1.3 `npm run format:check` passes — 98f4697
- [x] 1.4 `npm run lint` passes — 98f4697
- [x] 1.5 `npm run typecheck` passes — 98f4697
- [x] 1.6 `npm run test` passes with an unchanged file count — 98f4697
- [x] 1.7 `npm run build` passes — 98f4697

#### Manual

- [x] 1.8 The `webServer` builds and serves at `http://127.0.0.1:3000` — 98f4697
- [x] 1.9 The served app talks to the local stack, confirmed via Supabase Studio at `127.0.0.1:54323` — 98f4697
- [x] 1.10 `/10x-e2e course-completion phase 2` gets past its Setup gate — 98f4697

### Phase 2: The taste-loop test

#### Automated

- [x] 2.1 `npm run test:e2e` passes against a freshly reset local stack — bca0cdc
- [x] 2.2 The test passes twice in a row without a reset in between — bca0cdc
- [x] 2.3 `npm run format:check`, `npm run lint`, `npm run typecheck` pass — bca0cdc
- [x] 2.4 `npm run test` and `npm run test:integration` are both still green — bca0cdc

#### Manual

- [x] 2.5 Break-verification: neutralising the tag-overlap ordering in `swipe_deck` turns the test red — bca0cdc
- [x] 2.6 The test is reviewed against the five agent E2E anti-patterns — bca0cdc
- [x] 2.7 No `waitForTimeout` and no CSS-selector locators in the spec — bca0cdc

### Phase 3: The README

#### Automated

- [x] 3.1 `npm run format:check` passes — cdf8316
- [x] 3.2 Every relative link in the README resolves to an existing path — 02593bb
- [x] 3.3 No occurrence of "create-next-app", "bootstrapped with", or "app/page.tsx" remains — cdf8316

#### Manual

- [x] 3.4 The mermaid diagram renders on GitHub — cdf8316
- [x] 3.5 Following Getting started on a clean clone produces a running app — cdf8316
- [x] 3.6 A first-time reader can state what ArtSwipe does after the first screen — cdf8316

### Phase 4: The delivery story

#### Automated

- [x] 4.1 `npm run format:check` passes — 02593bb
- [x] 4.2 Every change id named in the document resolves to a directory under `context/archive/` — 02593bb
- [x] 4.3 Every relative link resolves — 02593bb

#### Manual

- [x] 4.4 The change table has one row per archived change — 14 rows, none invented, none missed — 02593bb
- [x] 4.5 Each of the three lessons is traceable to the incident described — 02593bb
- [x] 4.6 A reader unfamiliar with the project can follow the arc without opening `context/` — 02593bb

### Phase 5: Reconcile the founding documents

#### Automated

- [x] 5.1 `npm run format:check` passes — a42e8e7
- [x] 5.2 `PROJECT_PLAN.md` has no `embedding vector` reference and its structure block matches the real `src/` tree — a42e8e7
- [x] 5.3 The certification table has six rows and no row reads as unmet — a42e8e7
- [x] 5.4 Full gate green: `format:check` · `lint` · `typecheck` · `test` · `build` — a42e8e7

#### Manual

- [x] 5.5 The decision log still contains the four original 2026-09-09 rows verbatim — a42e8e7
- [x] 5.6 `PROJECT_PLAN.md`, `README.md` and `docs/delivery-story.md` read without contradiction — a42e8e7
- [x] 5.7 `data-driven-picker` is still `status: new` — corrected, not closed — a42e8e7

### Phase 6: The screenshot tour

#### Automated

- [x] 6.1 `npm run docs:screenshots` passes and writes ten PNGs into `docs/screenshots/` — a11fcac
- [x] 6.2 `npx playwright test --list` still reports exactly one test — a11fcac
- [x] 6.3 Every relative link and image path in `README.md` resolves — a11fcac
- [x] 6.4 `npm run format:check` · `npm run lint` · `npm run typecheck` pass — a11fcac

#### Manual

- [x] 6.5 The shots render on GitHub and show each run's own piece — a11fcac
- [x] 6.6 No screenshot advertises a currently degraded feature — a11fcac
- [x] 6.7 `npm run test` and the browser lane are unaffected — a11fcac
