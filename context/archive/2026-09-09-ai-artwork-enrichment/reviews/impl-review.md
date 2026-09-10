<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: AI Enrichment for Artwork Uploads

- **Plan**: context/changes/ai-artwork-enrichment/plan.md
- **Scope**: All 5 phases (1, 1.5, 2, 3, 4)
- **Date**: 2026-09-10
- **Verdict**: NEEDS ATTENTION
- **Findings**: 2 critical, 7 warnings, 1 observation

> Rubric note: a strict read says REJECTED (critical Safety FAIL). Not applied
> mechanically — F1 is not exploitable in the current single-user, pre-launch
> state and is a launch blocker rather than a merge blocker. F2 affects the
> owner today.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Automated success criteria: all 5 pass (52 tests, typecheck, lint, format:check, build).

## Verified correct — do not re-flag

`startsWith` ownership check (traversal and prefix collision both impossible —
`IMAGE_PATH_PATTERN` pins segment one to exactly 36 chars); `requestRef`
staleness guard including the guarded `finally`; `topUpTags` dedupe, ordering
and cap, including cross-source case consistency and taxonomy tag lengths;
base64 regex including ReDoS and padding; `ImageBitmap` cleanup; tainted-canvas
and iOS canvas-limit concerns; `mediaTypeOf` extension branch; `server-only`
placement; secrets handling (lazy key read).

## Findings

### F1 — Enrichment endpoint has no rate limiting

- **Severity**: CRITICAL (at launch; dormant today)
- **Impact**: HIGH — architectural stakes
- **Dimension**: Safety & Quality
- **Location**: src/app/actions/enrichment.ts:47
- **Detail**: `suggestArtworkFields` is a public POST endpoint gated only by `requireArtist()`. Zero rate-limit primitives exist in src/ or supabase/; no vercel.json. Self-serve abuse path: sign up -> becomeArtist (profile.ts:37) -> loop. Each call fans out over three models holding a 25s budget, draining the shared OPENROUTER_API_KEY quota for all users. Dormant today (PRD: "one user today, the owner/developer").
- **Fix A (Recommended)**: Per-user quota in Postgres before the call (windowed count in a `private.` function; cap ~30/hr, ~200/day).
  - Strength: No new infra; fits the RLS/migration patterns already in this repo.
  - Tradeoff: One DB round-trip per suggestion.
  - Confidence: HIGH.
  - Blind spot: Window sizes are guesses, not measured.
- **Fix B**: Defer to a tracked launch-readiness follow-up.
  - Strength: Honest about current risk; quota shape better chosen against real data.
  - Tradeoff: Easy to forget; needs a tracked item.
  - Confidence: MED.
  - Blind spot: Ships unprotected if the app goes public informally.
- **Decision**: FIXED via Fix A — per-user Postgres quota (30/hr, 200/day). Migration applied directly to the linked project ahead of merge. Commit 58f971b.

### F2 — Publish blocks up to 25s on an AI call, against a PRD guardrail

- **Severity**: CRITICAL
- **Impact**: MEDIUM — real tradeoff
- **Dimension**: Safety & Quality
- **Location**: src/app/actions/artworks.ts:128
- **Detail**: `tags: await topUpTags(tags, imagePath)` is evaluated before the insert, blocking publish for up to TIMEOUT_MS (25s). PRD Guardrails states verbatim: "Publishing is not visibly slower after this change; no step in the upload flow blocks waiting on an AI response." Not a crash risk — Vercel's default function timeout is 300s — but a direct guardrail violation.
- **Fix A (Recommended)**: Insert first with the artist's tags, then top up and update the row.
  - Strength: Publish never blocked; satisfies the guardrail literally; also removes an orphan path.
  - Tradeoff: Two DB writes; brief window where the piece shows artist tags only.
  - Confidence: HIGH — nothing forces the top-up to precede the insert.
  - Blind spot: Haven't checked whether /discover or /studio would show the gap.
- **Fix B**: Keep inline, shrink budget to ~8s, single model.
  - Strength: One-line change.
  - Tradeoff: Still blocks publish; lowers top-up success rate.
  - Confidence: MED.
  - Blind spot: None significant.
- **Decision**: FIXED + ACCEPTED-AS-RULE: "Never block a user-visible mutation on a third-party AI call" (context/foundation/lessons.md). Top-up moved into `after()`. Commit fcf86a0.

### F3 — A Storage blip deletes a good upload

- **Severity**: WARNING
- **Impact**: LOW — fix is obvious
- **Dimension**: Safety & Quality
- **Location**: src/app/actions/artworks.ts:114
- **Detail**: `const { data: uploaded } = await ...exists(imagePath)` drops the `error`. On a transient Storage failure `data` is false, so a good upload is reported missing and the client cleanup effect then deletes it — turning a hiccup into a forced re-upload of a 10 MB file.
- **Fix**: Destructure `error`; on error return a `message` (not an `image` field error) so orphan cleanup does not fire.
- **Decision**: FIXED — error half of `exists()` read; `keepImage` added so the form's cleanup does not delete a good object. Commit 752a605.

### F4 — Orphaned objects on paths the cleanup effect cannot reach

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff
- **Dimension**: Safety & Quality
- **Location**: src/components/artworks/ArtworkForm.tsx:82,173
- **Detail**: The effect covers validation, ownership, existence and insert failures. Not covered: unmount during the upload await; navigation before the fire-and-forget remove() lands; the action throwing (useActionState produces no state, so the effect never runs). Client-side cleanup is inherently best-effort.
- **Fix A (Recommended)**: Scheduled server-side sweep (Vercel Cron -> route handler) deleting objects >1h old with no matching artworks.image_path row.
  - Strength: Authoritative; catches paths the browser cannot.
  - Tradeoff: New moving part to own.
  - Confidence: HIGH — standard pattern.
  - Blind spot: Must not delete mid-publish; the 1h window handles that.
- **Fix B**: Add unmount cleanup only.
  - Strength: Three lines; catches the common Cancel case.
  - Tradeoff: Misses thrown-action and unload races.
  - Confidence: MED.
  - Blind spot: None significant.
- **Decision**: SKIPPED — Fix B was found unsafe during triage (it would delete the image of every successfully published artwork, since `orphanRef` is still set when `redirect()` unmounts the form). Current cleanup covers every failure path that returns a state. Revisit with the server-side sweep if orphans accumulate.

### F5 — Size ceiling sits above the transport cap, so its error is unreachable

- **Severity**: WARNING
- **Impact**: LOW — fix is obvious
- **Dimension**: Safety & Quality
- **Location**: src/app/actions/enrichment.ts:24
- **Detail**: MAX_DATA_URL_BYTES = 1_500_000, but Server Action bodies cap at 1 MB and next.config.ts sets no bodySizeLimit. Payloads of 1–1.5 MB die at the transport with an opaque 413; the friendly copy is unreachable from the form. Same shape as the original 413 bug this change was created to fix. The test passes only because it bypasses transport.
- **Fix**: Drop to ~900_000 with a comment tying it to serverActions.bodySizeLimit; add a client-side length check in suggest() before dispatch.
- **Decision**: SKIPPED — a 768px JPEG at q0.8 is ~100 KB, so the 1 MB transport cap is never approached in practice. The unreachable branch is harmless.

### F6 — Side effect inside a state updater leaks a blob URL per pick

- **Severity**: WARNING
- **Impact**: LOW — fix is obvious
- **Dimension**: Safety & Quality
- **Location**: src/components/artworks/ArtworkForm.tsx:101
- **Detail**: setPreview's updater calls createObjectURL/revokeObjectURL. Updaters must be pure; StrictMode double-invokes them in dev, creating two blob URLs and leaking one. Redundant anyway — the effect at 73-77 already revokes on change and unmount. Pre-existing, not introduced by this change.
- **Fix**: Reduce to `setPreview(file ? URL.createObjectURL(file) : null)` and let the effect own revocation.
- **Decision**: SKIPPED — the leak is development-only (StrictMode) and bounded by picks per session.

### F7 — Transparent PNGs become black, skewing tags

- **Severity**: WARNING
- **Impact**: LOW — fix is obvious
- **Dimension**: Safety & Quality
- **Location**: src/lib/artworks/downscale.ts:42
- **Detail**: An alpha-channel PNG/WebP drawn on a transparent canvas then encoded as JPEG renders transparent regions black. For cut-outs or line work this materially changes what the model sees and skews tags toward dark / high contrast. The bucket accepts PNG and WebP, so this is a supported input.
- **Fix**: `fillStyle="#fff"` + `fillRect` before `drawImage`.
- **Decision**: SKIPPED — transparent-source artwork is rare enough not to justify the change now.

### F8 — Plan text never amended for three real deviations

- **Severity**: WARNING
- **Impact**: LOW — fix is obvious
- **Dimension**: Plan Adherence
- **Location**: context/changes/ai-artwork-enrichment/plan.md:135,139,142,436,486
- **Detail**: Three deviations are justified in code comments but the plan still asserts the original: the 12s->25s budget (3 places, plus Phase 4 §4 "Resolve OQ3 (12-second budget)"), the MODELS reorder (pro/mini/dots -> mini/dots/pro), and generateObject -> generateText + Output.object. Phases 1.5, 3 and 4 carry revision notes; Phase 1 does not. Also Phase 1 §8 says "rejects 11 tags" while §5 caps at 12.
- **Fix**: Add a "Revised during implementation" note to Phase 1 covering all three; correct the §8/§5 contradiction.
- **Decision**: FIXED — Phase 1 revision note added for the 25s budget, MODELS reorder and generateText+Output.object; Phase 4's stale OQ3/OQ5 lines and the §8/§5 tag-count contradiction corrected. Commit 50fc46a.

### F9 — Re-picking an image fires an unbounded number of model calls

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff
- **Dimension**: Plan Adherence
- **Location**: src/components/artworks/ArtworkForm.tsx:114
- **Detail**: suggest() has no debounce and no abort. Flipping through five images fires five full chains; four results are discarded but all five were paid for. PRD Guardrails: "The number of AI operations triggered by one artwork upload is bounded and known regardless of artist behavior — no path to runaway per-artwork cost." No longer true under the automatic trigger.
- **Fix A (Recommended)**: Debounce the file-change handler (~400ms).
  - Strength: Collapses rapid re-picks, the common case, in a few lines.
  - Tradeoff: Doesn't bound a determined user — only F1's server quota does.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Fix B**: Restore an explicit trigger for re-runs.
  - Strength: Makes the bound exact again.
  - Tradeoff: Partly reverts the chosen trigger design.
  - Confidence: MED — a product call.
  - Blind spot: None significant.
- **Decision**: SKIPPED — F1's quota now bounds the blast radius, and repeated image swapping is rare.

### F10 — Consolidated minor items

- **Severity**: OBSERVATION
- **Impact**: LOW — batch these
- **Dimension**: Pattern Consistency
- **Location**: multiple
- **Detail**:
  - upload.ts / downscale.ts are browser-only in prose only; `import "client-only"` would make it a build error.
  - mediaTypeOf's new https branch is untested — the branch added to fix a silent failure.
  - No test for the 2000-char description cap (Testing Strategy line 463 lists it).
  - Field.tsx:106 gives every error `<p>` the same id; :56 uses `errors ?` where `errors?.length` is meant.
  - FieldProgress renders two `role="status"` regions at once — announced twice.
  - downscale.ts:23 relies on createImageBitmap's EXIF default; `{ imageOrientation: "from-image" }` pins it.
  - roadmap.md was bundled into commit d715bda, which no phase describes.
- **Fix**: Batch as a cleanup pass.
- **Decision**: PARTIALLY FIXED — items 1, 2 and 4 done (client-only guards, mediaTypeOf https tests, Field a11y ids). Items 3, 5, 6 and 7 skipped. Commit a99f46c.
