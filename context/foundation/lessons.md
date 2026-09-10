# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Never block a user-visible mutation on a third-party AI call

**Context:** `src/app/actions/artworks.ts:128` — `createArtwork` evaluated `tags: await topUpTags(tags, imagePath)` before the row insert, so publishing an under-tagged piece waited on the OpenRouter fallback chain (25s budget) before anything was written.

**Problem:** The AI call sat on the critical path of a mutation the user is watching. The PRD guardrail said verbatim "no step in the upload flow blocks waiting on an AI response", and the code violated it while a comment two lines away claimed enrichment "never blocks publishing" — true of model _failure_, false of model _latency_. It also widened an orphan window: the uploaded object had no row for the whole 25s.

**Rule:** Write the user's own data first, then enrich. A third-party AI call must never sit between a user action and its durable result — insert or update with what the user supplied, then top up asynchronously and write the enrichment as a second, non-blocking step. If enrichment must be inline, its budget belongs to the interaction's latency budget, not the model's.

**Applies to:** Any Server Action or mutation path that calls `src/lib/ai/`, and any future enrichment of artworks, profiles or interactions.
