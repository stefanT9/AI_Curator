# AI Enrichment for Artwork Uploads — Implementation Plan

## Overview

Add an image-derived enrichment capability to ArtSwipe. On the upload form, an artist can fill the description field and the tags field from the uploaded image with one action each. At publish, any piece carrying fewer than five tags is topped up automatically with controlled-vocabulary tags, so no artwork reaches the future recommender under-tagged.

The model is reached through OpenRouter's free vision tier via the Vercel AI SDK. Enrichment is never a hard dependency: if it is unconfigured, rate-limited, slow, or failing, upload and publish continue to work exactly as they do today.

## Current State Analysis

The upload path is a single Server Action plus one shared form component, and the tag column already exists.

- **Tag storage already exists, but its ceiling is too low.** `supabase/migrations/20260909160100_add_artworks.sql:11` defines `tags text[] not null default '{}'`, with a GIN index at line 27 and a `cardinality(tags) <= 10` check constraint at line 17. The column and index need no change; the **ceiling must rise from 10 to 20**, which is a check constraint and therefore requires a migration. The PRD's claim that this change "does add a persisted tag list on the artwork record" (Scope of Change, closing note) is stale and should be corrected — the list exists, only its cap moves.
- **Tag normalization is already written.** `src/app/actions/artworks.ts:47-72` (`TagsSchema`) splits a comma-separated string, trims, lowercases, dedupes, caps at 10 entries and 30 characters each. Model output can be funnelled through the same normalization rather than a parallel one; the entry cap moves to 20 in lockstep with the database constraint.
- **The tag ceiling is stated in three places.** The database constraint, `TagsSchema`'s `.max(10)`, and the user-facing hint "Comma-separated, up to 10" at `src/components/artworks/ArtworkForm.tsx:93`. All three must move together or the form will promise something the database rejects.
- **The image is not in Storage at suggestion time.** `src/components/artworks/ArtworkForm.tsx:33-40` holds the selected image as a client-side `File` and builds a local object URL for preview only. `createArtwork` uploads to the bucket at `src/app/actions/artworks.ts:118-121`, i.e. only at publish. So a per-field suggestion has no public URL to hand a model — the bytes must travel from the browser explicitly.
- **`Field` is uncontrolled.** `src/components/ui/Field.tsx:36-49` spreads `defaultValue` onto the input/textarea and exposes `onChange` only for the file input. Filling a field programmatically requires adding controlled-value support.
- **No AI dependency exists.** `package.json` has no `ai`, no provider package, and no AI-related env var. `.env.example` carries only the two Supabase keys.
- **Tests are a Node-only smoke layer.** `vitest.config.mts` sets `environment: "node"` with no jsdom, and `test/actions/artworks.test.ts:6-9` mocks `createClient` to throw so no test can reach Supabase. Component tests are not currently possible.
- **`createArtwork` ends in `redirect("/studio")`** (`src/app/actions/artworks.ts:141`), which throws a Next.js control-flow signal. Any enrichment work must complete before that call.

## Desired End State

An artist selecting an image on `/studio/new` sees a "Suggest" control on the Description field and on the Tags field. Triggering either one issues a single model call that returns both a draft description and a set of tags; the triggered field fills, and the other field's control then fills instantly from the cached result with no second call. Both values remain fully editable. All other fields stay interactive and the Upload button is never disabled by an in-flight request.

Publishing a piece with fewer than five tags silently tops the list up to a useful set of controlled-vocabulary tags. Publishing with the AI unreachable, unconfigured, or failing behaves exactly as it does today.

Verify by: uploading a piece end to end with `OPENROUTER_API_KEY` set, then repeating with the variable removed — both paths must publish successfully.

### Key Discoveries

- `tags text[]` with GIN index already exists — `supabase/migrations/20260909160100_add_artworks.sql:11,27`. Column and index unchanged; only the `cardinality` ceiling moves from 10 to 20, via a new migration.
- Existing `TagsSchema` at `src/app/actions/artworks.ts:47-72` is the reusable normalization gate.
- The ceiling appears in three places that must move together: the check constraint, `TagsSchema.max()`, and the form hint at `src/components/artworks/ArtworkForm.tsx:93`.
- Image bytes live only in the browser until publish — `src/components/artworks/ArtworkForm.tsx:33-40` vs `src/app/actions/artworks.ts:118`.
- `Field` needs controlled-value support — `src/components/ui/Field.tsx:36-49`.
- OpenRouter free vision models that support `structured_outputs`, verified live against `https://openrouter.ai/api/v1/models` on 2026-09-09: `nex-agi/nex-n2.5-pro:free`, `nex-agi/nex-n2.5-mini:free`, `dots-studio/dots-3-note-preview:free`.
- OpenRouter free tier: 20 requests/minute; 50 requests/day, rising to 1000/day once $10 of credits has been purchased (all-time). The owner will purchase credits — see Prerequisites.
- `@openrouter/ai-sdk-provider@3.0.0` declares peer deps `ai ^7.0.0` and `zod ^3.25.76 || ^4.1.8`. The project is on `zod ^4.5.4`, which satisfies this.

## What We're NOT Doing

- **No recommendation engine.** This change produces and stores the tag signal only; consuming it in swipe ranking is separate future work.
- **No retro-tagging of existing artworks.** Enrichment applies to new uploads only. Pieces already in the database keep whatever tags they have.
- **No AI assistance on the title field.** The title stays the artist's own voice.
- **No bulk "fill everything" action.** Assistance is per-field.
- **No change to the `tags` column or its GIN index.** The only schema movement is the `cardinality` ceiling; the column type, default, and index stay as they are.
- **No backfill of existing artworks to the new ceiling.** Raising a maximum is permissive — every existing row remains valid, and none are rewritten.
- **No change to the collector swipe/like experience.**
- **No component tests and no jsdom.** The Vitest smoke layer stays Node-only.
- **No enrichment on the edit form.** `ArtworkForm` is shared between create and edit, but edit has no image input (`src/components/artworks/ArtworkForm.tsx:45`), so assistance controls render only in create mode.

## Implementation Approach

Four layers, built bottom-up so each is verifiable before the next depends on it.

A pure `src/lib/ai/` module owns the taxonomy, the response schema, and the OpenRouter call with its fallback chain and timeout. It is the only place that knows about a model. A Server Action wraps it with auth and input validation. The client downscales the selected image before sending it, so a 10 MB upload becomes roughly 100 KB of JPEG data URL. The form holds one cached enrichment result shared by both fields' controls. Finally `createArtwork` reuses that cached result when present, and otherwise makes at most one call of its own, to top up under-tagged pieces.

**Call budget per upload: at most 2.** One artist-triggered suggestion (serving both fields), plus at most one publish-time top-up — and the top-up is skipped entirely when the submitted form already carries a usable cached suggestion. This is what makes the PRD's "bounded and known" guardrail exact.

## Critical Implementation Details

**Ordering inside `createArtwork`.** The action ends in `redirect("/studio")` (`src/app/actions/artworks.ts:141`), which throws. Top-up must run before the `insert`, and its failure must be swallowed rather than propagated — an enrichment error must never surface as a failed publish. Do not wrap the `redirect` call in the same `try` used to guard the enrichment call, or the redirect's control-flow throw will be caught and silently swallowed.

**Mixed tag provenance.** Artist-typed tags stay free text; only generated tags are drawn from the controlled vocabulary. The `tags` array therefore mixes both kinds, and the column cannot distinguish them. This is accepted: matching quality rests on the generated tags, and a future recommender can re-derive provenance by intersecting with the taxonomy. Do not add a provenance column — the PRD explicitly defers richer structure to the recommender change.

**Read the API key lazily, never at module scope.** The Supabase factories read their env vars at import time (`src/utils/supabase/client.ts:4-5`), but `enrich.ts` must not copy that pattern: `next build` imports every module, and CI has no `OPENROUTER_API_KEY`. Read `process.env.OPENROUTER_API_KEY` **inside** `enrichFromImage`, so an unset key produces the `unconfigured` result at call time rather than breaking the build. For the same reason, do not add the variable to `verify.yml`.

**Do not add the key to `vitest.config.mts`.** That file pre-sets placeholder Supabase vars (lines 18-21) because those *are* read at import time. Adding `OPENROUTER_API_KEY` there would make the `unconfigured` test unreachable. Use `vi.stubEnv` per test instead.

**Cache invalidation.** The cached enrichment result belongs to one specific image. Selecting a different file must clear it, or the second field will fill from the previous image's analysis. The existing `onImageChange` handler (`src/components/artworks/ArtworkForm.tsx:33-40`) is the single place this happens.

## Phase 1: Tag Ceiling and Enrichment Service

### Overview

Raise the tag ceiling from 10 to 20 across all three places that state it, then build a self-contained `src/lib/ai/` module that turns image bytes into a validated `{ description, tags }` object, or fails cleanly. The service has no knowledge of forms, actions, or Supabase.

The ceiling rises first because everything downstream — the response schema's tag count, the publish-time merge cap — is sized against it.

### Changes Required

#### 1. Raise the tag ceiling in the database

**File**: `supabase/migrations/<timestamp>_raise_artwork_tag_limit.sql` (new)

**Intent**: Let an artwork carry up to 20 tags instead of 10, so artist tags and generated tags can coexist without crowding each other out.

**Contract**: Drop and recreate the check constraint — `alter table public.artworks drop constraint artworks_tags_length`, then add it back as `check (cardinality(tags) <= 20)`, keeping the same constraint name so the schema stays self-describing. Per AGENTS.md, **never edit `20260909160100_add_artworks.sql`** — it is already applied. Generate the timestamp so the file sorts after every existing migration.

This is a widening change: every existing row already satisfies `<= 20`, so the constraint validates without a table rewrite and needs no backfill.

**Note on type regeneration**: a check constraint does not appear in `src/types/database.ts`, so `npm run db:types:local` will produce no diff. Run it anyway to honour the AGENTS.md convention and to confirm that.

#### 2. Raise the ceiling in application code

**Files**: `src/app/actions/artworks.ts`, `src/components/artworks/ArtworkForm.tsx`

**Intent**: Keep the validation gate and the user-facing promise in step with the database, so the form never accepts something the insert will reject.

**Contract**: In `TagsSchema` (`src/app/actions/artworks.ts:47-72`), change `.max(10, ...)` to `.max(20, ...)` and update its message to "Use at most 20 tags." The 30-character per-tag limit is unchanged. In `ArtworkForm`, update the tags hint at line 93 from "Comma-separated, up to 10" to "up to 20".

Define the ceiling once as an exported constant rather than repeating the literal, so the next change to it is a single edit.

#### 3. Dependencies

**File**: `package.json`

**Intent**: Add the AI SDK and the OpenRouter provider so the service can issue a structured-output call without hand-rolling HTTP.

**Contract**: Add `ai@^7` and `@openrouter/ai-sdk-provider@^3` to `dependencies`. Peer requirements are `ai ^7.0.0` and `zod ^3.25.76 || ^4.1.8`; the project's `zod ^4.5.4` satisfies the latter. After install, the AI SDK's bundled docs are readable at `node_modules/ai/docs/` — consult them for the current `generateObject` signature rather than relying on memory, as the SDK's API has changed across recent majors.

#### 4. Tag taxonomy

**File**: `src/lib/ai/taxonomy.ts`

**Intent**: Define the controlled vocabulary that generated tags must come from, so tags overlap across artworks and array-overlap matching on the existing GIN index actually returns neighbours.

**Contract**: Export a readonly array of roughly 80–120 lowercase terms grouped by facet — medium, style, subject, palette, mood — plus a Zod enum derived from it. Every term must satisfy the existing storage constraint of 30 characters or fewer. Group boundaries should be expressed in the module so the prompt can ask for coverage across facets rather than five near-synonyms from one facet.

#### 5. Response schema

**File**: `src/lib/ai/schema.ts`

**Intent**: Describe the exact JSON shape the model must return, and reject anything else before it reaches the rest of the app.

**Contract**: A Zod object with `description` (string, trimmed, capped at 2000 characters to match `artworks_description_length`) and `tags` (array of the taxonomy enum, min 5, max 12, deduped).

The 12-tag cap is deliberately below the new 20-tag storage ceiling: it leaves room for up to 8 artist-typed tags to survive the publish-time merge without the generated set crowding them out. Raising the floor from 3 to 5 reflects the wider ceiling — with 20 slots available, a 3-tag suggestion is thin.

#### 6. Enrichment call

**File**: `src/lib/ai/enrich.ts`

**Intent**: Issue one structured-output call against OpenRouter with an image and a prompt, walking a fallback chain of free models and abandoning the attempt at 12 seconds.

**Contract**: `enrichFromImage(dataUrl: string): Promise<EnrichmentResult>` where the result discriminates success from a typed failure (`"unconfigured" | "timeout" | "rate_limited" | "unavailable" | "invalid_response"`). Returning a typed failure rather than throwing is what lets callers decide whether to surface or swallow it.

Behaviour: return `unconfigured` immediately when `OPENROUTER_API_KEY` is absent, so an unconfigured environment costs nothing. Try each model in `MODELS` in order; advance to the next on a 429 or an unavailability error; do not advance on a schema-validation failure, which indicates a prompt problem rather than a model problem. Apply a single 12-second budget across the whole chain via `AbortSignal.timeout`, not per attempt — a per-attempt timeout would let a three-model chain run for 36 seconds and break the guardrail.

`MODELS` is an ordered constant, verified against the live catalogue on 2026-09-09:
`["nex-agi/nex-n2.5-pro:free", "nex-agi/nex-n2.5-mini:free", "dots-studio/dots-3-note-preview:free"]`

The prompt must instruct the model to describe the artwork in the artist's register (a short paragraph, no preamble, no "this image shows"), and to select tags only from the supplied taxonomy with coverage across facets. Pass the taxonomy in the prompt; the Zod enum is the enforcement, the prompt is the steer.

**File**: `src/lib/ai/index.ts` — re-export the public surface (`enrichFromImage`, the result type, the taxonomy) so callers import from `@/lib/ai`.

#### 7. Environment documentation

**File**: `.env.example`

**Intent**: Record the new variable and make explicit that it is optional.

**Contract**: Append `OPENROUTER_API_KEY=sk-or-v1-...` under a comment stating that it is server-only (deliberately not `NEXT_PUBLIC_`), that absence disables enrichment without breaking upload, and that the free tier allows 20 requests/minute and 1000/day once $10 of credits has been purchased.

#### 8. Unit tests

**File**: `test/lib/ai.test.ts`

**Intent**: Cover the logic most likely to break — malformed model output and the failure ladder — with the AI SDK mocked.

**Contract**: Mock `ai`'s `generateObject` via `vi.hoisted` (module-level consts are not visible inside hoisted `vi.mock` factories — see AGENTS.md). Cases: taxonomy terms all within 30 characters and unique; schema rejects an off-taxonomy tag; schema rejects 11 tags; `unconfigured` returned with no key set and `generateObject` never called; a 429 on the first model advances to the second; a schema failure does not advance; a timeout maps to the `timeout` failure.

### Success Criteria

#### Automated Verification

- Dependencies install cleanly: `npm install`
- Unit tests pass: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Build succeeds: `npm run build` (must pass with `OPENROUTER_API_KEY` unset — see Critical Implementation Details)
- Type regeneration produces no diff: `npm run db:types:local && git diff --exit-code src/types/database.ts`

#### Manual Verification

- The migration applies cleanly against the local stack. Per the owner's convention, the implementer proposes the command rather than running it:

  ```bash
  supabase migration up --local
  ```

- After the migration, inserting an artwork with 20 tags succeeds and one with 21 is rejected by `artworks_tags_length`
- With a real `OPENROUTER_API_KEY`, a one-off script against a sample artwork image returns a plausible description and 5–12 on-taxonomy tags
- Removing the key makes the same call return `unconfigured` without a network request

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Transport — Server Action and Client Downscale

### Overview

Get image bytes from the browser to the service cheaply and safely: the client shrinks the image, the Server Action validates it at the boundary and enforces auth.

### Changes Required

#### 1. Client-side downscale helper

**File**: `src/lib/artworks/downscale.ts`

**Intent**: Turn a selected `File` into a small JPEG data URL, so a 10 MB upload becomes roughly 100 KB on the wire and costs far fewer image tokens.

**Contract**: `downscaleToDataUrl(file: File, maxEdge = 768): Promise<string>` returning a `data:image/jpeg;base64,...` string. Browser-only (uses `createImageBitmap` and a canvas) — this module must not be imported by any server module, and must not carry `server-only`. Preserve aspect ratio, never upscale an image already under `maxEdge`, and revoke any object URL it creates. JPEG quality around 0.8 is ample for tagging.

#### 2. Enrichment Server Action

**File**: `src/app/actions/enrichment.ts`

**Intent**: Expose enrichment to the client behind the same auth and validation discipline as every other mutation, and keep the API key server-side.

**Contract**: `"use server"` module exporting `suggestArtworkFields(dataUrl: string): Promise<SuggestionState>`. Call `requireArtist()` first (`src/lib/auth/dal.ts`), matching `createArtwork`. Validate the input with Zod before use, per AGENTS.md: a string matching a `data:image/(png|jpeg|webp);base64,` prefix with a decoded size ceiling of about 1.5 MB — the downscaled payload is far below this, so the ceiling exists to stop a hand-crafted request from forwarding a huge image to the model.

Unlike `createArtwork`, this is a plain async function rather than a `useActionState` reducer, because it is invoked imperatively from a button handler rather than by form submission. Return a discriminated result carrying either the suggestion or a user-facing message derived from the service's typed failure — mapping `rate_limited` and `timeout` to distinct, actionable copy.

#### 3. Action tests

**File**: `test/actions/enrichment.test.ts`

**Intent**: Cover the validation gate and the auth gate, following the existing Server Action test pattern.

**Contract**: Mock `@/lib/auth/dal` and `@/lib/ai` with `vi.hoisted`, as `test/actions/artworks.test.ts:3-9` does. Cases: a non-data-URL input is rejected without calling the service; an oversized payload is rejected; a valid input forwards to the service and maps a typed failure to a message.

### Success Criteria

#### Automated Verification

- Unit tests pass: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification

- In a browser, selecting a large photo and logging the downscaled data URL shows a payload roughly two orders of magnitude smaller than the original file
- The downscaled image is still clearly legible as the artwork

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Form Assistance UI

### Overview

Add the per-field assistance controls, the shared single-call result cache, and the in-flight and error states — without disabling publish at any point.

### Changes Required

#### 1. Controlled-value support in `Field`

**File**: `src/components/ui/Field.tsx`

**Intent**: Allow the description and tags fields to be filled programmatically while staying editable.

**Contract**: Add optional `value` and `onValueChange` props. When `value` is supplied the field renders controlled and `defaultValue` is ignored; when it is absent, behaviour is byte-for-byte what it is today. `onChange` must keep working for the file input. Add an optional `action` slot rendered next to the label, so the assistance control sits in the field's own header rather than being positioned by the parent. Every existing call site — `LoginForm`, `SignupForm`, `DisplayNameForm`, `BecomeArtistForm`, and the untouched fields of `ArtworkForm` — must be unaffected.

#### 2. Assistance controls in `ArtworkForm`

**File**: `src/components/artworks/ArtworkForm.tsx`

**Intent**: Wire the controls, hold the shared cached result, and keep the form fully usable while a request is in flight.

**Contract**: Render assistance controls only when `!isEdit` and an image is selected — the edit form has no image input, so it has nothing to analyse. Hold three pieces of state: the cached `EnrichmentResult`, an in-flight flag, and an error message.

Behaviour: clicking either control uses the cached result when present and only calls `suggestArtworkFields` otherwise; the description field takes the description, the tags field takes `tags.join(", ")` to match the existing comma-separated contract. Both fields become controlled once filled. The in-flight flag disables only the two assistance controls and shows progress on the triggered field — it must never touch the submit button, which is already bound to the form's own `pending` state (`src/components/artworks/ArtworkForm.tsx:17`). Errors render as non-blocking text near the field, leaving manual typing available.

Selecting a different image clears the cached result and the error inside the existing `onImageChange` handler, so the second control cannot fill from a stale analysis.

Carry the cached tags into the form submission as a hidden input so Phase 4 can reuse them instead of paying for a second model call.

#### 3. Overwrite semantics

**Intent**: Satisfy the PRD's no-overwrite rule without making the control feel broken.

**Contract**: PRD FR-002 forbids replacing artist content "without an explicit action on that field's control" — clicking the control **is** that explicit action, so a click always fills. To keep it recoverable, capture the field's prior value on fill and offer a single "Undo" affordance next to the control that restores it. This resolves PRD Open Question 5: a prior untouched suggestion does not block a re-run.

### Success Criteria

#### Automated Verification

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Existing tests still pass: `npm run test`
- Build succeeds: `npm run build`

#### Manual Verification

- Selecting an image and clicking Suggest on Description fills it; clicking Suggest on Tags then fills instantly with no second network request (verify in the Network tab)
- The Upload button stays enabled throughout an in-flight suggestion, and other fields stay editable
- Editing a suggestion and clicking Suggest again replaces it, and Undo restores the edited text
- Changing the image clears the cache — the next Suggest issues a fresh request
- With `OPENROUTER_API_KEY` removed, the control shows a non-blocking message and the piece still publishes
- Login, signup, display-name and become-artist forms are visually and behaviourally unchanged

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Publish-Time Baseline Tagging and Documentation

### Overview

Guarantee no piece is published with fewer than five tags, without slowing or endangering publish. Then record the decisions this plan made against the PRD.

### Changes Required

#### 1. Top-up in `createArtwork`

**File**: `src/app/actions/artworks.ts`

**Intent**: Fill the tag gap at publish for under-tagged pieces, reusing the client's cached suggestion when it was submitted.

**Contract**: Extend `CreateArtworkSchema` with an optional `suggestedTags` field parsed through the same normalization as `tags`, sourced from the hidden input added in Phase 3. After validation and after the image upload succeeds, when `tags.length < 5`: merge in `suggestedTags` first (deduped, artist tags kept ahead of generated ones), and only if the merged list is still under five, call `enrichFromImage` once with the uploaded bytes. Cap the final list at the shared ceiling constant (20) so the insert can never violate `artworks_tags_length`.

Artist tags lead the merged array and generated tags fill behind them, so if the cap ever truncates, it truncates generated tags first — the artist's own words are never the ones dropped.

The whole top-up must sit inside a `try`/`catch` that swallows every failure and proceeds with the artist's original tags — publishing must never fail because enrichment did. The `redirect("/studio")` call at line 141 must stay **outside** that `try`, since `redirect` signals by throwing and catching it would break navigation.

Do not add a top-up to `updateArtwork`: editing has no image in hand, and the PRD scopes enrichment to upload.

#### 2. Action tests

**File**: `test/actions/artworks.test.ts`

**Intent**: Cover the new branch points without reaching Supabase or a model.

**Contract**: Extend the existing file, mocking `@/lib/ai`. Cases: five or more artist tags means the service is never called; fewer than five with sufficient `suggestedTags` supplied means the service is never called; fewer than five with no suggestions calls the service once; a service failure still produces a successful insert path with the artist's original tags; the merged result never exceeds 20 tags, and when it would, generated tags are dropped before artist tags.

#### 3. Project documentation

**File**: `AGENTS.md`

**Intent**: Tell the next agent where the AI layer lives and what its rules are.

**Contract**: Add a short subsection covering: `src/lib/ai/` is the only module that talks to a model; enrichment is always optional and its failures are swallowed at publish; generated tags come from the taxonomy while artist tags stay free text; `OPENROUTER_API_KEY` is server-only.

#### 4. PRD reconciliation

**File**: `context/foundation/prd.md`

**Intent**: Close the open questions this planning session answered and correct the stale storage claim.

**Contract**: Resolve Open Question 1 (controlled vocabulary for generated tags), 2 (N = 5), 3 (12-second budget), and 5 (an explicit control click authorises replacement, with Undo). Record Open Question 4 as accepted risk: the OpenRouter free tier carries no data-retention or no-training guarantee, which was knowingly traded for zero cost — note that Vercel AI Gateway offers `zdr=all` / `no_training=all` models from about $0.03 per million input tokens should that become a requirement. Correct the Scope of Change note that says this change "does add a persisted tag list on the artwork record": the column already existed.

### Success Criteria

#### Automated Verification

- All tests pass: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting is clean: `npm run format:check`
- Build succeeds: `npm run build`

#### Manual Verification

- Publishing with zero tags yields a piece with at least five tags in the studio list
- Publishing with six artist tags leaves them untouched and issues no model call
- Publishing with two artist tags after running a suggestion issues no second call (verify in the OpenRouter activity log)
- With `OPENROUTER_API_KEY` removed, publishing an untagged piece still succeeds and the piece simply has no tags
- Existing artworks, the studio list, and the collector swipe and like flows are unchanged

---

## Testing Strategy

### Unit Tests

- Taxonomy integrity: every term unique, lowercase, and within the 30-character storage constraint
- Response schema: rejects off-taxonomy tags, rejects fewer than 5 or more than 12 tags, rejects an over-long description
- Failure ladder: `unconfigured` short-circuits before any network call; 429 advances the model chain; a schema failure does not; timeout maps correctly
- Server Action boundaries: data-URL shape and size rejected before the service is reached; auth enforced first

### Integration Tests

Not applicable — the project has no integration test layer, and AGENTS.md scopes coverage to a smoke layer over Server Actions and `src/lib` with Supabase and external services mocked. The end-to-end path is covered by the manual steps below.

### Manual Testing Steps

1. Set `OPENROUTER_API_KEY` in `.env.local`, run `npm run dev`, sign in as an artist, go to `/studio/new`
2. Select an artwork image; confirm the assistance controls appear only after selection
3. Click Suggest on Description; confirm progress shows on that field only and the Upload button stays enabled
4. Click Suggest on Tags; confirm it fills instantly with no second network request
5. Edit a suggestion, re-run it, and confirm Undo restores the edited value
6. Change the image and confirm the next Suggest issues a fresh request
7. Publish with two tags; confirm the stored piece has at least five and that no second model call was made
8. Publish a second piece with six tags; confirm no model call at all
9. Remove `OPENROUTER_API_KEY`, restart, and confirm suggestions fail gracefully while publishing still works
10. Confirm the swipe deck, liked list, and studio edit flow behave as before

## Performance Considerations

Client downscaling to a 768px JPEG is the main lever: it cuts a 10 MB upload to roughly 100 KB, which dominates both latency and image-token cost. The 12-second budget spans the entire fallback chain rather than each attempt, bounding worst-case wait.

Publish latency is unaffected in the common cases: a well-tagged piece makes no call, and an under-tagged piece whose artist already ran a suggestion reuses that result. Only an under-tagged piece with no prior suggestion pays a model call before insert — the one path where publish is measurably slower, and the reason the top-up is capped at a single attempt.

OpenRouter's free tier allows 20 requests per minute, which is far above single-artist usage, and 1000 per day once the owner's credit purchase lands.

## Migration Notes

One migration, and it is purely permissive: `artworks_tags_length` is dropped and recreated as `cardinality(tags) <= 20`. The `tags` column, its default, and its GIN index are untouched, all from `supabase/migrations/20260909160100_add_artworks.sql`.

Because the constraint only widens, every existing row already satisfies it — Postgres validates without a table rewrite, no backfill is needed, and existing artworks remain valid with zero tags. A check constraint does not surface in `src/types/database.ts`, so `npm run db:types:local` should produce no diff; run it to confirm.

Pushing the migration file to `main` auto-applies it via `.github/workflows/migrations.yml`. Per AGENTS.md, `20260909160100_add_artworks.sql` must not be edited — the ceiling change is a new file.

**Rollback** is the awkward direction. Reverting the constraint to `<= 10` would fail if any row has since accumulated more than 10 tags, so a rollback migration must trim over-long arrays before re-adding the tighter constraint. Rolling back the rest of the change is just removing the assistance controls and the top-up branch; no structurally new data is written.

## References

- PRD: `context/foundation/prd.md` (FR-001 through FR-006, Open Questions 1–5)
- Change identity: `context/changes/ai-artwork-enrichment/change.md`
- Brief: `context/changes/ai-artwork-enrichment/plan-brief.md`
- Existing tag normalization to reuse: `src/app/actions/artworks.ts:47-72`
- Existing schema and constraints: `supabase/migrations/20260909160100_add_artworks.sql:11,17,27`
- Server Action test pattern to follow: `test/actions/artworks.test.ts:1-30`
- OpenRouter free-tier limits: https://openrouter.ai/docs/api-reference/limits
- AI SDK docs, once installed: `node_modules/ai/docs/`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Tag Ceiling and Enrichment Service

#### Automated

- [x] 1.1 Dependencies install cleanly: `npm install` — 653c4ca
- [x] 1.2 Unit tests pass: `npm run test` — 653c4ca
- [x] 1.3 Type checking passes: `npm run typecheck` — 653c4ca
- [x] 1.4 Linting passes: `npm run lint` — 653c4ca
- [x] 1.5 Formatting is clean: `npm run format:check` — 653c4ca
- [x] 1.6 Build succeeds with `OPENROUTER_API_KEY` unset: `npm run build` — 653c4ca
- [ ] 1.7 Type regeneration produces no diff: `npm run db:types:local && git diff --exit-code src/types/database.ts`

#### Manual

- [ ] 1.8 Migration applies cleanly against the local stack (`supabase migration up --local`, run by the owner)
- [ ] 1.9 An artwork with 20 tags inserts; one with 21 is rejected by `artworks_tags_length`
- [ ] 1.10 Real key returns a plausible description and 5-12 on-taxonomy tags for a sample image
- [ ] 1.11 Missing key returns `unconfigured` without a network request

### Phase 2: Transport — Server Action and Client Downscale

#### Automated

- [ ] 2.1 Unit tests pass: `npm run test`
- [ ] 2.2 Type checking passes: `npm run typecheck`
- [ ] 2.3 Linting passes: `npm run lint`
- [ ] 2.4 Build succeeds: `npm run build`

#### Manual

- [ ] 2.5 Downscaled payload is roughly two orders of magnitude smaller than the original file
- [ ] 2.6 Downscaled image is still clearly legible as the artwork

### Phase 3: Form Assistance UI

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Existing tests still pass: `npm run test`
- [ ] 3.4 Build succeeds: `npm run build`

#### Manual

- [ ] 3.5 Second field fills instantly from cache with no second network request
- [ ] 3.6 Upload button stays enabled and other fields stay editable during an in-flight suggestion
- [ ] 3.7 Re-running a suggestion replaces the value and Undo restores it
- [ ] 3.8 Changing the image clears the cache and forces a fresh request
- [ ] 3.9 With no API key, the control fails non-blockingly and the piece still publishes
- [ ] 3.10 Login, signup, display-name and become-artist forms are unchanged

### Phase 4: Publish-Time Baseline Tagging and Documentation

#### Automated

- [ ] 4.1 All tests pass: `npm run test`
- [ ] 4.2 Type checking passes: `npm run typecheck`
- [ ] 4.3 Linting passes: `npm run lint`
- [ ] 4.4 Formatting is clean: `npm run format:check`
- [ ] 4.5 Build succeeds: `npm run build`

#### Manual

- [ ] 4.6 Publishing with zero tags yields a piece with at least five tags
- [ ] 4.7 Publishing with six artist tags issues no model call
- [ ] 4.8 Publishing after a suggestion issues no second call
- [ ] 4.9 With no API key, publishing an untagged piece still succeeds
- [ ] 4.10 Existing artworks, studio list, and swipe/like flows are unchanged
- [ ] 4.11 A piece with 15 artist tags saves successfully, confirming the raised ceiling end to end
