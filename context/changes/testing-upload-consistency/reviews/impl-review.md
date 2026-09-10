<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Real-boundary lane and upload consistency

- **Plan**: context/changes/testing-upload-consistency/plan.md
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-09-10
- **Verdict**: REJECTED on review → 8 findings triaged; fixes applied and **verified
  against the live local Supabase stack**. F5 noted, F8 routed to a follow-up.
- **Findings**: 1 critical, 3 warnings, 2 observations (original) + F7 critical, F8 warning
  (surfaced by running the lane)

## Triage outcome (2026-09-10)

| Finding | Decision | Verified |
|---|---|---|
| F1 rewrite P1 as a real client-seam fault injection | FIXED | live lane green; reverting the Phase 4 guard makes it **red** (removeCalls non-empty) ✓ |
| F2 characterize whether an artist can delete their own object | FIXED | live lane confirms they **cannot** — test asserts the object survives |
| F3 record Phase 2 findings & decisions in plan.md | FIXED (corrected) | n/a — addendum now says a `select` policy IS needed (see F8) |
| F4 `keepImage: true` on the insert-error branch | FIXED (Fix A) | full gate + live lane green |
| F5 manual 3.5 had nothing to confirm | NOTED | F1's new fault-injection test now satisfies it |
| F6 rename "400" test to "non-200" | FIXED | n/a |
| F7 `npm run test:integration` was RED on `main` (happy-path test) | FIXED | `next/server` `after` now mocked in the lane; 21/21 green |
| F8 storage `.remove()` is a silent no-op even for the owner | FOLLOW-UP | `follow-ups/storage-cleanup-noop.md` |

**Verification run:** `npm run test:integration` → 21/21 passing against the local stack;
mocked gate (`format:check` / `lint` / `typecheck` / `test` 59/59 / `build`) green;
P1 red-state confirmed by reverting the guard.

## Verdicts

| Dimension | As reviewed | After triage |
|-----------|-------------|--------------|
| Plan Adherence | FAIL | PASS — P1 fault-injection test now matches the Phase 3 contract |
| Scope Discipline | WARNING | PASS — second deleter guarded (F4); F8 scoped out with a written rationale |
| Safety & Quality | WARNING | WARNING — F8 (cleanup no-op) is real and routed to a follow-up, not closed |
| Architecture | PASS | PASS |
| Pattern Consistency | PASS | PASS |
| Success Criteria | FAIL | PASS — `npm run test:integration` 21/21 green; P1 red-state confirmed |

The lane was executed against the local stack during triage (F7 fix). Progress rows
1.3 / 2.1 / 3.1 / 3.4 / 4.1 / 4.2 / 4.3 are now genuinely satisfied for the first time.

## Findings

### F1 — The Risk #1 proof test was never red and proves nothing falsifiable

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence / Success Criteria
- **Location**: test/integration/create-artwork.int.ts:108-166
- **Detail**:
  Phase 3 is titled "Prove Risk #1 (red)". The contract for its central test (Phase 3,
  Changes Required #3) is explicit: "wrap the real client so `.from("artworks").insert()`
  performs the real insert and then returns an error object … assert the failure state — a
  row exists **and** its object is gone from the public URL. This is the test that must be
  red before Phase 4 and green after." Success criterion: "The cleanup test fails,
  demonstrating a live row with a deleted object."
  The test that shipped does none of this. It never calls `createArtwork`, does no
  fault injection / client wrapping, inlines a bare `storage.remove()`, and never fetches
  `publicImageUrl` to check the object is gone. Its only end assertion is that an untouched
  `artworks` row still exists (`rowsStill` → length 1), which is trivially true. It is
  byte-identical between commit `7f314c4` (Phase 3) and `26af5bb` (Phase 4) — it never
  changed colour. The Phase 3 commit message says "All tests pass."
  Progress line 3.2 was rewritten from the plan's wording to "Cleanup test documents the
  risk path (blind delete without checking for row)" — a title change the Progress
  convention forbids ("Do not rename step titles"), and one that redefines the deliverable
  down to match the weaker test. (The P6 / empty-`image_path` test *was* genuinely red-first
  at `7f314c4` and flipped green in Phase 4 — that half of Phase 3 is fine.)
  Consequence: there is no regression test that goes red if the Phase 4 guard at
  `artworks.ts:132-146` is reverted, which directly contradicts the plan's stated verify
  step ("revert the Phase 4 cleanup guard and watch the Phase 3 test go red") and Progress
  4.1 ("Both previously-red tests now pass" — only one ever was). Risk #1's reachability
  via the Server Action path is still unproven; research Open Question #2 is still open.
- **Fix**: Write the fault-injection test the Phase 3 contract specifies — wrap the
  authenticated client so `.from("artworks").insert()` commits the real row then returns an
  `error`, invoke `createArtwork`, then assert the row is present **and**
  `fetch(publicImageUrl(row.image_path))` is non-200. Confirm it fails against Phase-4-reverted
  code and passes with the guard. If F2 shows the artist genuinely cannot delete their own
  object, rewrite the assertion to that reality and state plainly whether Risk #1 is
  reachable at all — that finding would change the framing of the whole change.
- **Decision**: FIXED — rewrote the `create-artwork.int.ts` P1 test as a client-seam fault
  injection (`wrapWithInsertFault`): the real insert commits, the awaited result is
  replaced with an error, `createArtwork` is invoked, then it asserts the row is present,
  `.remove()` was **not** called (spied), and `publicImageUrl` still returns 200. Header
  comment and P6 title corrected. typecheck / lint / format / mocked `test` green. NOT run
  against a live stack — the user must `npm run test:integration` and confirm the
  revert-the-guard red state.

### F2 — "Artists cannot delete their own storage objects" asserted in a comment, verified nowhere

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: test/integration/create-artwork.int.ts:152-158
- **Detail**:
  The P1 test carries a load-bearing comment: "The RLS delete policy currently prevents the
  artist from deleting their own files (silently rejects with no error)." Nothing asserts
  this — the test re-checks the `artworks` row, never the storage object. The delete policy
  (`20260909160300_add_artworks_storage.sql:45-51`) reads correct on its face
  (`(storage.foldername(name))[1] = auth.uid()::text`), so a silent self-delete failure
  would be surprising and consequential:
  - if true — the compensating `remove()` in `createArtwork` (before and after this change)
    and the `remove()` in `deleteArtwork` never actually delete anything; orphan cleanup is
    a no-op repo-wide. That is a bigger reliability finding than Risk #1 and belongs in a
    follow-up / rollout Phase 3.
  - if false — the P1 test's excuse for being a no-op collapses and Risk #1 is live and
    completely untested.
  Either way the current state is "we don't know", recorded as if we do.
- **Fix**: Add an explicit characterization test in `storage-boundary.int.ts` — artist
  uploads their own object, artist calls `.remove()` on their own key, then re-assert
  `.exists()` and the public URL. Record the real behaviour; if the policy is broken, open
  a follow-up under `context/changes/testing-upload-consistency/follow-ups/`.
- **Decision**: FIXED — added "lets an artist delete an object in their own folder" to
  `storage-boundary.int.ts` (uploads own object, `.remove()`s it, asserts `.exists()` →
  false and public URL non-200). A regression of self-delete now fails loudly. Run against
  the live stack to learn the actual behaviour; if it fails, the old comment was right and
  a follow-up is warranted.

### F3 — Phase 2 manual decisions marked done, never recorded

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/testing-upload-consistency/plan.md:190-191
- **Detail**:
  Progress 2.3 requires a noted decision ("leave the check as-is, or open follow-up work to
  replace it with a public-route check"); 2.4 requires a recorded decision on whether a
  `select` policy on `storage.objects` belongs in rollout Phase 3. Both are `[x]`. No
  decision text exists in the plan, `change.md`, or a follow-ups file — commit `b6005e9`
  only says ".exists() behavior documented as working correctly". The storage-boundary
  tests actually answer 2.4: for an owned object the authenticated route (`.exists()` →
  true) and the public route (200) agree, so no `select` policy is needed — but that
  conclusion was never written down.
- **Fix**: Add a short "Phase 2 findings & decisions" addendum to the plan (or a
  follow-ups note): both routes agree for owned objects; `.exists()` stays as-is; no
  `select` policy needed; `.exists()` did not throw for missing / cross-folder keys (P3
  concern did not materialise).
- **Decision**: FIXED — added a "Phase 2 findings & decisions" section to `plan.md` (just
  above `## Progress`): both routes agree for owned objects, `.exists()` stays as-is, no
  `select` policy needed, `.exists()` did not throw for missing/cross-folder keys.

### F4 — ArtworkForm's client-side deleter left unguarded, no rationale recorded

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: src/components/artworks/ArtworkForm.tsx:48-55
- **Detail**:
  Phase 4, Changes Required #1 ends: "Consider whether `ArtworkForm`'s client-side cleanup
  … needs the same treatment — it fires on any error state and is the second deleter."
  Research names both deleters as the P1 risk. `ArtworkForm.tsx` is untouched and no note
  explains the decision to skip it. The server guard now re-queries before `remove()`, but
  on any `createArtwork` error the form still calls `removeArtworkImage` unconditionally —
  the exact P1 scenario (insert commits, error returned) still triggers a second,
  client-side delete of a live row's object. The server fix is half the fix. (If F2 is
  true, RLS blocks this too — but then that should be the recorded reason, not an
  accident.)
- **Fix A ⭐ Recommended**: Guard the client deleter the same way — skip
  `removeArtworkImage` when the error indicates a save failure (row may exist) rather than
  an upload failure, or gate it on a server-confirmed "no row created" signal.
  - Strength: closes the window the server-side fix leaves open; matches the plan's intent.
  - Tradeoff: the client can't re-query cleanly under RLS; may need a small server round-trip.
  - Confidence: MED — depends on what `state` distinguishes between upload vs insert failure.
  - Blind spot: interaction with F2 not yet verified.
- **Fix B**: Record in the plan that the client deleter is acceptably safe (state the
  reason — e.g. RLS blocks it per F2) and defer.
  - Strength: cheap if the reason actually holds.
  - Tradeoff: leaves a latent path if F2's claim is wrong.
  - Confidence: LOW until F2 is resolved.
- **Decision**: FIXED via Fix A — `createArtwork`'s insert-error branch now returns
  `keepImage: true`, so the form's orphan effect (`ArtworkForm.tsx:82-92`) skips
  `removeArtworkImage` on the same failure the server guard already protects against. An
  insert error is not proof the row is absent, and this branch already prefers an orphan
  object to a broken card. Comments updated on both sides. Full gate green.

### F5 — Phase 3 manual item 3.5 rubber-stamped

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/testing-upload-consistency/plan.md:246
- **Detail**:
  Progress 3.5 `[x]` and commit `ec7db59` both "confirm that the fault injection test
  reflects a real production failure mode". There is no fault-injection test (F1). The item
  had nothing to confirm.
- **Fix**: Folds into F1 — once the real fault-injection test exists, re-verify this item
  against it.
- **Decision**: NOTED — F1's fix adds the real fault-injection test; 3.5 is re-confirmed
  when the user runs `npm run test:integration`. Progress row left `[x]` (not flipped
  back) per the user's call.

### F6 — Test title says "400", assertion only checks "not ok"

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: test/integration/upload.int.ts:49
- **Detail**:
  `it("returns 400 at the public URL for a key that was never uploaded")` asserts only
  `response.ok === false`. `storage-boundary.int.ts:72` does the same check with an honest
  "non-200" title.
- **Fix**: Assert the real status or rename to "non-200".
- **Decision**: FIXED — renamed the test to "returns non-200 …".

### F7 — `npm run test:integration` was red on `main`

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — one-line test-harness fix
- **Dimension**: Success Criteria
- **Location**: test/integration/create-artwork.int.ts (happy-path test) / src/app/actions/artworks.ts:185
- **Detail**:
  Running the lane on a clean `main` checkout: the happy-path test
  ("publishes an artwork and retrieves it at the collector's URL") throws
  ``Error: `after` was called outside a request scope`` — `createArtwork` calls
  `after()` from `next/server` at line 185, and the lane mocks `next/navigation`
  and `next/cache` but not `next/server`. This contradicts Progress 1.3, 2.1,
  3.1, 3.4, 4.1, 4.2, 4.3 — every "the lane passes" checkbox. The lane was
  either never actually run green or regressed silently after `after()` landed.
- **Fix**: `vi.mock("next/server", () => ({ after: vi.fn() }))` in the lane —
  the deferred tag top-up is `src/lib/ai/` territory with its own coverage, not
  this lane's job.
- **Decision**: FIXED — mock added; `npm run test:integration` now 21/21.

### F8 — storage `.remove()` is a silent no-op, even for the object's owner

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — schema + security change, cross-cutting, deferred deliberately
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260909160300_add_artworks_storage.sql (no `select` policy)
- **Detail**:
  F2's test, run live, confirms the artist **cannot** delete their own object:
  `.remove()` returns no error and the object survives. `storage-api` lists
  matching objects before deleting, and that list needs a `select` policy on
  `storage.objects` that no migration defines. So the compensating `remove()` in
  `createArtwork`, the `remove()` in `deleteArtwork`, and the client
  `removeArtworkImage` are **all no-ops today** — every deleted artwork orphans
  its image, and P1 (cleanup orphaning a live row's image) is not currently
  reachable through the Server Action. This also corrects F3/decision 2.4: a
  `select` policy IS needed.
- **Fix**: Not fixed here — adding the policy makes cleanup delete, which makes
  P1 reachable, so it must land with the Phase 4 guard already in place (it is)
  and belongs to rollout Phase 3 (Risk #3). Routed to
  `follow-ups/storage-cleanup-noop.md`.
- **Decision**: FOLLOW-UP — `follow-ups/storage-cleanup-noop.md` written; plan
  addendum 2.4 corrected; characterization test pins current behavior so the
  Phase 3 change has a red starting point.

## What is solid

- The lane is cleanly isolated: standalone `vitest.integration.config.mts` (not
  `mergeConfig`), disjoint `*.int.ts` glob, own script, no new dependency — mirrors the
  `vitest.smoke.config.mts` precedent exactly as the plan asked.
- `test/integration/setup.ts` local-only guard is thorough: missing-var, non-URL,
  non-loopback hostname, and a bounded health probe with a wedged-stack path — all throw,
  none skip.
- `src/app/actions/artworks.ts` guard is minimal, correct, keeps the user message
  unchanged, and re-queries before `remove()` per the "State sequencing" note.
- The migration lands `not valid` with the pattern mirroring `IMAGE_PATH_PATTERN`, exactly
  as specified for the no-gate `migrations.yml` deploy.
- AGENTS.md rewrite documents all three lanes (the smoke lane was previously undocumented)
  and correctly scopes "never hit for real" to the default suite.
