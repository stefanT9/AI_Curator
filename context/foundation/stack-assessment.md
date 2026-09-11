---
project: artswipe
assessed_at: 2026-09-11T08:40:02Z
agent_readiness: ready-with-compensation
context_type: brownfield
stack_components:
  language: TypeScript 5.9 (strict)
  framework: Next.js 16.3.4 (App Router) + React 19.2.8
  build_tool: Next.js built-in (next build) + Tailwind v4 via PostCSS
  test_runner: Vitest 4.1 (three configs)
  package_manager: npm
  ci_provider: GitHub Actions
  deployment_target: Vercel
gates_passed: 7
gates_partial: 2
gates_failed: 0
---

## Stack Components

- **Language — TypeScript `5.9.3`.** `tsconfig.json` sets `"strict": true`, `"noEmit": true`, `moduleResolution: "bundler"`, and a `@/*` → `./src/*` path alias. Database types are generated, never hand-edited (`npm run db:types:local` → `src/types/database.ts`); hand-written domain types live alongside in `src/types/domain.ts`. Runtime boundary validation is Zod `4.5`. `allowJs: true` and `skipLibCheck: true` are set, but no `.js` source exists — every file under `src/` is `.ts`/`.tsx`.

- **Framework — Next.js `16.3.4` (App Router) + React `19.2.8`.** File-based routing with route groups (`src/app/(app)/`, `src/app/(auth)/`, `src/app/(onboarding)/`), Server Actions grouped by domain in `src/app/actions/`, a route handler at `src/app/auth/confirm/route.ts`, and request interception at `src/proxy.ts` — Next.js 16's replacement for `middleware.ts`, which is absent as the version requires. `eslint-config-next@16.3.4` (core-web-vitals + typescript) wires the framework's own lint rules in `eslint.config.mjs`.

- **Build tool — Next.js built-in + Tailwind CSS v4.** `next build` / `next dev` with no custom bundler config beyond `next.config.ts` (a Supabase Storage remote-pattern allow-list plus a loopback-gated `dangerouslyAllowLocalIP` opt-in for the local seed corpus). Tailwind v4 runs CSS-first: `postcss.config.mjs` loads `@tailwindcss/postcss`, theme tokens live in an `@theme inline` block in `src/app/globals.css`, and **there is no `tailwind.config.js`** — v4 removed it.

- **Test runner — Vitest `4.1.11`, three isolated lanes.** `vitest.config.mts` (default, `test/**/*.test.ts`, Node environment, `server-only` aliased to a stub) is the only lane in CI. `vitest.integration.config.mts` (`test/integration/**/*.int.ts`) hits a real local Supabase stack and refuses any non-loopback host. `vitest.smoke.config.mts` (`test/smoke/**/*.live.ts`) calls OpenRouter for real. Each config carries its own glob so no lane can pick up another's specs. 15 spec files across the three lanes.

- **Package manager — npm.** `package-lock.json`; Node pinned to 24 in both `.nvmrc` and `engines`.

- **CI/CD — GitHub Actions, two workflows.** `.github/workflows/verify.yml` runs `format:check` → `lint` → `typecheck` → `test` → `build` on every PR and push to `main`, with placeholder Supabase env vars and `concurrency` cancel-in-progress. `.github/workflows/migrations.yml` deploys Supabase migrations on pushes touching `supabase/migrations/**`, with `cancel-in-progress: false` so a half-applied push cannot happen.

- **Deployment — Vercel.** Inferred from the `@vercel/analytics` dependency and stated in both the PRD and `AGENTS.md`. No `vercel.json` / `vercel.ts` — platform defaults for a standard Next.js app.

- **Backend / data — Supabase (Postgres, Auth, Storage).** Not one of the four scored components but central to the codebase. 20+ timestamp-ordered SQL migrations in `supabase/migrations/`, a seed corpus generated from a manifest (`supabase/seed-assets/corpus.json`), and three runtime-split client factories: `src/utils/supabase/client.ts` (browser), `server.ts` (cookie-aware, for Server Components / Actions), `proxy.ts` (session refresh). Row-Level Security is the stated security boundary.

- **AI — Vercel AI SDK `7.0.96` + `@openrouter/ai-sdk-provider` `3.0.0`.** Confined to `src/lib/ai/` (`enrich.ts`, `schema.ts`, `taxonomy.ts`, `index.ts`), behind a single never-throwing `enrichFromImage` entry point.

- **Instruction files — `CLAUDE.md` (a one-line `@AGENTS.md` include) + `AGENTS.md` (99 lines).** `AGENTS.md` documents the directory map, Supabase factory selection, migration and type-generation workflow, validation policy, the AI enrichment contract, formatting ownership, the three test lanes, and the verify gate. Also present: `.codex/hooks.json` with a lint hook, and a vendored `.agents/` skills tree.

## Quality Gate Assessment

| Component                               | Typed | Convention | Training Data | Documented | Verdict           |
| --------------------------------------- | ----- | ---------- | ------------- | ---------- | ----------------- |
| Language — TypeScript 5.9 (strict)      | ✓     | —          | —             | —          | pass              |
| Framework — Next.js 16.3.4 / React 19   | —     | ✓          | ~             | ✓          | pass-with-note    |
| Build tool — next build + Tailwind v4   | —     | ✓          | ~             | ✓          | pass-with-note    |
| Test runner — Vitest 4.1                | —     | —          | ✓             | ✓          | pass              |

Legend: ✓ = pass, ✗ = fail, ~ = partial, — = not applicable

**7 of 9 applicable gates pass outright; 2 are partial; none fail.**

Both partials are the same gap wearing two hats: **every load-bearing dependency in this stack is one or more majors ahead of where the bulk of model training data sits.** The frameworks themselves are as mainstream as it gets — the versions are not.

### Gate Details

#### Type safety — pass (language)

`tsconfig.json:7` sets `"strict": true` with `"noEmit": true`, and `npm run typecheck` (`next typegen && tsc --noEmit`) is a required CI step in `.github/workflows/verify.yml`. Typing is not merely available, it is enforced end to end: `src/types/database.ts` is generated from the live Postgres schema so table shapes cannot drift from the code, and `src/lib/ai/schema.ts` puts a Zod schema on the model's output — the one place in the app where untyped data enters. Zod `4.5` gates all external input at the boundary per the documented convention, verified in `src/app/actions/artworks.ts:37-66` and `src/app/actions/interactions.ts:12`.

No compensation needed.

#### Convention adherence — pass (framework and build tool)

Next.js App Router ships the conventions and this project follows them without deviation: route groups for the authenticated / signed-out / onboarding split, colocated layouts, `src/app/actions/*.ts` for mutations, `src/proxy.ts` for interception. The project layers its own conventions on top and documents them — `AGENTS.md` names the directory map, which Supabase factory belongs in which runtime, and that `src/types/database.ts` is generated. Every convention `AGENTS.md` claims was verified present on disk during this assessment: `src/proxy.ts` exists and `src/middleware.ts` does not; all three Supabase factories exist as described; the migrations directory is timestamp-ordered.

The build tool is zero-config by design. Tailwind v4's CSS-first setup is itself a convention (`@import "tailwindcss"` + `@theme inline` in `src/app/globals.css`), just not one that is written down anywhere in the repo — see the gap below.

No compensation needed for the convention gate itself.

#### Training-data familiarity — partial (framework and build tool)

Assessed within the JS/TS family, Next.js, React, Tailwind, Vitest and Zod are all top-tier choices — none is niche, forked, or short of a Stack Overflow corpus. The gate scores partial for a different reason: **the specific majors in use postdate most models' internalized idioms, and the drift is behavioral, not cosmetic.** Concretely, verified in this codebase:

| Where | This codebase (current) | What an older-trained agent writes | Evidence |
| --- | --- | --- | --- |
| Interception | `src/proxy.ts` | `src/middleware.ts` | `src/proxy.ts` exists; no `middleware.ts` |
| Async request APIs | `await cookies()` / `await headers()` | sync destructuring | `AGENTS.md` "Version discipline" |
| Zod formats | `z.uuid({ error: "…" })` | `z.string().uuid({ message: "…" })` | `src/app/actions/interactions.ts:12`, `artworks.ts:209` |
| Zod error key | `{ error: "…" }` | `{ message: "…" }` | `src/app/actions/artworks.ts:37-66` |
| Structured AI output | `generateText` + `Output.object` | `generateObject` | `src/lib/ai/enrich.ts:3-10` |
| React form state | `useActionState` | `useFormState` | `src/components/auth/LoginForm.tsx:8` |
| React refs | `ref` as a plain prop | `forwardRef` wrapper | zero `forwardRef` occurrences in `src/` |
| Tailwind theming | `@theme inline` in CSS | `tailwind.config.js` | no `tailwind.config.*` exists |
| Vitest path aliases | `resolve.tsconfigPaths: true` | `vite-tsconfig-paths` plugin | `vitest.config.mts:5` |

The risk this creates is not that an agent fails to write code — it is that an agent **regresses working code while "fixing" it**: rewriting `z.uuid({ error })` into the deprecated `z.string().uuid({ message })`, swapping `generateText`/`Output.object` for `generateObject`, or creating a `tailwind.config.js` that Tailwind v4 will ignore. Each of those passes a casual review and breaks or silently no-ops.

This is the gap that earns the `ready-with-compensation` verdict, and it is the only one.

Vitest scores a full pass: it is the mainstream JS test runner with no credible training-data shortfall, and the one v4-specific API in play (`resolve.tsconfigPaths`) sits in a config file an agent rarely rewrites.

#### Documentation quality — pass (framework, build tool, test runner)

Next.js ships **version-exact docs inside the installed package** at `node_modules/next/dist/docs/` (`01-app/`, `02-pages/`, `03-architecture/`, `04-community/`), verified present. This is materially better than a versioned docs website: the docs on disk cannot be a different version from the framework on disk, and `AGENTS.md` already directs agents to read the matching guide there before touching routing, caching, `cookies()`/`headers()`, Server Actions, or `next/image`. Tailwind, Vitest and Zod all publish current versioned official docs; the AI SDK's docs are current for v7.

No compensation needed.

## Gaps & Compensation

### Gap 1 — version-drift discipline is documented for Next.js only

**What failed:** the training-data gate, on framework and build tool.

**Why it matters for agent workflows:** `AGENTS.md` opens with an excellent, emphatic rule — "This is NOT the Next.js you know" — and tells the agent to read `node_modules/next/dist/docs/` before writing routing or caching code. That rule is doing real work, and it covers exactly one dependency. React 19, Tailwind v4, Zod 4, AI SDK 7 and Vitest 4 carry the same kind of drift with no equivalent guard, and the table above shows all five are actively exercised in the source. An agent reading `AGENTS.md` today correctly concludes it must not trust its memory of Next.js, and incorrectly concludes it may trust its memory of everything else.

**Compensation:** extend the existing "Version discipline" section from one dependency to the whole stack, naming the specific idiom pairs rather than issuing a general "check the version" instruction. Named pairs are what make the rule enforceable — an agent can pattern-match on `z.string().uuid` and stop; it cannot pattern-match on "be careful."

### Gap 2 — Tailwind v4 has no rule at all

**What failed:** the training-data gate, on the build tool, in its sharpest form.

**Why it matters:** Tailwind v4 is named once in `AGENTS.md`, in the stack list, with no accompanying convention. There is no `tailwind.config.js` in this repo and there must not be one — v4 moved theming into CSS (`@theme inline` in `src/app/globals.css:8`). Creating that file is the single most likely unprompted mistake an agent makes here, and it fails silently: the file is simply ignored, the tokens never apply, and the diff looks entirely reasonable.

**Compensation:** an explicit styling section stating where theme tokens live and that the JS config file is gone.

### Gap 3 — `lefthook.yml` is inert scaffolding (minor, non-gate)

**What it is:** `lefthook.yml` sits at the repo root containing nothing but the generator's commented-out example block, and `lefthook` appears in neither `dependencies` nor `devDependencies`. No git hook runs from it.

**Why it matters:** an agent (or a new contributor) reading the root file list reasonably infers that formatting and linting run automatically pre-commit, and skips `npm run format` before committing. `AGENTS.md` correctly says to run `npm run format` manually — but the presence of the file quietly contradicts it, and CI's `format:check` then fails the PR.

**Compensation:** either delete the file or state in `AGENTS.md` that it is inactive. This is not a gate failure; it is a legibility fix worth one line.

### Recommended Instruction File Additions

Ready to paste into `AGENTS.md`. The first block **replaces** the existing `### Version discipline — this is Next.js 16, not 13/14/15` section, keeping its three bullets intact and widening its scope; the other two are new sections.

```markdown
### Version discipline — the whole stack is ahead of your training data

Next.js 16, React 19, Tailwind 4, Zod 4, AI SDK 7 and Vitest 4 all changed APIs
in ways your memory of the previous major will get wrong. The failure mode is
not writing code that errors — it is "fixing" correct code into the older idiom.
Before rewriting something that already works, check it against this table.

| Area | Correct here | The stale idiom — do not introduce it |
| --- | --- | --- |
| Request interception | `src/proxy.ts` | `middleware.ts` (does not exist in Next 16) |
| Request APIs | `await cookies()`, `await headers()` | sync `cookies()` / `headers()` |
| Zod string formats | `z.uuid()`, `z.email()`, `z.url()` | `z.string().uuid()`, `.email()`, `.url()` |
| Zod error messages | `{ error: "…" }` | `{ message: "…" }` |
| Structured model output | `generateText` + `Output.object` | `generateObject` |
| React form state | `useActionState` (returns `[state, action, pending]`) | `useFormState` + separate `useFormStatus` |
| React refs | `ref` passed as a normal prop | `forwardRef` wrappers |
| Vitest path aliases | `resolve.tsconfigPaths: true` | the `vite-tsconfig-paths` plugin |

- Before writing or changing routing, caching, `cookies()`/`headers()` usage,
  Server Actions, or `next/image`, read the matching guide under
  `node_modules/next/dist/docs/`. Those docs ship with the installed package, so
  they always match the version in `node_modules` — prefer them over memory and
  over the public docs site.
- `cookies()` and `headers()` are async — always `await` them.
- There is no `middleware.ts`. Request interception lives in `src/proxy.ts`.
```

```markdown
### Styling — Tailwind v4, CSS-first

- **There is no `tailwind.config.js` and you must not create one.** Tailwind v4
  removed it; a config file added here is silently ignored, so the mistake shows
  up as styles that never apply rather than as an error.
- Tailwind is loaded with `@import "tailwindcss";` at the top of
  `src/app/globals.css`. The PostCSS wiring is `@tailwindcss/postcss` in
  `postcss.config.mjs` — nothing else is needed.
- Theme tokens (colors, fonts, spacing scales) are declared in the
  `@theme inline { … }` block in `src/app/globals.css`, and CSS custom properties
  on `:root` back them. Add or change design tokens there, not in JS.
```

```markdown
### Git hooks

`lefthook.yml` at the repo root is unused scaffolding — every job in it is
commented out and `lefthook` is not installed. No hook runs on commit or push.
Run `npm run format` yourself before committing; CI's `format:check` is the only
thing that will catch you, and it fails the PR rather than fixing the file.
```

## Summary

**Verdict: ready-with-compensation** — and the compensation is mostly already written.

This stack is close to a best case for agent work. Every scored component passes on convention adherence and documentation; TypeScript runs strict with generated database types and Zod at every external boundary; and the verify gate (`format:check` → `lint` → `typecheck` → `test` → `build`) runs identically in CI and locally, which gives an agent a fast, authoritative, five-command answer to "did I break it?" The three-lane test split with per-lane globs is unusually disciplined — an agent cannot accidentally run integration specs against a linked project, because `test/integration/setup.ts` throws on any non-loopback host. `AGENTS.md` is already a strong instruction file: it documents the directory map, the Supabase factory split, the migration workflow, and the AI enrichment contract, and every structural claim in it was verified true on disk during this assessment.

**Key strength:** Next.js ships version-exact docs inside `node_modules`, and `AGENTS.md` already points the agent at them. That combination closes the documentation gate completely for the riskiest dependency in the stack.

**Key gap:** the version-discipline rule that makes Next.js safe here is scoped to Next.js alone. React 19, Tailwind 4, Zod 4 and AI SDK 7 carry the same drift, are all actively used in the source, and have no equivalent guard. The characteristic failure is regression during unrelated edits — an agent tidies `z.uuid({ error })` into `z.string().uuid({ message })`, or adds a `tailwind.config.js` that does nothing. The three instruction-file blocks above close that gap; the Tailwind one is the highest-value single addition, because its failure mode is silent.

**Delta since the 2026-09-09 assessment.** Three of the four gaps recorded then are closed: a test runner now exists (Vitest, three lanes, 15 spec files), CI now verifies every PR (`verify.yml`, five steps), and `AGENTS.md` grew from an auto-generated stub to 99 lines of project-specific convention. Gate count moved from 3-of-4 with one failure to 7-of-9 with zero failures and two partials.

**Recommended next step:** `/10x-health-check` — it reads this file and will focus on the dependency and configuration surface rather than re-deriving the stack.
