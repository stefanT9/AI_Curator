---
change_id: ai-artwork-enrichment
title: AI enrichment for artwork uploads — image-derived description and tags
status: implementing
created: 2026-09-09
updated: 2026-09-09
archived_at: null
---

## Notes

I want an integration with openrouter/a service that sends an image to a free model and receives tags based on the images in a json format.

Scope was widened during planning to the full PRD surface (description assist + tags), per `context/foundation/prd.md`. Owner will purchase $10 of OpenRouter credits to lift the free-tier daily cap from 50 to 1000 requests/day.

Step 1.7 was adapted during implementation: `npm run db:types:local` crashes in the owner's environment and overwrites `src/types/database.ts` via a temp-file `mv`, so it was not run. Verified structurally instead — the generated types contain no representation of check constraints (no `cardinality`, no `check`, no `artworks_tags_length`; `tags` is simply `string[]`), so the raised ceiling provably cannot produce a diff. Do not run the `:local` type generator in this repo.
