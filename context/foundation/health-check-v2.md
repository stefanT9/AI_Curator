---
project: artswipe
checked_at: 2026-09-11T08:53:54Z
health_status: needs-attention
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
test_runner_detected: true
ci_provider: GitHub Actions
recommended_fixes: 6
---

## Dependency Health

### Lockfile

```
Status: present (package-lock.json)
Package manager: npm
```

Node is pinned twice — `.nvmrc` and `engines.node` (`>=24`) — and CI reads the
pin from `.nvmrc` via `actions/setup-node`'s `node-version-file`, so the local
and CI toolchains cannot drift apart silently.

### Security Audit

```
Tool: npm audit --json
Summary: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW
Direct vs transitive: not applicable — no advisories at any depth
Dependency tree: 574 total (41 prod, 496 dev, 149 optional)
```

A clean audit across the whole tree. Nothing to triage.

One supply-chain detail worth recording as a strength rather than a finding:
`package.json` carries an `allowScripts` allow-list with exactly one entry
(`esbuild@0.28.2`). Install-time lifecycle scripts are the usual npm
supply-chain vector, and this project has narrowed that surface to a single
reviewed package.

### Outdated Dependencies

```
Packages with major version gaps: 3
```

All three are **deliberate holds**, not neglect — and two are already justified
in `AGENTS.md`:

- **eslint**: `9.39.5` → `10.10.0` (1 major behind). Held on purpose.
  `AGENTS.md` states ESLint 10 breaks `eslint-config-next`'s React plugin.
- **typescript**: `5.9.3` → `7.0.2` (2 majors behind). Held on purpose. The
  `typescript-eslint` bundled by `eslint-config-next@16.3.4` caps at
  `<6.1.0`, so TS 6 and 7 are both out of reach until that config moves.
- **vitest**: `4.1.11` → `5.0.0` (1 major behind). **This one is undocumented.**
  Unlike the two above, no note in `AGENTS.md` explains why the project sits on
  Vitest 4, so a future agent has no way to tell a deliberate pin from a stale
  one — and three separate Vitest configs make an unplanned major bump an
  expensive mistake to discover late.

Minor drift, all safe and all within the declared `^` ranges — no action
required, listed only for completeness:

- `zod` `4.5.4` → `4.6.2`
- `@types/react` / `@types/react-dom` `19.2.x` → `19.3.0`
- `ai` `7.0.96` → `7.0.97`
- `react` / `react-dom` `19.2.8` → `19.3.0` (pinned exactly, no caret — an
  intentional lock to match `next@16.3.4`)

Note: `npm outdated` reports `@types/node` "latest" as `22.20.2` against a
current `26.5.0`. That is an npm dist-tag artifact, not a downgrade — the
package's `latest` tag trails its actual newest release. No action.

## Test Suite

```
Test runner: Vitest 4.1.11
Tests found: 213 across three lanes (184 default + 28 integration + 1 smoke spec)
Test execution: default lane passing; integration lane FAILING (1 of 28)
```

```
Configuration: vitest.config.mts · vitest.integration.config.mts · vitest.smoke.config.mts
Framework: Vitest 4.1.11, Node environment (no jsdom)
```

Three lanes, each with its own config and its own file glob so no lane can pick
up another's specs. Verified by execution, not by reading:

| Lane | Command | Result |
| --- | --- | --- |
| Default | `npm run test` | **16 files, 184 tests, all passing in 637 ms** |
| Integration | `npm run test:integration` | **4 files, 28 tests — 1 failing** |
| Smoke | `npm run test:smoke` | 1 spec, not executed (calls OpenRouter for real) |

The default lane is genuinely fast — sub-second end to end — which is what makes
it usable as an inner-loop check rather than something an agent avoids running.

**The integration lane is red on `main`.** One spec fails:

```
FAIL test/integration/storage-boundary.int.ts > Storage RLS policies
     > does NOT let an artist delete an object in their own folder (recorded)
AssertionError: expected false to be true
  at test/integration/storage-boundary.int.ts:251
```

This is **not** a security regression — the investigation is written up as
Category A fix #1 below. In short: the test records a behaviour that a later
migration deliberately fixed, and the test was never updated to match.

Two lane behaviours worth recording as strengths:

- The loopback guard works. Invoking the integration config without its env file
  produced a clean refusal from `requireLocalRunningStack`
  (`test/integration/setup.ts:110`) rather than an attempt against whatever
  `.env.local` points at. The lane cannot be pointed at the linked project by
  accident.
- Fixtures run under real RLS with no service-role key, so the lane tests the
  same security boundary a real user crosses.

## CI/CD

```
Provider: GitHub Actions
Configuration: .github/workflows/verify.yml · .github/workflows/migrations.yml
```

| Stage      | Status | Notes                                                             |
|------------|--------|-------------------------------------------------------------------|
| Lint       | ✓      | `npm run lint` (ESLint 9 + eslint-config-next)                     |
| Test       | ✓      | `npm run test` (Vitest default lane only — by design)              |
| Build      | ✓      | `npm run build` (`next build`)                                     |
| Type check | ✓      | `npm run typecheck` (`next typegen && tsc --noEmit`)               |
| Security   | ✗      | no audit step, no Dependabot, no CodeQL                            |

Also present and not covered by the standard table: a **format** stage
(`npm run format:check`), which runs first in `verify.yml`.

`verify.yml` runs the full five-command gate on every PR and every push to
`main`, with `concurrency.cancel-in-progress: true` so a superseded run stops
burning minutes. `migrations.yml` deploys Supabase migrations on pushes touching
`supabase/migrations/**` with `cancel-in-progress: false` — the correct inverse,
since a half-applied migration push is worse than a queued one. Both files carry
comments explaining *why* those concurrency choices differ, which is exactly the
context an agent needs before editing them.

I ran the full local gate to confirm CI is telling the truth:

| Command | Result |
| --- | --- |
| `npm run format:check` | ✓ pass — all matched files already Prettier-clean |
| `npm run lint` | ✓ pass — zero warnings |
| `npm run typecheck` | ✓ pass |
| `npm run test` | ✓ pass — 184/184 |
| `npm run build` | ✓ pass — 17 routes, proxy compiled |

The gate is green and reproducible locally. That five-command answer to "did I
break it?" is the single most valuable thing this project gives an agent.

The one gap is the missing security stage — see Category A fix #3.

## Configuration

### High severity

None. Every high-severity item on the checklist is present and correct:
`.gitignore`, `tsconfig.json` with `"strict": true`, and both agent instruction
files (`CLAUDE.md` → `@AGENTS.md`).

### Medium severity

- **CI security scanning** — no `npm audit` step, no Dependabot config, no
  CodeQL. The tree is clean *today* (verified above), but nothing will tell you
  when that stops being true. Fix: Category A #3.

### Low severity

- **`lefthook.yml`** — present at the repo root but inert: every job is
  commented-out generator boilerplate and `lefthook` is in neither
  `dependencies` nor `devDependencies`. No hook runs. Fix: Category A #4.
- **`.env.push.example`** — exists on disk but is matched by the `.env*` rule in
  `.gitignore` with no `!` exception, unlike `.env.example` which has one. It is
  untracked, so it never reaches a clone. Fix: Category A #5.

Everything else checked out as present and substantive:

| File | Status |
| --- | --- |
| `.editorconfig` | ✓ mirrors the Prettier core rules |
| `.prettierrc.json` | ✓ + `.prettierignore` scoping out generated/vendored trees |
| `eslint.config.mjs` | ✓ flat config, `eslint-config-prettier` last so it wins |
| `tsconfig.json` | ✓ `strict: true`, `@/*` path alias |
| `.gitignore` | ✓ annotated — explains *why* `.env*` and the corpus are ignored |
| `.env.example` | ✓ **complete** — all 7 real env keys, each with a comment |
| `CLAUDE.md` / `AGENTS.md` | ✓ present, 99 lines of project-specific convention |

`.env.example` deserves a specific call-out. I diffed every `process.env.*` read
across `src/`, `scripts/` and `test/` against its keys: 7 of 7 documented
variables match, and the only two undocumented reads (`SMOKE_IMAGE`,
`SMOKE_OUT`) are per-invocation CLI knobs documented in the header comment of
`test/smoke/enrich.live.ts` where they belong. It also explicitly warns that the
`PUSH_*` block goes in `.env.push.local` and never `.env.local` — pre-empting
the exact footgun that separation exists to prevent.

## Stack Assessment Cross-Reference

```
Stack assessment: context/foundation/stack-assessment.md
Agent readiness (from stack-assess): ready-with-compensation
```

The stack assessment's verdict was conditional — "ready **with compensation**" —
and it supplied three ready-to-paste `AGENTS.md` blocks as that compensation.
**None of the three has landed.** I grepped `AGENTS.md` for each:

| Quality Gate Gap | Health-Check Finding | Status |
|---|---|---|
| training-data: partial (framework) — version discipline scoped to Next.js only | `AGENTS.md:19` still reads "this is Next.js 16, not 13/14/15". No stale-idiom table. React 19 / Zod 4 / AI SDK 7 / Vitest 4 still unguarded. | **Reinforced** |
| training-data: partial (build tool) — Tailwind v4 has no rule | Zero occurrences of a styling section in `AGENTS.md`; `tailwind` appears only once, in the stack list at line 15. | **Reinforced** |
| non-gate — `lefthook.yml` is inert scaffolding | Confirmed still inert; no `AGENTS.md` note, file not deleted. | **Reinforced** |
| typed: pass | `tsconfig` strict ✓ **and** `typecheck` enforced in CI ✓ — verified passing. | **Mitigated** |
| convention: pass | Verified on disk: `src/proxy.ts` exists, `src/middleware.ts` does not; all three Supabase factories present. | **Mitigated** |
| documented: pass | `node_modules/next/dist/docs/` present; `AGENTS.md` points agents at it. | **Mitigated** |

The pattern is clean: every gate the assessment scored as **passing** is
confirmed still passing by independent checks here, and every gate it scored as
**partial** is still partial because the prescribed fix was never applied. The
compensation is written and sitting in `stack-assessment.md` lines 130–179 —
it just has not been moved into the file agents actually read.

### Scope-of-change note (PRD v3 — auctions)

`context/foundation/prd-v3.md` is a brownfield PRD whose central mechanism is
**sealed bidding**: FR-006 and FR-007 require that the standing high bid is
never visible to anyone — bidder, seller or onlooker — before close. That is a
confidentiality property, and in this codebase confidentiality is enforced by
Row-Level Security, which `AGENTS.md` names as the security boundary.

The only tool in this project that can actually *prove* an RLS policy hides what
it should is the integration lane — and that lane is currently red. This is the
sharpest reason fix #1 is ranked first: the auction work needs that lane
trustworthy before it starts, not after.

Two further observations for planning rather than for this report's fix list:
FR-008 (auctions close automatically at their end time) has no scheduling
mechanism in the project today — no `pg_cron`, no cron route, nothing across the
13 migrations — and FR-003/004/009/010 require outbound transactional email,
which likewise does not exist yet (`supabase/config.toml` has only the local
Inbucket SMTP used for auth mail in development). Both are new infrastructure,
correctly belonging to the roadmap rather than to project health.

## Recommended Fixes

### Fix before agent work (Category A)

### 1. The integration lane is red — a recorded test outlived the behaviour it recorded

**Impact**: This is the highest-value finding in the report, and it is not what
it first looks like. The failing assertion is
`expect(existsAfter).toBe(true)` — the test asserts that an artist deleting
their *own* storage object is a silent no-op, and the object now actually gets
deleted. That reads like an RLS regression. It is the opposite.

The test is explicitly labelled `(recorded)` and its own comment block
(`test/integration/storage-boundary.int.ts:227-239`) documents the behaviour as
**"Recorded, not desired"**, explains the cause — `storage-api` lists objects
before deleting them, and no SELECT policy on `storage.objects` existed — and
predicts the fix: *"Add a SELECT policy to make cleanup work."*

That policy landed. `supabase/migrations/20260911000000_add_artwork_storage_select.sql`
(commit `9ce9866`, merged in PR #17 as part of `push-corpus-to-prod`) adds
exactly it. So `remove()` now works, image cleanup now works, and the test
recording the old broken behaviour is the only thing still asserting otherwise.

The consequence the comment flagged is also now live: it warned that once the
policy exists, the "cleanup orphans a live row's image" path becomes reachable
and *"the Phase 4 guard in `createArtwork` is what stops it."* I verified that
guard is in place — `src/app/actions/artworks.ts:156-176` re-queries for a row
with the same `image_path` and skips the `remove()` if one exists. The safety
property holds. But it is now load-bearing in a way it was not before, and no
test covers it at the real boundary.

Left as-is this costs you twice: an agent running the lane sees red and either
"fixes" it by reverting a deliberate security improvement, or learns that red is
normal here and stops trusting the lane entirely. The second is worse.

**Severity**: high
**Effort**: moderate (15–30 min)
**Fix**:

Rewrite the spec to assert the current, desired behaviour. Rename it, invert the
assertions, and replace the stale comment with one pointing at the migration:

```bash
# 1. Confirm the diagnosis for yourself — the policy that changed this:
cat supabase/migrations/20260911000000_add_artwork_storage_select.sql

# 2. Edit test/integration/storage-boundary.int.ts around line 226:
#      - rename: "lets an artist delete an object in their own folder"
#      - expect(existsAfter).toBe(false)
#      - expect the public URL fetch to 404, not 200
#      - replace the "Recorded, not desired" block with a note naming
#        20260911000000_add_artwork_storage_select.sql as the reason
#
# 3. While you are in there, add the coverage the old comment asked for:
#      a case proving createArtwork's re-query guard (artworks.ts:156-176)
#      does NOT remove an image when a row with that image_path exists.

npm run test:integration   # expect 28/28
```

### 2. Move the stack assessment's three compensation blocks into `AGENTS.md`

**Impact**: `stack-assessment.md` returned `ready-with-compensation` and wrote
the compensation out in full — three paste-ready blocks. Until they are in
`AGENTS.md`, the project is running on the *unconditional* half of a conditional
verdict. The characteristic failure is not an agent that cannot write code; it
is an agent that regresses working code while tidying it — rewriting
`z.uuid({ error })` into the deprecated `z.string().uuid({ message })`, swapping
`generateText` + `Output.object` for `generateObject`, or creating a
`tailwind.config.js` that Tailwind v4 silently ignores. Each passes a casual
review. The Tailwind one is the most dangerous because it fails silently: the
file is ignored, the tokens never apply, and the diff looks entirely reasonable.

Note that `AGENTS.md` already proves this technique works — its emphatic "This
is NOT the Next.js you know" opener is doing real work today. The gap is only
that it covers one dependency out of six that carry the same drift.

**Severity**: medium (high for the Tailwind block specifically — silent failure)
**Effort**: quick (< 5 min — the content is already written)
**Fix**:

```bash
# The three blocks are in stack-assessment.md, lines 130-179:
#   1. "Version discipline — the whole stack is ahead of your training data"
#      → REPLACES the existing "### Version discipline" section (AGENTS.md:19)
#   2. "Styling — Tailwind v4, CSS-first"        → new section
#   3. "Git hooks"                                → new section (see fix #4)
sed -n '130,179p' context/foundation/stack-assessment.md

# Paste blocks 1 and 2 into AGENTS.md, then:
npm run format:check
```

Take block 3 only if you keep `lefthook.yml` — see fix #4.

### 3. Add a security stage to CI

**Impact**: The dependency tree is clean today — I verified 0 advisories across
574 packages. Nothing in the pipeline will tell you when that changes. Every
other quality property this project cares about is enforced automatically in
`verify.yml`; dependency security is the one that relies on someone remembering
to look. For a project heading into auction work that handles bids and contact
exchange, that asymmetry is worth closing while it costs nothing.

**Severity**: medium
**Effort**: quick (< 5 min)
**Fix**:

Add one step to `.github/workflows/verify.yml`, after `npm ci`:

```yaml
      - run: npm audit --audit-level=high
```

`--audit-level=high` fails the build on HIGH and CRITICAL only, so moderate
advisories in the dev tree do not block a PR. Optionally also add
`.github/dependabot.yml` for automated bump PRs:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    groups:
      dev-dependencies:
        dependency-type: development
```

If you add Dependabot, keep the eslint/typescript holds from the Outdated
section in mind — consider `ignore` entries for those two so it does not open
PRs that CI will reject.

### 4. Resolve `lefthook.yml` — delete it or declare it inactive

**Impact**: The file's presence at the repo root implies formatting and linting
run automatically pre-commit. They do not — every job in it is commented-out
boilerplate and `lefthook` is not installed. An agent or a new contributor who
reasonably infers a pre-commit hook skips `npm run format`, and CI's
`format:check` — which runs *first* in `verify.yml` — fails the PR on
whitespace. `AGENTS.md` correctly says to run `npm run format` manually; the
file quietly contradicts it.

**Severity**: low
**Effort**: quick (< 5 min)
**Fix**:

Pick one. Deleting is cleaner:

```bash
git rm lefthook.yml
```

Or, if you intend to wire lefthook up later, keep it and paste block 3 from
`stack-assessment.md` (lines 172–179) into `AGENTS.md` so the file's inert
status is documented rather than inferred.

### 5. Un-ignore `.env.push.example` so it reaches a clone

**Impact**: `.gitignore:36` matches `.env*` and grants exactly one exception,
`!.env.example`. `.env.push.example` has no such exception, so it sits on your
disk, is never tracked, and never reaches anyone who clones the repo. The
asymmetry is the problem: someone reading the root file list locally sees a
template that a fresh clone does not have.

This is genuinely minor because the content is not lost — `.env.example` already
documents all four `PUSH_*` variables with the "goes in `.env.push.local`, never
`.env.local`" warning, and `supabase/seed-assets/README.md:111-120` inlines the
same block. A reader can construct the file from either.

**Severity**: low
**Effort**: quick (< 5 min)
**Fix**:

Either track it, for symmetry with `.env.example`:

```bash
# add to .gitignore next to the existing !.env.example line:
#   !.env.push.example
git add -f .env.push.example
```

Or delete it as redundant, since two committed files already carry the content:

```bash
rm .env.push.example
```

### 6. Record why Vitest is held at 4.x

**Impact**: `AGENTS.md` explains the ESLint 9 and TypeScript 5 holds precisely —
naming `eslint-config-next@16.3.4`'s `<6.1.0` cap and the React plugin
breakage. The Vitest 4 hold has no such note, so it is indistinguishable from
neglect. An agent tidying dependencies has a documented reason to leave ESLint
and TypeScript alone and no reason to leave Vitest alone. A major bump touching
three separate configs and a loopback guard is not something you want discovered
by an unrelated PR going red.

**Severity**: low
**Effort**: quick (< 5 min)
**Fix**:

Add one line to the version-pinning paragraph in `AGENTS.md` (the one beginning
"ESLint stays on 9.x and TypeScript on 5.x") stating whether Vitest 4 is a
deliberate hold and why — or, if it is not deliberate, plan the bump as its own
change so the three configs and `test/integration/setup.ts` move together.

### Addressed in upcoming lessons (Category B)

**None outstanding.** This is the notable result of the check. The three items
that normally land here are all already in place:

- **CI/CD pipeline** — present and comprehensive. `verify.yml` runs five gates
  on every PR and push to `main`; `migrations.yml` handles schema deploys with
  correctly inverted concurrency. Covered by
  [Sprint Zero z Agentem: infrastruktura, walking skeleton i pierwszy deploy (M1L5)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l5)
  — nothing left to do there for this project.
- **Agent instruction files** — `CLAUDE.md` and a 99-line `AGENTS.md` are
  present and project-specific. Covered by
  [Agent Onboarding: Agents.md, AI Rules i feedback loops (M1L4)](https://platforma.przeprogramowani.pl/external/10xdevs-3/m1-l4).
  Fix #2 above is a *content* improvement to a file that already exists, not a
  missing-file gap, which is why it sits in Category A.
- **Deployment configuration** — Vercel, with platform defaults for a standard
  Next.js app. No `vercel.json` is needed and its absence is not a gap.

## Summary

```
Health status: needs-attention
```

This project is in strong shape and the verdict is narrower than the label
suggests. The dependency tree is completely clean (0 advisories across 574
packages), install-time scripts are narrowed to a single allow-listed package,
the five-command verify gate passes locally exactly as it does in CI, and the
configuration surface has no high-severity gaps — `.env.example` documents 7 of
7 real environment variables, `tsconfig` runs strict, and both CI workflows
carry comments explaining their concurrency choices. The default test lane runs
184 tests in 637 ms, which is fast enough that an agent will actually run it.

The verdict is `needs-attention` for two reasons, and only two. First, the
integration lane is red on `main` — not from a regression, but because a
deliberately-`(recorded)` test outlived the migration that fixed the behaviour
it recorded; a red lane teaches an agent either to revert a security improvement
or to stop trusting the lane, and the second is worse. Second, the stack
assessment's `ready-with-compensation` verdict is running without its
compensation: all three prescribed `AGENTS.md` blocks are still sitting
unapplied in `stack-assessment.md`. Both are cheap to close — fix #1 is half an
hour, fix #2 is a paste — and neither is a design problem.

**Delta since the 2026-09-09 check** (`health-check.md`, verdict
`critical-issues`, 6 fixes): the two structural gaps that drove that verdict are
gone. A test runner now exists — Vitest across three isolated lanes, 213 specs,
with a loopback guard I confirmed refuses to run against anything but a local
stack — and CI now verifies every PR across five gates. The remaining six fixes
are a different class of item entirely: one stale test, one paste-in
documentation gap, and four small hygiene nits. The project moved from *missing
infrastructure* to *tuning infrastructure that exists*.

**Next step**: close fixes #1 and #2 — they are the only two that change how
an agent behaves. Fix #1 first: PRD v3's sealed-bid mechanism (FR-006/007)
rests on an RLS confidentiality guarantee, and the integration lane is the only
tool in this project that can prove such a guarantee holds. It should be green
and trusted before the auction work starts. Fixes #3–#6 are hygiene and can ride
along with any convenient PR. Then proceed to agent onboarding.
