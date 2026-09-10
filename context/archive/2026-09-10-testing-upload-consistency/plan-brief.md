# Real-boundary lane and upload consistency — Plan Brief

> Full plan: `context/changes/testing-upload-consistency/plan.md`
> Research: `context/changes/testing-upload-consistency/research.md`

## What & Why

Rollout Phase 1 of the test plan, covering Risk #1: an artwork is published whose stored image key resolves to nothing, so the card renders as a grey box for every collector and the artist's piece is effectively lost. Every top risk in this project lives at the database or storage boundary, and the existing suite mocks Supabase at exactly that seam — so this phase must build the lane that can see the boundary before it can prove anything about it.

## Starting Point

The image is uploaded from the browser, then `createArtwork` checks the key exists and inserts the row; if the insert reports an error, two independent deleters remove the object. No test observes any of it: `test/actions/artworks.test.ts` mocks `createClient` to throw, so every assertion stops at the Zod gate. There is no integration lane, no seed file, and no service-role key.

## Desired End State

One command against a running local stack exercises real Postgres, real Storage and real RLS. The suite records what the publish-time existence check actually does, proves a published artwork is retrievable **at the URL the collector's browser requests**, and fails if a publish can leave a row whose image was deleted. `npm run test`, CI and the verify gate stay fully mocked and untouched.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| What Risk #1 actually is | The cleanup deleting a live row's image, not a failed upload leaving a row | The plan's stated direction is structurally impossible — the row is written last | Research |
| Fix scope | Tests plus the two cheap fixes | Leaving a proven broken-card path on main to preserve phase purity is hard to justify | Plan |
| Lane targets | Storage boundary directly, then `createArtwork` via a hybrid harness | The first needs no Next runtime; the second is the only way to reach the seam where the risk lives | Plan |
| CI posture | Local opt-in now; gating decided in Phase 4 | Preserves the deterministic, fast verify gate and matches the `.live.ts` precedent | Plan |
| Isolation | Per-run users with RLS-scoped self-cleanup | Avoids the service-role key `.env.example` warns against, and exercises teardown under real RLS | Plan |
| AGENTS.md | Narrow the rule, document all three lanes | The smoke lane is already undocumented, so one edit closes an existing gap | Plan |
| The existence check | Pin real behavior first, change it only if proven wrong | Its route mismatch is an empirical unknown, not something source can settle | Research + Plan |

## Scope

**In scope:** a third Vitest config with a disjoint glob and its own script; a local-only guard and stack health check; a test-user helper; storage-boundary characterization tests; `createArtwork` consistency tests; a guard on the compensating delete; a `check` constraint on `image_path`; the AGENTS.md amendment.

**Out of scope:** any CI job; `supabase/seed.sql` and fixture frameworks (owned by `ranking-eval-corpus`); a service-role key; `ArtCard` fallbacks or read-path filtering; changes to the mocked suite; anything in rollout Phases 2-4.

## Architecture / Approach

The lane copies the existing live-smoke pattern: a standalone config (never `mergeConfig`, which concatenates `include` arrays) with a `test/integration/**/*.int.ts` glob that neither `npm run test` nor CI can match. Tests build a plain `supabase-js` client with the anon key and sign in, so RLS applies exactly as in production. Storage tests need nothing else; `createArtwork` tests mock `@/utils/supabase/server` to hand back that real client while `next/navigation` and `next/cache` stay mocked — a pattern the existing action tests already use. Two rails run throughout: the suite refuses to run against a non-local URL, and infrastructure commands are the developer's to run, never the implementer's.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Lane foundation | Config, script, local-only guard, user helper, first end-to-end assertion, AGENTS.md amendment | Signup rate limit (30 per 5 min) flakes the suite if users are minted per test |
| 2. Pin the storage boundary | Characterization of `.exists()` across both routes, unusable objects, folder RLS, bucket limits | The two routes may disagree, which changes what Phase 4 must fix |
| 3. Prove Risk #1 (red) | Hybrid harness plus failing tests for the deleted-image and empty-key paths | Fault injection must reflect a real failure mode, not an artificial one |
| 4. Close the gap (green) | Guarded cleanup and a `check` constraint on `image_path` | The migration auto-deploys to production on merge, so it lands `not valid` |

**Prerequisites:** a local Supabase stack the developer starts themselves (`npx supabase start`), and `.env.test.local` generated from `supabase status`. No new dependencies — the CLI and `supabase-js` are already installed.

**Estimated effort:** roughly 3-4 sessions, one per phase, with Phases 3 and 4 landing together.

## Open Risks & Assumptions

- Whether `.exists()` succeeds at all against the authenticated storage route with no `select` policy on `storage.objects` is unknown until Phase 2 runs. Both answers change the work.
- An opt-in lane rots — the existing smoke lane's last recorded run is already stale. This is the accepted cost of keeping CI deterministic, and Phase 4 of the rollout revisits it.
- `test-plan.md` §5 says the real-boundary gate is "required after §3 Phase 1", which this plan defers. Flagged as a backport candidate.
- The `check` constraint assumes production rows already satisfy the pattern; it lands `not valid` so that assumption cannot break the auto-deploy.

## Success Criteria (Summary)

- A published artwork's image is provably retrievable at the URL a collector's browser requests — asserted against a real stack, not a mock.
- A publish that reports failure can no longer delete the image of a row that landed, and the test proving it fails without the fix.
- The default suite, CI and the verify gate behave exactly as before.
