---
project: artswipe
assessed_at: 2026-09-09T17:00:57Z
agent_readiness: ready-with-compensation
context_type: brownfield
stack_components:
  language: TypeScript
  framework: Next.js 16 (App Router) + React 19
  build_tool: Next.js built-in (next build)
  test_runner: null
  package_manager: npm
  ci_provider: GitHub Actions
  deployment_target: Vercel
gates_passed: 3
gates_failed: 1
---

## Stack Components

- **Language — TypeScript (~5).** `tsconfig.json` sets `"strict": true`. `@types/node`, `@types/react`, `@types/react-dom` are dev dependencies. Database types are generated from the live schema (`npm run db:types` → `src/types/database.ts`) and hand-written domain types live in `src/types/domain.ts`. Runtime boundary validation uses Zod. `allowJs: true` and `skipLibCheck: true` are set but no `.js` source is present.
- **Framework — Next.js `16.3.4` (App Router) + React `19.2.8`.** File-based routing with route groups (`src/app/(app)/`, `src/app/(auth)/`), nested layouts, dynamic segments (`artist/[id]`, `artwork/[id]`, `studio/[id]/edit`), Server Actions in `src/app/actions/`, and a route handler at `src/app/auth/confirm/route.ts`. Request interception is in `src/proxy.ts` (Next.js 16 renamed middleware to "proxy" — a concrete example of this version's API drift). `eslint-config-next` (core-web-vitals + typescript rulesets) is configured in `eslint.config.mjs`.
- **Build tool — Next.js built-in.** `next build` / `next dev`. No custom bundler config beyond `next.config.ts` (image remote-pattern allow-list for the Supabase Storage host).
- **Package manager — npm.** `package-lock.json` present.
- **Backend / data — Supabase (Postgres, Auth, Storage).** Not one of the four scored components, but central to the codebase. SQL migrations in `supabase/migrations/` (7 files, timestamp-ordered), `supabase/config.toml` for local dev, generated types workflow. Auth clients split by runtime: `src/utils/supabase/client.ts` (browser), `src/utils/supabase/server.ts` (Server Components / Actions, cookie-aware), `src/utils/supabase/proxy.ts` (session refresh in `src/proxy.ts`). Row-Level Security is the security boundary (per comments in `src/lib/artworks/queries.ts`). Server-only modules are guarded with the `server-only` package.
- **Test runner — none.** No `test` script in `package.json`, no `vitest.config.*` / `jest.config.*` / `playwright.config.*`, no `*.test.*` / `*.spec.*` files anywhere in `src/`.
- **CI/CD — GitHub Actions, single workflow.** `.github/workflows/migrations.yml` deploys Supabase migrations on push to `main` when `supabase/migrations/**` changes. No workflow runs `lint`, `typecheck`, `build`, or tests on pull requests.
- **Deployment — Vercel.** `@vercel/analytics` dependency; PRD confirms Vercel hosting. No `vercel.json` / `vercel.ts` (defaults are fine for a standard Next.js app).
- **Instruction files — present but near-empty.** `CLAUDE.md` is a single `@AGENTS.md` include. `AGENTS.md` contains only the auto-generated `nextjs-agent-rules` block (telling agents to read `node_modules/next/dist/docs/` before writing code). No project-specific conventions are documented.

## Quality Gate Assessment

| Component                         | Typed | Convention | Training Data | Documented | Verdict                |
| --------------------------------- | ----- | ---------- | ------------- | ---------- | ---------------------- |
| Language — TypeScript             | ✓     | —          | —             | —          | pass                   |
| Framework — Next.js 16 App Router | —     | ✓          | ✗             | ✓          | pass-with-compensation |
| Build tool — next build           | —     | ✓          | ✓             | ✓          | pass                   |
| Test runner — (none)              | —     | —          | —             | —          | absent — see Gaps      |

Legend: ✓ = pass, ✗ = fail, ~ = partial, — = not applicable

**Gate roll-up:** Typed ✓ · Convention-based ✓ · Popular in training data ✗ · Well-documented ✓ → **3 of 4 pass.**

### Gate Details

**Typed — PASS.**
Evidence: `tsconfig.json` `compilerOptions.strict: true`; `tsc --noEmit` wired as `npm run typecheck`; generated DB types (`src/types/database.ts` via `supabase gen types typescript`) give every query typed row shapes; `src/types/domain.ts` for hand-rolled domain types; Zod (`zod@^4`) for runtime validation at input boundaries. An agent can reason about data shapes from source without running the app.

**Convention-based — PASS.**
Evidence: Next.js App Router is a strongly opinionated, file-based framework — routes, layouts, loading/error states, Server Actions, and route handlers all have fixed file locations and names. The repo follows them cleanly: route groups separate authed (`(app)`) from auth (`(auth)`) areas, actions are colocated under `src/app/actions/`, data-access helpers under `src/lib/`, Supabase client factories under `src/utils/supabase/`. A stranger (or agent) can predict where a new route or action goes.

**Popular in training data — FAIL (version recency, not the framework itself).**
Evidence: Next.js and React are among the most-represented frameworks in any training corpus — but this project runs Next.js **16.3.4** and React **19.2.8**, both of which post-date common model training cutoffs and carry breaking API changes. The clearest tell is in the repo itself: middleware is now `src/proxy.ts` (Next.js renamed the concept), and the auto-generated `AGENTS.md` block exists precisely because "APIs, conventions, and file structure may all differ from your training data." An agent left to its instincts will write Next.js 13/14/15-era patterns (`middleware.ts`, old `cookies()` semantics, old caching defaults, `next/legacy` image props, etc.). This is the one gate that needs active compensation.

**Well-documented — PASS.**
Evidence: Next.js ships versioned official docs, and this install vendors them locally at `node_modules/next/dist/docs/` — the `AGENTS.md` block points agents there. React 19 docs are current and versioned. Documentation availability is a strength here; the gap is what the model _remembers_, not what it can _look up_.

## Gaps & Compensation

### 1. Training-data recency for Next.js 16 / React 19 _(failed gate)_

**Why it matters for agent workflows:** the agent will confidently generate outdated Next.js patterns that either fail to build or silently behave differently (caching, dynamic APIs, middleware/proxy, image component). Every such instance costs a correction cycle.

**Compensation:** make "read the local docs first" unavoidable, and pin the specific areas that changed. Add a concrete conventions block to `AGENTS.md` (below) naming the file locations this repo actually uses, so the agent pattern-matches on the repo instead of on memory. When touching routing, caching, `cookies()`/`headers()`, or `next/image`, the agent must open the matching guide under `node_modules/next/dist/docs/` before writing.

### 2. No test feedback loop _(workflow gap, not one of the four gates)_

**Why it matters:** the agent has no automated way to know a change works. It cannot self-verify; every change needs manual checking. For the PRD's AI-enrichment work — which has fault-tolerance guardrails ("upload still works with AI down", "AI never overwrites artist input") — untested branches are exactly where regressions hide.

**Compensation:** short term, document the manual verification commands the agent must run after any change (`npm run lint`, `npm run typecheck`, `npm run build`). Medium term, `/10x-health-check` should recommend adding a test runner (Vitest fits a Next.js + TS project with near-zero config) and at least smoke coverage for Server Actions and the enrichment fallback path. Until then, treat `lint` + `typecheck` + `build` passing as the definition of "done".

### 3. CI verifies only migrations _(workflow gap)_

**Why it matters:** `lint`, `typecheck`, and `build` are never enforced on pull requests, so broken code can reach `main`. An agent opening a PR gets no signal.

**Compensation:** add a `verify.yml` workflow (below) that runs `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` on every PR and push to `main`. This is the single highest-leverage fix — it turns "the agent should remember to check" into "CI checks."

### 4. Instruction files carry no project conventions _(workflow gap)_

**Why it matters:** `AGENTS.md` says nothing about how _this_ codebase is organized — the three Supabase client factories and when to use each, the RLS-is-the-boundary rule, the migration + type-regen workflow, the `server-only` guard, Zod-at-boundaries. The agent rediscovers (or violates) these every session.

**Compensation:** the ready-to-paste `AGENTS.md` additions below encode what's already true in the code.

### Recommended Instruction File Additions

Append the following to `AGENTS.md` (below the existing auto-generated block — do not remove that block; `next dev` re-adds it). `CLAUDE.md` already includes `AGENTS.md`, so it inherits these.

```markdown
## Project conventions (ArtSwipe)

### Stack

Next.js 16 App Router · React 19 · TypeScript (strict) · Supabase (Postgres + Auth + Storage) · Tailwind v4 · Zod · deployed on Vercel.

### Version discipline — this is Next.js 16, not 13/14/15

- Request interception lives in `src/proxy.ts` (this version's name for middleware). There is no `middleware.ts`.
- Before writing or changing routing, caching, `cookies()`/`headers()` usage, Server Actions, or `next/image`, read the matching guide under `node_modules/next/dist/docs/`. Do not rely on memory of older Next.js.
- `cookies()` and `headers()` are async — always `await` them.

### Directory map

- `src/app/(app)/**` — authenticated area (redirects to `/login` when signed out). `src/app/(auth)/**` — login/signup, signed-out only.
- `src/app/actions/*.ts` — Server Actions, grouped by domain (`artworks`, `auth`, `interactions`, `profile`). All mutations go through a Server Action.
- `src/lib/**` — data-access helpers and pure logic. `src/lib/artworks/queries.ts` is `server-only`.
- `src/components/**` — grouped by domain (`artworks`, `auth`, `account`, `ui`).
- `src/types/database.ts` — GENERATED, never hand-edit. `src/types/domain.ts` — hand-written domain types.
- `src/utils/supabase/` — client factories (see below).

### Supabase client — pick the right factory

- Browser / Client Components → `createClient` from `src/utils/supabase/client.ts`.
- Server Components, Server Actions, route handlers → `await createClient()` from `src/utils/supabase/server.ts` (cookie-aware).
- Session refresh in `src/proxy.ts` → `updateSession` from `src/utils/supabase/proxy.ts`.
- Row-Level Security is the security boundary. Ownership filters in queries are for correctness/performance, not security — never rely on them for access control.

### Database changes

- Add a migration: create `supabase/migrations/<timestamp>_<name>.sql`. Migrations apply in timestamp order.
- After changing schema, regenerate types: `npm run db:types:local` (local) or `npm run db:types` (linked).
- Pushing migration files to `main` auto-deploys them via `.github/workflows/migrations.yml`. Never edit an already-applied migration — add a new one.

### Validation

- Validate all external input (form data, Server Action args, request bodies) with Zod at the boundary before use.

### Verify before calling a change done

Run and pass all three: `npm run lint` · `npm run typecheck` · `npm run build`.
There is no test suite yet — these three are the safety net. Do not assume a change works without running them.
```

### Recommended CI addition

Create `.github/workflows/verify.yml`:

```yaml
name: Verify

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run build
```

## Summary

**Overall agent-readiness: ready-with-compensation.**

**Strengths.** End-to-end TypeScript with strict mode, generated DB types, and Zod at boundaries — an agent can reason about data shapes from source. Next.js App Router gives strong, predictable structure, and the codebase follows it faithfully (route groups, colocated actions, layered `lib`/`utils`). Official docs are versioned and vendored locally.

**Gaps.** One of the four criteria fails: **training-data recency** — Next.js 16 and React 19 carry breaking changes the agent's memory predates (middleware→proxy, async `cookies()`, caching defaults), so it needs active steering toward the local docs and the repo's actual file layout. Three workflow gaps compound it: **no test feedback loop** (no runner, no tests), **CI enforces only migrations** (no lint/typecheck/build gate on PRs), and **instruction files document none of the project's real conventions**. None of these argue for changing the stack — they argue for ~half a day of instruction-file and CI setup before feature work, plus a test-runner decision in the health check.

**Recommended next step:** `/10x-health-check` — audit dependency health, confirm the missing test-suite and CI-coverage findings above, and produce the prioritized fix list. Apply the `AGENTS.md` and `verify.yml` additions from this document first; they remove the most agent-correction cycles per unit effort.
