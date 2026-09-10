---
change_id: ai-artwork-enrichment
title: AI enrichment for artwork uploads — image-derived description and tags
status: archived
created: 2026-09-09
updated: 2026-09-10
archived_at: 2026-09-10T07:42:13Z
---

## Notes

I want an integration with openrouter/a service that sends an image to a free model and receives tags based on the images in a json format.

Scope was widened during planning to the full PRD surface (description assist + tags), per `context/foundation/prd.md`. Owner will purchase $10 of OpenRouter credits to lift the free-tier daily cap from 50 to 1000 requests/day.

Step 1.7 was adapted during implementation: `npm run db:types:local` crashes in the owner's environment and overwrites `src/types/database.ts` via a temp-file `mv`, so it was not run. Verified structurally instead — the generated types contain no representation of check constraints (no `cardinality`, no `check`, no `artworks_tags_length`; `tags` is simply `string[]`), so the raised ceiling provably cannot produce a diff. Do not run the `:local` type generator in this repo.

**Trigger design changed 2026-09-10.** The PRD's per-field "Suggest" controls were replaced by an automatic trigger on image selection: one model call fills description and tags together, and only where those fields are empty. Recorded against FR-002 in the PRD and in Phase 3 of the plan.

**Defect found and fixed 2026-09-10.** Commit `b99f16d` wired `enrichFromImage(imagePath)` into `createArtwork`, passing a Storage object key where the function expects a data URL or http URL. The SDK treated the key as base64, so every call failed silently and no artwork was ever enriched — while still costing up to 25s per publish. It also ran before the ownership and existence checks, and on every publish rather than only under-tagged ones. Replaced by `src/lib/artworks/top-up.ts`, which is conditional on `tags.length < 5`, runs after both gates, dedupes, and passes the public Storage URL.

**Manual verification complete 2026-09-10.** All 23 manual rows across phases 1, 1.5, 2, 3 and 4 confirmed passing by the owner.

**Implementation review 2026-09-10** (`reviews/impl-review.md`): NEEDS ATTENTION — 2 critical, 7 warnings, 1 observation. Five fixed (F1 quota, F2 top-up off the publish path, F3 Storage-blip deletion, F8 plan record, F10 partial), five skipped by owner decision. One rule recorded in `context/foundation/lessons.md`.
