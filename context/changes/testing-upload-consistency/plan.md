# Real-boundary lane and upload consistency — Implementation Plan

## Overview

Stand up a local-only Vitest lane that talks to a real Supabase stack (Postgres + Storage + Auth), use it to pin what the storage boundary actually does at the publish seam, prove the path by which a published artwork loses its image, and close that path.

This is rollout Phase 1 of `context/foundation/test-plan.md`, covering Risk #1.

## Current State Analysis

The write path spans three trust domains with a compensating delete instead of a transaction:

1. The browser uploads the object ([upload.ts:35-72](src/lib/artworks/upload.ts#L35-L72)) — moved out of the Server Action by `d715bda` because Next caps action bodies at 1 MB while the bucket accepts 10 MiB.
2. `createArtwork` validates the key's shape and folder ([artworks.ts:98-109](src/app/actions/artworks.ts#L98-L109)), calls `.exists()` ([artworks.ts:113-121](src/app/actions/artworks.ts#L113-L121)), then inserts ([artworks.ts:123-129](src/app/actions/artworks.ts#L123-L129)).
3. On insert error, two independent deleters remove the object: the action ([artworks.ts:134](src/app/actions/artworks.ts#L134)) and the form ([ArtworkForm.tsx:48-55](src/components/artworks/ArtworkForm.tsx#L48-L55)).

Nothing observes any of this. [test/actions/artworks.test.ts:6-10](test/actions/artworks.test.ts#L6-L10) mocks `createClient` to `throw new Error("no test reaches Supabase")`, so every existing assertion returns before line 111. There is no integration lane, no `supabase/seed.sql`, and no service-role key.

Full failure-path enumeration is in [research.md](context/changes/testing-upload-consistency/research.md); this plan acts on P1, P2, P4 and P6.

## Desired End State

A developer runs one command against a running local stack and gets a suite that exercises real Postgres, real Storage and real RLS. That suite documents what `.exists()` actually does, proves that a published artwork's image is retrievable **at the URL the collector's browser uses**, and fails if a publish can leave a row whose image was deleted. `npm run test`, CI and the verify gate are untouched and still fully mocked.

Verify by: starting the stack, running `npm run test:integration` green; then reverting the Phase 4 cleanup guard and watching the Phase 3 test go red.

### Key Discoveries

- **The plan's protection statement is reversed.** "A failed upload leaves a published row" is structurally impossible — the row is written last. The live risk is a *failed-looking* insert deleting the object of a row that did land ([artworks.ts:131-136](src/app/actions/artworks.ts#L131-L136)).
- **`.exists()` probes a different route than the card.** It HEADs `/storage/v1/object/artworks/<key>` (authenticated, RLS-gated); the card fetches `/storage/v1/object/public/artworks/<key>` ([images.ts:13-14](src/lib/artworks/images.ts#L13-L14)). **No migration grants `select` on `storage.objects`** ([the storage migration](supabase/migrations/20260909160300_add_artworks_storage.sql#L24-L51) defines insert/update/delete only).
- **`.exists()` throws** on any status other than 400/404 (verified in `node_modules/@supabase/storage-js/dist/index.mjs`), and the action discards `error` with no try/catch.
- **The DB permits an unrenderable row**: `image_path text not null` is the only constraint; `''` is legal.
- **The lane needs no new dependency**: `supabase-js` is a direct dep, the CLI is pinned at 2.117.0 in devDeps and already used in `migrations.yml`, and `auth.email.enable_confirmations = false` (`config.toml:225`) makes a signed-in test user one call away.
- **The precedent to copy** is `ec1e70c`: a standalone config (never `mergeConfig` — it concatenates `include` arrays) with a glob disjoint from `test/**/*.test.ts`.

## What We're NOT Doing

- No CI job. The lane stays local opt-in; the gating decision belongs to Phase 4 alongside the migration gate.
- No `supabase/seed.sql` and no fixture framework — `ranking-eval-corpus` owns that file and explicitly warns it must stay a corpus.
- No service-role key. `.env.example:2-3` warns against it and teardown does not need it.
- No `onError` fallback or placeholder in `ArtCard`, and no read-path filter for unrenderable rows. Symptom treatment; it would mask the cause.
- No change to `npm run test`, `vitest.config.mts`, `verify.yml`, or the mocked suite's assertions.
- Never run `npm run db:types:local` — it crashes and overwrites `src/types/database.ts` ([ai-artwork-enrichment/change.md:16](context/changes/ai-artwork-enrichment/change.md#L16)). This change adds no new table or column type, so no regeneration is needed.
- No feed/deck, policy-suite, or CI-gate work — Phases 2, 3 and 4 of the rollout.

## Implementation Approach

Four phases, red before green. Phase 1 builds the harness and amends the convention that forbids it. Phase 2 characterizes the storage boundary — deliberately *recording* behavior rather than asserting a desired one, because the `.exists()` route question cannot be answered from source. Phase 3 reaches `createArtwork` with a real client and proves Risk #1 with a failing test. Phase 4 makes it pass.

Two safety rails run through all four:

- **The lane must refuse to run against anything but a local stack.** `.env.local` in this repo points at the linked project `qtohgsgfzuutcvpzpowt`; a lane that creates users and uploads objects must never reach it.
- **Infrastructure commands are the developer's to run.** The plan supplies copy-paste commands; the implementer does not start, stop or reset the stack.

## Critical Implementation Details

**Timing & lifecycle.** `supabase db reset` clears Storage objects as well as database rows, so a reset invalidates any object a previous run left behind — teardown must not assume objects survive. Separately, `[auth.rate_limit] sign_in_sign_ups = 30` per 5 minutes per IP (`config.toml:205-206`): mint **one** user per test file, not per test, or the suite will flake on the 31st signup.

**State sequencing.** In Phase 4 the guard must re-query for the row *before* removing the object, and skip removal if a row referencing that key exists. Removing first and checking after reintroduces the bug.

## Phase 1: Lane Foundation

### Overview

A third Vitest config, its own glob and script, a hard local-only guard, a test-user helper, one end-to-end assertion, and the AGENTS.md amendment.

### Changes Required

#### 1. Integration Vitest config

**File**: `vitest.integration.config.mts`

**Intent**: Give the lane its own runner so `npm run test` and CI can never pick it up, mirroring how `vitest.smoke.config.mts` was written standalone.

**Contract**: Same `resolve` block as the existing configs (tsconfig paths + the `server-only` stub alias). `test.include: ["test/integration/**/*.int.ts"]` — disjoint from both `test/**/*.test.ts` and `test/smoke/**/*.live.ts`. No `test.env` block: real values come from the env file. Set `test.testTimeout` to 30_000, since real network round trips replace mocks. Written standalone, not via `mergeConfig`.

#### 2. Test script

**File**: `package.json`

**Intent**: Run the lane with local stack credentials loaded from a file that is never the developer's app env.

**Contract**: Add `"test:integration"` following the `test:smoke` shape exactly — `node --env-file-if-exists=.env.test.local ./node_modules/vitest/vitest.mjs run --config vitest.integration.config.mts`. The indirection through `vitest.mjs` is required for `--env-file-if-exists` to apply. Deliberately **not** `.env.local`: that file points at the linked remote project.

#### 3. Environment guard and stack health check

**File**: `test/integration/setup.ts`

**Intent**: Make it impossible to run this suite against a remote project, and give a developer a clear instruction when the stack is down instead of a wall of connection errors.

**Contract**: Exported helpers used from a `beforeAll` in every integration file. Must (a) read `NEXT_PUBLIC_SUPABASE_URL` and throw unless its hostname is `127.0.0.1` or `localhost`; (b) `fetch` `${url}/auth/v1/health` and, on failure, throw an error naming the exact commands to run. Follow the smoke lane's stance — fail loudly, do not silently skip, since a skipped suite reports green.

The message must tell the developer to run, themselves:

```
npx supabase start
npx supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY > .env.test.local
```

#### 4. Test user helper

**File**: `test/integration/helpers.ts`

**Intent**: Mint a real signed-in artist and clean up after it under the same RLS a real user has — no service-role key.

**Contract**: Exports a factory returning `{ client, userId, cleanup }`. Signs up `artswipe-int-${crypto.randomUUID()}@example.test` via a plain `createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })`, promotes the profile to artist (the `private.is_artist()` gate blocks storage writes otherwise — check how `becomeArtist` in `src/app/actions/profile.ts` does it and reuse that path), and returns a `cleanup` that deletes the user's own artworks and its own storage objects. One user per file, not per test. `auth.users`/`profiles` residue is accepted and cleared by `db reset`.

#### 5. First end-to-end assertion

**File**: `test/integration/upload.int.ts`

**Intent**: Prove the lane works by asserting the thing the whole phase is about — an uploaded object is retrievable at the URL a collector's browser will request.

**Contract**: Upload a small real PNG buffer via `uploadArtworkImage`'s own path (or the same supabase-js call, if the browser client factory cannot be constructed in Node), then `fetch(publicImageUrl(key))` and assert a 200 with non-zero `content-length`. Every assertion scoped to the per-run user id so parallel files cannot interfere.

#### 6. Convention amendment

**File**: `AGENTS.md`

**Intent**: The rule at line 59 currently forbids exactly what this phase builds. Narrow it to the default suite and document all three lanes — the smoke lane is undocumented today, which is an existing gap.

**Contract**: Rewrite the Tests section (lines 56-61) so "Supabase is never hit for real" scopes to `npm run test` / CI, and add the two opt-in lanes with their scripts, globs and the local-only constraint. Leave the "Verify before calling a change done" gate list unchanged — the integration lane is not part of it.

#### 7. Ignore lane output

**File**: `.gitignore`

**Intent**: `.env.test.local` holds locally-generated keys and must never be committed.

**Contract**: Add `.env.test.local` alongside the existing env rules. Note the existing `.env*` pattern may already cover it — verify rather than duplicating.

### Success Criteria

#### Automated Verification

- `npm run test` still passes and its file count is unchanged
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run build` all pass
- `npm run test:integration` passes against a running local stack
- Running `test:integration` with a non-local `NEXT_PUBLIC_SUPABASE_URL` fails with the guard's error, not a network error

#### Manual Verification

- With the stack stopped, `npm run test:integration` prints the two copy-paste commands and fails clearly
- The AGENTS.md Tests section reads correctly to someone who has never seen this repo

---

## Phase 2: Pin the Storage Boundary

### Overview

Characterization tests for the storage seam. The point is to *record* real behavior, especially where the source cannot tell us the answer.

### Changes Required

#### 1. Existence-check semantics

**File**: `test/integration/storage-boundary.int.ts`

**Intent**: Answer the open question at the centre of this risk — with no `select` policy on `storage.objects`, what does `.exists()` actually return for an object the caller owns, and does it agree with the public route the card uses?

**Contract**: For a freshly uploaded object, assert both routes side by side: the result of `supabase.storage.from(ARTWORKS_BUCKET).exists(key)` and the status of `fetch(publicImageUrl(key))`. Also cover a key that was never uploaded, and a key in another user's folder. If the two routes disagree, the test documents the disagreement rather than papering over it — write the assertion to the observed behavior with a comment explaining why that behavior is what it is, and record the finding for the plan's follow-up decision.

#### 2. Existence check for an unusable object

**File**: `test/integration/storage-boundary.int.ts`

**Intent**: `.exists()` is a HEAD and says nothing about bytes. Confirm whether the boundary lets a zero-byte or content-mismatched object through, since the size and MIME guards live only in the browser and `upload.ts:31-33` calls them "a courtesy, not the gate".

**Contract**: Attempt a zero-byte upload and a declared-`image/png`-but-not-actually-PNG upload directly through supabase-js, bypassing `uploadArtworkImage`'s client-side checks. Assert what the bucket accepts, then assert what `.exists()` says about whatever landed.

#### 3. Storage RLS policies

**File**: `test/integration/storage-boundary.int.ts`

**Intent**: The folder-scoped policies are the security boundary for uploads and have never been executed by a test.

**Contract**: With two distinct test users: writing into one's own folder succeeds; writing into the other's folder is denied; deleting another's object is denied. Also assert the bucket's own limits — an over-10-MiB upload and a disallowed MIME type are both rejected server-side, independent of the browser guards.

### Success Criteria

#### Automated Verification

- `npm run test:integration` passes with the new file
- `npm run lint`, `npm run typecheck` pass

#### Manual Verification

- The recorded `.exists()` behavior is reviewed and a decision noted: leave the check as-is, or open follow-up work to replace it with a public-route check
- If the two routes disagree, confirm whether a `select` policy on `storage.objects` belongs in rollout Phase 3

---

## Phase 3: Prove Risk #1 (red)

### Overview

Reach `createArtwork` with a real Supabase client and demonstrate the broken-card path. These tests are expected to fail on arrival.

### Changes Required

#### 1. Hybrid harness

**File**: `test/integration/create-artwork.int.ts`

**Intent**: `createArtwork` calls `createClient` from `@/utils/supabase/server`, which needs `await cookies()` and cannot run in Node. Substitute a real client while keeping the Next runtime mocked.

**Contract**: `vi.mock("@/utils/supabase/server")` returning the per-run authenticated Node client; keep `next/navigation` and `next/cache` mocked exactly as [test/actions/artworks.test.ts:11-12](test/actions/artworks.test.ts#L11-L12) does; mock `@/lib/auth/dal`'s `requireArtist` to return the real test user's id so RLS and the action agree on identity. Share fixtures into the `vi.mock` factories via `vi.hoisted` — the factories are hoisted, per the AGENTS.md rule.

#### 2. Happy path, asserted at the collector's URL

**File**: `test/integration/create-artwork.int.ts`

**Intent**: Turn "a published artwork always has a retrievable image" into an executable contract, checked where it matters.

**Contract**: Upload, publish through `createArtwork`, read the row back, and assert `fetch(publicImageUrl(row.image_path))` returns 200 with non-zero bytes. Note that `createArtwork` ends in `redirect()`, which throws `NEXT_REDIRECT` — the mocked `next/navigation` makes it a no-op, so assert on the persisted row rather than a return value.

#### 3. The cleanup deletes a live row's image (the actual Risk #1)

**File**: `test/integration/create-artwork.int.ts`

**Intent**: Prove P1 — when the insert commits but reports an error, the compensating delete removes the image of a row that exists, producing exactly the failure the risk describes.

**Contract**: Fault-inject at the client seam: wrap the real client so `.from("artworks").insert()` performs the real insert and then returns an error object. Then assert the failure state — a row exists **and** its object is gone from the public URL. This is the test that must be red before Phase 4 and green after.

#### 4. The database accepts an unrenderable row

**File**: `test/integration/create-artwork.int.ts`

**Intent**: Prove P6 — `image_path` has no shape constraint, so any writer that is not the Server Action can create a row that cannot render.

**Contract**: Insert directly with `image_path: ''` as the authenticated user and assert it currently succeeds. Red-to-green flips in Phase 4.

### Success Criteria

#### Automated Verification

- The happy-path test passes
- The cleanup test fails, demonstrating a live row with a deleted object
- The empty-`image_path` test fails, demonstrating the row is accepted
- `npm run test` (mocked suite) still passes unchanged

#### Manual Verification

- Confirm the fault injection reflects a real failure mode (connection dropped after commit) rather than an artificial one that could not occur in production

---

## Phase 4: Close the Gap (green)

### Overview

Guard the compensating delete and constrain the column. The Phase 3 tests turn green.

### Changes Required

#### 1. Guard the cleanup

**File**: `src/app/actions/artworks.ts`

**Intent**: The delete at line 134 assumes an insert error means no row. Verify that before destroying the artist's only copy of the image.

**Contract**: On `insertError`, re-query `artworks` for a row whose `image_path` equals this key **before** calling `remove()`; skip the removal when one exists. An orphaned object is a cost the existing comment already accepts; a broken published card is not. Keep the user-facing message unchanged. Consider whether `ArtworkForm`'s client-side cleanup ([ArtworkForm.tsx:48-55](src/components/artworks/ArtworkForm.tsx#L48-L55)) needs the same treatment — it fires on any error state and is the second deleter.

#### 2. Constrain the column

**File**: `supabase/migrations/<timestamp>_constrain_artwork_image_path.sql`

**Intent**: Make an unrenderable row impossible at the boundary that actually holds, rather than only in app code.

**Contract**: Add a `check` constraint on `public.artworks.image_path` mirroring `IMAGE_PATH_PATTERN` ([images.ts:36-37](src/lib/artworks/images.ts#L36-L37)) as a Postgres regex. Add it **`not valid`** so the migration cannot fail against pre-existing production rows — it still enforces every new and updated row, which is the whole point. Never edit an applied migration; this is a new file.

### Success Criteria

#### Automated Verification

- All Phase 3 tests now pass, including the two that were red
- `npm run test`, `format:check`, `lint`, `typecheck`, `build` all pass
- The migration applies cleanly on a reset local stack

#### Manual Verification

- Publish an artwork through the running app and confirm the card renders — the guard must not break the normal path
- Confirm production `artworks` rows all satisfy the new pattern before deciding whether to follow up with `validate constraint`
- Review the migration knowing that merging to `main` auto-deploys it via `migrations.yml`

---

## Testing Strategy

### Unit Tests

The mocked suite is unchanged. Its job stays the Zod gates and the folder check — the boundary behavior it cannot observe now belongs to the integration lane.

### Integration Tests

- Storage boundary: `.exists()` semantics across both routes, unusable objects, folder-scoped RLS, bucket size and MIME limits
- Publish path: happy-path retrievability at the public URL, insert-error-after-commit, unrenderable rows

### Manual Testing Steps

1. `npx supabase start`, then regenerate `.env.test.local` from `supabase status`
2. `npm run test:integration` — green
3. Stop the stack and rerun — clear failure naming the two commands
4. Point `NEXT_PUBLIC_SUPABASE_URL` at a remote host and rerun — refuses before touching the network
5. Publish an artwork in the running app; confirm it renders in studio and discover
6. Revert the Phase 4 guard and rerun the lane — the cleanup test goes red again

## Performance Considerations

`npm run test` and CI are untouched, so the fast feedback loop is unaffected. The integration lane trades speed for truth: real round trips, a 30s timeout, and one signup per file to stay under the 30-per-5-minute limit.

## Migration Notes

The `check` constraint is the only schema change and it lands `not valid` deliberately: `migrations.yml` pushes to production on merge to `main` with no gate, so a constraint that could fail validation against existing rows would break that deploy. Validating it later is a separate, deliberate step once production data is confirmed to comply.

## References

- Research: `context/changes/testing-upload-consistency/research.md`
- Test plan: `context/foundation/test-plan.md` §2 Risk #1, §3 Phase 1, §6.2
- Lane precedent: `vitest.smoke.config.mts`, `test/smoke/enrich.live.ts`, commit `ec1e70c`
- Upload-fix rationale: `context/changes/ai-artwork-enrichment/plan.md:198`
- Seeding facts to reuse later: `context/changes/ranking-eval-corpus/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Lane Foundation

#### Automated

- [x] 1.1 `npm run test` still passes with an unchanged file count
- [x] 1.2 `format:check`, `lint`, `typecheck`, `build` all pass
- [x] 1.3 `npm run test:integration` passes against a running local stack
- [x] 1.4 A non-local Supabase URL fails via the guard, not a network error

#### Manual

- [x] 1.5 Stack stopped: the failure prints the two copy-paste commands
- [x] 1.6 The AGENTS.md Tests section reads correctly to a newcomer

### Phase 2: Pin the Storage Boundary

#### Automated

- [ ] 2.1 `npm run test:integration` passes with the storage-boundary file
- [ ] 2.2 `lint` and `typecheck` pass

#### Manual

- [ ] 2.3 Recorded `.exists()` behavior reviewed; keep-or-replace decision noted
- [ ] 2.4 Decide whether a `select` policy on `storage.objects` belongs to rollout Phase 3

### Phase 3: Prove Risk #1 (red)

#### Automated

- [ ] 3.1 Happy-path retrievability test passes
- [ ] 3.2 Cleanup test fails, showing a live row with a deleted object
- [ ] 3.3 Empty-`image_path` test fails, showing the row is accepted
- [ ] 3.4 The mocked suite still passes unchanged

#### Manual

- [ ] 3.5 Fault injection confirmed to reflect a real production failure mode

### Phase 4: Close the Gap (green)

#### Automated

- [ ] 4.1 Both previously-red tests now pass
- [ ] 4.2 Full verify gate passes
- [ ] 4.3 Migration applies cleanly on a reset local stack

#### Manual

- [ ] 4.4 Publishing through the running app still works
- [ ] 4.5 Production rows confirmed to satisfy the pattern before any `validate constraint`
- [ ] 4.6 Migration reviewed knowing merge to `main` auto-deploys it
