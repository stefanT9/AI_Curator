<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: List Artwork for Auction (S-01)

- **Plan**: context/changes/list-artwork-for-auction/plan.md
- **Scope**: Full plan (Phases 1-4)
- **Date**: 2026-09-11
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — `/auctions` has the same unbounded-`in()` bug class the Studio page was just fixed for

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/auctions/queries.ts:18-102 (`attachArtworks`, `getOpenAuctions`)
- **Detail**: `getOpenAuctions` has no LIMIT and feeds every open auction's `artwork_id` into `attachArtworks`'s `.in("id", artworkIds)`. This is the exact failure mode just found and fixed for the Studio grid (a PostgREST `in()` filter's query string grows with row count until the client refuses to send it — "URI too long"). Today's corpus has few live auctions so it doesn't reproduce yet, but nothing bounds this as auction volume grows.
- **Fix A ⭐ Recommended**: Apply the same bounded-pagination pattern now — LIMIT + offset on `getOpenAuctions`, paginate `/auctions` the way `/studio` was just fixed.
  - Strength: Reuses the exact pattern and constant style just proven correct and tested this session; closes the identical bug class before it can recur.
  - Tradeoff: Adds pagination UI/behavior to `/auctions` beyond this phase's original scope — a second unplanned expansion on top of the first.
  - Confidence: MED — the fix shape is proven, but the browse page's UX (load-more vs numbered pages) hasn't been designed.
  - Blind spot: No visibility into expected concurrent open-auction volume before this becomes urgent.
- **Fix B**: Record as a lesson / follow-up for a later slice, since current auction volume makes this theoretical for now.
  - Strength: Keeps this phase's scope closed; avoids stacking a second unplanned pagination change on this one.
  - Tradeoff: The bug ships latent — it will recur once enough auctions exist, with the same "URI too long" failure.
  - Confidence: HIGH — no reasonable near-term auction volume triggers this against the current corpus.
  - Blind spot: No visibility into actual expected production auction volume/timeline.
- **Decision**: FIXED (via Fix A) — added `AUCTIONS_PAGE_SIZE`/`getOpenAuctionsPage` to `src/lib/auctions/queries.ts` and paginated `/auctions/page.tsx` with a shared `Pagination` component and `parsePage` helper (also reused to fix F2/F3).

### F4 — Pagination deviation not reflected back into plan.md / change.md

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: context/changes/list-artwork-for-auction/plan.md (Phase 4 §2), change.md decisions table
- **Detail**: The Phase 4 pagination fix (`STUDIO_PAGE_SIZE`, `getArtistArtworksPage` in `src/lib/artworks/queries.ts`) touches a file the plan's "Implementation Approach" explicitly said would stay untouched ("Nothing in src/lib/artworks/... is modified"). The deviation is reasonable, well-justified, and doesn't touch any FR-013/FR-014-relevant code path (see commit f1f098a) — but it isn't reflected back into the plan or change.md's decisions table, so a future reader relying on those documents rather than `git log` wouldn't learn this happened.
- **Fix**: Append a short note to change.md's decisions table (or the Phase 4 contract in plan.md) pointing at commit f1f098a and explaining the pagination addition.
- **Decision**: FIXED — added a "Deviation discovered during Phase 4 implementation" section to change.md documenting the pagination fix and the F1 follow-up on `/auctions`.

### F2 — `parsePage` doesn't bound pathological input

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/app/(app)/studio/page.tsx:19-23 (`parsePage`)
- **Detail**: Accepts values like `"1e21"` that pass `Number.isInteger` and `> 0` but produce a huge offset fed into `.range()` in `getArtistArtworksPage`, causing a Postgres error instead of a graceful page. Low risk since Studio is gated to the caller's own catalog via `requireArtist`.
- **Fix**: Clamp the parsed page number to a sane upper bound (e.g. `Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000`) before using it.
- **Decision**: FIXED — `studio/page.tsx` now imports the shared, clamped `parsePage` from `src/lib/pagination.ts` (built while fixing F1) instead of its own unbounded local copy.

### F3 — Studio pagination's Previous/Next disabled state is CSS-only

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/app/(app)/studio/page.tsx:106-122
- **Detail**: Boundary disabling uses `aria-disabled` + `pointer-events-none` on an `<a>` whose `href` still resolves (harmlessly, since page 1 wraps to `/studio`) rather than a true disabled control. No established alternate pattern exists elsewhere in the repo to compare against.
- **Fix**: Render a plain, disabled-styled `<span>` at the boundaries instead of a suppressed `<a>`.
- **Decision**: FIXED — `studio/page.tsx` now renders the shared `<Pagination>` component (`src/components/ui/Pagination.tsx`, built while fixing F1) instead of its own inline markup; that component renders a true disabled `<span>` at each boundary.
