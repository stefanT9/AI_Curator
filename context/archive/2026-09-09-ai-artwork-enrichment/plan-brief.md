# AI Enrichment for Artwork Uploads — Plan Brief

> Full plan: `context/changes/ai-artwork-enrichment/plan.md`
> PRD: `context/foundation/prd.md`

## What & Why

Artists won't do manual metadata work — every extra field on the upload screen is a reason to abandon a post, so pieces arrive with thin descriptions and no structured tags. ArtSwipe's whole value proposition depends on a dense descriptive signal per artwork, and today that signal doesn't exist. This change derives it from the uploaded image instead of asking the artist for it: a one-click suggestion for the description and tags fields, plus an automatic top-up at publish so no piece reaches the future recommender under-tagged.

## Starting Point

The upload path is one Server Action (`createArtwork`) and one shared form component. **The `tags text[]` column already exists** with a GIN index — so the PRD's claim that this change adds tag storage is stale — but it carries a `cardinality(tags) <= 10` check constraint, and raising that ceiling to 20 needs a migration. The existing `TagsSchema` already normalizes tags exactly as the model's output will need. The one real obstacle: the image lives only as a client-side `File` until publish, so there is no URL to hand a model at suggestion time.

## Desired End State

An artist selects an image and sees a Suggest control on the Description and Tags fields. Clicking either issues a single model call returning both values; the other field then fills instantly from the cached result. Everything stays editable, and the Upload button is never disabled. Publishing a piece with fewer than five tags tops it up silently. With the API key absent or the model failing, upload and publish behave exactly as they do today.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Scope | Tags **and** description assist | Closes PRD FR-001–FR-004 in one pass, no PRD amendment for deferral | Plan |
| Provider | OpenRouter free tier via Vercel AI SDK | Genuinely $0; three free vision models support structured outputs | Plan |
| Image transport | Client downscales to ~768px JPEG data URL | Turns a 10 MB upload into ~100 KB; no change to the storage flow | Plan |
| Tag vocabulary | Controlled taxonomy (~80–120 terms) for generated tags | Guarantees overlap between artworks, which array-overlap matching needs | Plan (PRD OQ 1) |
| Call shape | One call returns both fields, cached client-side | At most 2 model calls per upload, usually 1 — makes the "bounded operations" guardrail exact | Plan |
| Baseline trigger | Top up when tags < 5 | Highest guaranteed signal density for the future recommender | Plan (PRD OQ 2) |
| Tag ceiling | Raise from 10 to 20 (new migration) | Lets artist tags and generated tags coexist instead of competing for slots | Plan |
| Generated tag count | 5–12 per suggestion | Sits below the 20 ceiling, leaving room for up to 8 artist tags to survive the merge | Plan |
| Failure policy | 25s budget across a 3-model fallback chain; publish-time failures swallowed | Absorbs the two failure modes the free tier actually produces (429s, model churn). Planned at 12s; raised during Phase 1 after live measurement showed ~1 call in 3 timing out | Plan (PRD OQ 3), revised in impl |
| Overwrite rule | A control click authorises replacement, with Undo | PRD FR-002 names the control click as the explicit action | Plan (PRD OQ 5) |
| Testing | Node-only, model mocked | Matches the existing smoke-layer convention; no jsdom needed | Plan |
| Data retention | Accepted risk | `:free` carries no no-training guarantee; traded knowingly for zero cost | Plan (PRD OQ 4) |

## Scope

**In scope:** migration raising the tag ceiling to 20 · `src/lib/ai/` service (taxonomy, schema, fallback chain, timeout) · `suggestArtworkFields` Server Action · client downscale helper · assistance controls on the create form · publish-time top-up in `createArtwork` · unit tests · AGENTS.md and PRD reconciliation.

**Out of scope:** the recommendation engine · retro-tagging existing artworks · title assistance · a bulk fill-everything action · any change to the `tags` column or its index beyond the ceiling · backfilling existing rows · component tests / jsdom · enrichment on the edit form (it has no image input).

## Architecture / Approach

Four layers, bottom-up. A pure `src/lib/ai/` module is the only place that knows about a model — it owns the taxonomy, the Zod response schema, the free-model fallback chain, and a single 12-second budget spanning the whole chain. A Server Action wraps it with `requireArtist()` and a Zod data-URL gate. The browser downscales before sending, so payloads stay tiny. `ArtworkForm` holds one cached result shared by both controls, cleared when the image changes, and forwards it as a hidden input so `createArtwork` can top up without paying for a second call.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Tag ceiling + enrichment service | Migration to 20 tags, `src/lib/ai/`, deps, env wiring, unit tests | Free models may not honour structured output reliably in practice |
| 2. Transport | Downscale helper + `suggestArtworkFields` action | Canvas resize behaviour varies across browsers |
| 3. Form assistance UI | Controlled `Field`, controls, cache, error states | `Field` is shared by four other forms — regression surface |
| 4. Baseline tagging + docs | Top-up in `createArtwork`, AGENTS.md, PRD updates | Enrichment failure must never fail a publish; `redirect` throws and must stay outside the try |

**Prerequisites:** An OpenRouter account with `OPENROUTER_API_KEY` (placeholder already added to `.env.example` and `.env.local`), the $10 credit purchase (lifts the daily cap from 50 to 1,000 requests), and a running local Supabase stack to apply the migration against.
**Estimated effort:** ~3–4 sessions, one per phase, with Phase 3 the largest.

## Open Risks & Assumptions

- **Free-model reliability — now measured.** Phase 1 exercised all three candidates live. Structured output works; latency is the constraint. On a real 768px/106KB image the chain returns in 4.8-8.5s, but latency is variable enough that the original 12s budget failed ~1 call in 3, hence 25s. The chain is ordered by measured speed (mini 1.5-3.2s, dots 6.2-11.1s, pro 9.1-10.5s). If this degrades, Vercel AI Gateway's `alibaba/qwen3.7-flash` at ~$0.03/M input (≈$0.00003 per artwork) remains a one-string swap.
- **The free roster churns.** Model IDs can disappear without notice; the fallback chain mitigates this but will need occasional refreshing.
- **No data-retention guarantee.** `:free` models generally permit training on submitted content, which means artists' unpublished images. Accepted for now; revisit before any public launch.
- **Mixed tag provenance.** Artist tags stay free text while generated tags are controlled, and the column can't distinguish them. Accepted — the PRD defers richer structure to the recommender change.
- **Rolling the tag ceiling back is not symmetric.** Widening 10 → 20 is free, but reverting would fail against any row that has since exceeded 10 tags, so a down-migration must trim first.
- **PRD Open Questions 6, 7 and 8** (secondary success outcome, logged-out access, retro-tagging) remain unanswered. None block this change.

## Success Criteria (Summary)

- An artist fills description and tags from the image with one action each, edits freely, and publishes — with at most two model calls for the whole upload.
- No piece publishes with fewer than five tags unless enrichment is unavailable, and a piece can now carry up to 20.
- With the AI unconfigured or failing, upload and publish work exactly as they do today.
