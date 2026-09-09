---
project: artswipe
checked_at: 2026-09-09T17:05:10Z
health_status: critical-issues
context_type: brownfield
language_family: js
stack_assessment_available: true
checks_run:
  - lockfile
  - dependency_audit
  - outdated_deps
  - test_runner
  - ci_cd
  - configuration
audit_findings:
  critical: 0
  high: 0
  moderate: 0
  low: 0
test_runner_detected: false
ci_provider: GitHub Actions
recommended_fixes: 6
---

## Dependency Health

### Lockfile

```
Status: present (package-lock.json)
Package manager: npm
```

Dependency versions are pinned; builds are reproducible.

### Security Audit

```
Tool: npm audit --json
Summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW
Direct vs transitive: not applicable — no advisories
```

Clean. No known vulnerabilities in the dependency tree (direct or transitive).

### Outdated Dependencies

```
Packages with major version gaps: 3 (all dev dependencies)
```

- **@types/node**: 20.19.43 → 26.5.0 (6 major versions behind). Should track the runtime — the deploy target and modern tooling run Node 24 LTS or newer; the local toolchain here is Node 25. Pin to the major that matches the runtime you deploy on.
- **typescript**: 5.9.3 → 7.0.2 (skips the 6.x line; effectively 2 majors behind). TypeScript 7.x is a significant release; upgrade deliberately and run `npm run typecheck` immediately after.
- **eslint**: 9.39.5 → 10.10.0 (1 major behind). `eslint-config-next` must be bumped in lockstep — check its peer range before moving.

None are security-relevant and none block work. They are flagged because a large gap means a noisier upgrade later, and because `@types/node` drifting from the real runtime produces misleading type errors/omissions.

## Test Suite

```
Test runner: not detected
Tests found: not applicable
Test execution: not attempted
```

⚠ No test runner detected. No `test` script in `package.json`, no `vitest.config.*` / `jest.config.*` / `playwright.config.*`, and no `*.test.*` / `*.spec.*` files anywhere in `src/`. The agent cannot verify its own changes — every change requires manual checking, and regressions in untested branches (error paths, fallbacks) go unnoticed.

Recommended: **Vitest** — lowest-friction fit for a Next.js + TypeScript project.

```
npm install -D vitest @vitejs/plugin-react vite-tsconfig-paths jsdom @testing-library/react @testing-library/jest-dom
```

Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` scripts, a minimal `vitest.config.ts`, and start with smoke tests for the Server Actions in `src/app/actions/` and the pure helpers in `src/lib/`.

## CI/CD

```
Provider: GitHub Actions
Configuration: .github/workflows/migrations.yml
```

| Stage      | Status | Notes                                                          |
| ---------- | ------ | -------------------------------------------------------------- |
| Lint       | ✗      | not configured (`npm run lint` exists but no workflow runs it) |
| Test       | ✗      | not configured (no test runner)                                |
| Build      | ✗      | not configured (`npm run build` not run in CI)                 |
| Type check | ✗      | not configured (`npm run typecheck` exists but unused in CI)   |
| Security   | ✗      | not configured (no `npm audit` / Dependabot / CodeQL)          |

The one existing workflow (`migrations.yml`) deploys Supabase migrations on push to `main` — it is a deployment step, not a verification step. Nothing gates a pull request. Broken code that still parses can reach `main`.

This is partly a Category A gap (the lint/typecheck/build gate is cheap and high-value — see fix #2) and partly Category B (a full pipeline with preview environments, security scanning, and deploy orchestration comes with the infrastructure/CI setup step).

## Configuration

### High severity

None. `tsconfig.json` has `"strict": true`, `.gitignore` is present and correctly scoped (`.env*` ignored except `.env.example`), `eslint.config.mjs` is present, and `.env.example` documents both required environment variables with helpful comments.

### Medium severity

- **No code formatter** (`.prettierrc*` / `biome.json` absent; no `prettier` in dependencies). `eslint-config-next` enforces lint rules but does not auto-format. Without a formatter, agent-generated code drifts stylistically from hand-written code and diffs get noisy. Fix: add Prettier (see fix #3).

### Low severity

- **No `.editorconfig`.** Editors won't agree on indentation / newline / charset for non-JS files (SQL migrations, YAML, Markdown). Fix: add a 6-line `.editorconfig`.
- **No Node version pin** (`.nvmrc` absent, no `engines.node` in `package.json`). CI, contributors, and the deploy target can silently run different Node majors. Fix: add `.nvmrc` with `24` (or whatever major you deploy on) and/or `"engines": { "node": ">=24" }`.

## Stack Assessment Cross-Reference

```
Stack assessment: context/foundation/stack-assessment.md
Agent readiness (from stack-assess): ready-with-compensation
```

| Quality Gate Gap                                    | Health-Check Finding                                                                                                                     | Status     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Popular in training data: fail (Next.js 16 recency) | No type-check or build gate in CI — nothing catches an outdated Next.js pattern before merge                                             | Reinforced |
| No test feedback loop (workflow gap)                | Confirmed — no test runner, no tests, no test script                                                                                     | Reinforced |
| CI verifies only migrations (workflow gap)          | Confirmed — `migrations.yml` is the only workflow; no PR gate                                                                            | Reinforced |
| Instruction files carry no conventions              | `CLAUDE.md` / `AGENTS.md` exist but hold only the auto-generated Next.js block; stack-assess supplies a ready-to-paste conventions block | Actionable |

The two reports agree. Stack-assess judged the _stack_ sound but under-instrumented; health-check confirms the _project state_ matches — clean dependencies and strong local typing, but no automated verification and thin agent guidance.

## Recommended Fixes

### Fix before agent work (Category A)

### 1. No test runner

**Impact**: the agent cannot verify its own changes. The PRD's AI-enrichment work has explicit fault-tolerance guardrails ("upload still works with AI down", "AI never overwrites artist input") — exactly the kind of branching logic that rots silently without tests.
**Severity**: high
**Effort**: significant (> 1 hour to set up and write first meaningful tests)
**Fix**:

```
npm install -D vitest @vitejs/plugin-react vite-tsconfig-paths jsdom @testing-library/react @testing-library/jest-dom
```

Add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`. Create `vitest.config.ts` (react plugin + `vite-tsconfig-paths` for the `@/*` alias + `environment: 'jsdom'`). First targets: `src/app/actions/*.ts` and `src/lib/artworks/*.ts`.

### 2. No verification gate in CI

**Impact**: broken lint / types / build can merge to `main`. An agent opening a PR gets no pass/fail signal, so a human must catch everything manually.
**Severity**: high
**Effort**: moderate (15–30 min)
**Fix**: create `.github/workflows/verify.yml` running `npm ci` → `npm run lint` → `npm run typecheck` → `npm run build` (add `npm test` once fix #1 lands) on `pull_request` and `push` to `main`. The full YAML is in `context/foundation/stack-assessment.md` under "Recommended CI addition".

### 3. No code formatter

**Impact**: agent-generated code won't match the existing style; every agent diff carries incidental formatting churn that obscures the real change.
**Severity**: medium
**Effort**: quick (< 5 min)
**Fix**:

```
npm install -D prettier eslint-config-prettier
```

Add `.prettierrc.json` (`{}` is a valid start), a `"format": "prettier --write ."` script, and append `eslint-config-prettier` to the `eslint.config.mjs` array so ESLint stops fighting Prettier. Run `npm run format` once to normalize the tree in a single isolated commit.

### 4. Outdated dev-tooling dependencies

**Impact**: `@types/node` 6 majors behind the runtime gives the agent wrong Node API types; deferring TypeScript and ESLint majors makes the eventual upgrade a large, risky change instead of a small one.
**Severity**: medium
**Effort**: moderate (15–30 min, mostly verifying nothing broke)
**Fix**: bump one at a time, `npm run typecheck && npm run lint && npm run build` after each. Start with `@types/node` (align to the deployed Node major), then `eslint` + `eslint-config-next` together, then `typescript`.

### 5. No `.editorconfig`

**Impact**: minor — inconsistent whitespace in SQL / YAML / Markdown files the agent touches.
**Severity**: low
**Effort**: quick (< 5 min)
**Fix**: add a standard `.editorconfig` (`root = true`, `indent_style = space`, `indent_size = 2`, `end_of_line = lf`, `charset = utf-8`, `insert_final_newline = true`, `trim_trailing_whitespace = true`).

### 6. No Node version pin

**Impact**: CI, contributors, and the deploy target can drift onto different Node majors, producing "works on my machine" failures the agent can't diagnose.
**Severity**: low
**Effort**: quick (< 5 min)
**Fix**: add `.nvmrc` containing `24` and `"engines": { "node": ">=24" }` to `package.json`. Match whatever major your Vercel project runs.

### Addressed in upcoming steps (Category B)

### Agent instruction files are thin

**Step**: agent onboarding.
**What you'll do there**: `CLAUDE.md` / `AGENTS.md` currently hold only the auto-generated Next.js block. Agent onboarding walks through authoring the project conventions, feedback loops, and AI rules — `context/foundation/stack-assessment.md` already contains a ready-to-paste `## Project conventions (ArtSwipe)` block to seed it. Don't hand-stub it now; onboarding covers doing it properly.

### No full CI/CD pipeline or deployment configuration

**Step**: infrastructure & CI/CD setup.
**What you'll do there**: beyond the verification gate in fix #2, a complete pipeline (preview deployments, environment promotion, security scanning, deploy orchestration) is set up as part of infrastructure work. The migrations-deploy workflow is a partial start.

## Summary

```
Health status: critical-issues
```

The single reason for the `critical-issues` label is the **complete absence of a test feedback loop** — no runner, no tests, no test script — which the skill treats as a hard trigger regardless of everything else. It is not code rot: the dependency audit is clean (zero advisories), the lockfile is present, TypeScript runs in strict mode, ESLint is configured, `.gitignore` and `.env.example` are correct. The real picture is a well-typed, conventionally-structured codebase with no automated verification and thin agent guidance — every finding here is understood and cheaply fixable in roughly half a day.

Next step: land fixes #1 and #2 (test runner + verification CI) and paste the conventions block from the stack assessment into `AGENTS.md`, then proceed to agent onboarding. Fixes #3–#6 are quick wins that can go in the same session or the next.
