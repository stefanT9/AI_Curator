<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Real Artwork Corpus

- **Plan**: `context/changes/real-artwork-corpus/plan.md`
- **Scope**: Phase 1 of 5
- **Date**: 2026-09-10
- **Verdict**: NEEDS ATTENTION at review time → **RESOLVED** after triage
- **Findings**: 1 critical, 6 warnings, 3 observations
- **Reviewed at**: `03d7e7f` (Phase 1) + `f5932c4` (plan amendment)

## Verdicts

| Dimension          | At review | After triage |
| ------------------ | --------- | ------------ |
| Plan Adherence     | WARNING   | PASS         |
| Scope Discipline   | WARNING   | PASS         |
| Safety & Quality   | FAIL      | PASS         |
| Architecture       | PASS      | PASS         |
| Pattern Consistency| WARNING   | PASS         |
| Success Criteria   | PASS      | PASS         |

All 12 Phase 1 Progress rows were re-verified independently during this review.
No rubber-stamping found.

## Findings

### F1 — db:seed:fetch silently erases enrichment written by later stages

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (data safety)
- **Location**: `scripts/build-corpus.ts` — `writeManifest`
- **Detail**: `writeManifest` rebuilt each piece from a hardcoded eight-field literal, dropping
  unknown keys, and `runFetch` called it on both branches including the no-op. Proved by injecting
  Phase-2-shaped fields and re-running: 2 → 0. The comment above the call claimed the opposite.
- **Fix**: Spread the piece and override only owned keys.
- **Decision**: FIXED — verified: fields survive (2 → 2), key order preserved.

### F2 — A sub-target manifest is discarded and re-sampled, not topped up

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Plan Adherence / Reliability
- **Location**: `scripts/build-corpus.ts` — `runFetch` resume condition
- **Detail**: Resume short-circuited on a whole-manifest condition rather than the plan's
  per-piece contract. Proved by truncating to 900: re-queried all 42 family/bucket combinations,
  re-downloaded all 1000 images, reassigned every slot, overwrote the smaller manifest. Reachable,
  since a family that exhausts its reserve comes up short and nothing asserted the target.
- **Fix A ⭐**: Additive resume — pin existing pieces, sample only the shortfall.
- **Decision**: FIXED via Fix A — verified: 12 downloads not 1000, all 988 pinned survived, slots
  contiguous over the union; full manifest still a byte-identical no-op. A short run now warns and
  converges on re-run.

### F3 — No retry, and the manifest is written only after all downloads

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Safety & Quality (reliability)
- **Location**: `scripts/build-corpus.ts` — `searchAic`, `downloadImage`
- **Detail**: Every request is a single attempt; no backoff. The manifest is written once, after
  the whole pass, so a mid-run failure during a first sample leaves images and no manifest.
- **Fix**: `withRetry` around both call sites honouring `Retry-After`; incremental manifest writes.
- **Decision**: SKIPPED — partly mitigated by F2 (a first run now recovers by topping up) and F6
  (partial writes are detected). Retry/backoff remains genuinely absent.

### F4 — Branch is broken for local dev: seed.sql references 54 deleted images

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Safety & Quality / plan sequencing
- **Location**: `supabase/seed.sql` (54 refs), commit `03d7e7f`
- **Detail**: Phase 1 deletes the placeholders; Phase 4 regenerates `seed.sql`. In between,
  `db:reset` seeds 54 rows with dangling `image_path`s. Recoverable at `03d7e7f^`.
- **Fix A ⭐**: Record as a known intermediate state; land Phases 1–4 together.
- **Decision**: FIXED via Fix A — plan gained a "Known Intermediate State" section carrying the
  merge constraint; `change.md` notes it.

### F5 — External input type-asserted, not validated, contrary to AGENTS.md

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Pattern Consistency
- **Location**: `scripts/build-corpus.ts` — AIC response, manifest read
- **Detail**: Both boundaries were casts. `paletteTags` does arithmetic on `color.h/s/l`, so an
  AIC schema change would yield silently wrong tags rather than an error.
- **Fix**: Zod schemas at both boundaries.
- **Decision**: FIXED — AIC validated per record (one bad record costs that record, not the page);
  manifest validated with `z.looseObject` so unknown keys survive, which is what stops validation
  re-creating F1. Verified: enrichment fields survive read+write; a malformed manifest is refused
  with a field-level pointer instead of being treated as absent and overwritten.

### F6 — Non-atomic writes; a truncated JPEG treated as present forever

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (reliability)
- **Location**: `scripts/build-corpus.ts` — image write, manifest write, `downloadedUuids`
- **Detail**: In-place writes; presence checked by filename alone, so a short file was never
  re-fetched and would be uploaded corrupt.
- **Fix**: `.tmp` + atomic `rename` for both; `downloadedUuids` requires non-zero size.
- **Decision**: FIXED — verified by zeroing a JPEG: re-downloaded and valid. It also caught a real
  partial write left by an earlier interrupted run (2 repaired, not 1).

### F7 — sampled_at carried forward across a full re-sample

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (correctness)
- **Detail**: The original defect became structurally impossible once F2 made resume additive —
  there is no longer any wholesale re-sample. Residual: top-up pieces share the first-sample date.
- **Fix**: Document the field's meaning.
- **Decision**: FIXED — documented as the AIC index generation the corpus came from, not a
  per-row timestamp.

### F8 — Plan text stale in five places where the code is right

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence / Scope Discipline
- **Detail**: "sorted keys" (fixed order, not alphabetical); "IIIF width 843" (capped at source);
  "paging" (id-partitioned); "ceramic" (index uses "ceramics"); "low lightness" (low *or* high).
  Benign extras: `image_width`, reserve mechanism, JPEG magic bytes, `.prettierignore`.
- **Fix**: Update the Phase 1 text to describe what was built.
- **Decision**: FIXED — Phase 1 contract text reconciled, including the triage additions
  (Zod boundaries, atomic writes, additive resume).

### F9 — Importing the module runs main() and sets process.exitCode = 1

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Architecture
- **Detail**: No entry-point guard. **A review agent claimed this breaks the Vitest run; tested
  and it does not** — a spec importing the module passes with exit 0, because worker isolation
  stops the exit code propagating. Real under `tsx`. Phase 2's tests depend on that masking.
- **Fix**: Entry-point guard.
- **Decision**: SKIPPED — revisit if Phase 2's test file behaves oddly.

### F10 — Docs describing the old world

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW
- **Location**: `.gitignore` comment, `supabase/seed-assets/README.md`
- **Fix**: Correct the size comment; flag the README.
- **Decision**: FIXED (both) — `.gitignore` says ~260 MB; README carries an in-progress banner
  with the `db:seed:fetch` prerequisite and the Phase 4 caveat.

## Outstanding

- **F3** (retry/backoff) and **F9** (entry-point guard) remain open by decision.
- **Merge constraint**: do not merge before Phase 4 regenerates `seed.sql` (F4).
