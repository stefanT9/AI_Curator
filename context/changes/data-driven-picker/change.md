---
change_id: data-driven-picker
title: Onboarding picker offers only style terms that have artworks behind them
status: new
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

Fix the empty-starter-pool defect at its root. `StyleTermPicker` renders all 20 terms of
`TAXONOMY_BY_FACET[ONBOARDING_FACET]` regardless of what the catalogue holds, so a collector can
pick a term no artwork carries and land on the exhaustion path with no likes — indistinguishable
from a broken flow. Today 17 of 20 terms are empty; a brand-new production deployment with a
handful of artworks has the same bug for a different reason. It is a picker problem, not a seed
problem.

Decided 2026-09-10 during `real-artwork-corpus` Phase 1, choosing this over the alternatives:
narrowing `taxonomy.ts` (removes terms real artists will genuinely upload), switching
`ONBOARDING_FACET` to `subject` (18/20 covered by museum metadata, but changes what the product
asks collectors in order to suit seed data), and curatorial tag overrides (puts false tags on real
artwork to hit a number). That decision retired `real-artwork-corpus` Phase 3's override
mechanism — see its plan's Phase 3 amendment.

### Starting points

- `src/components/onboarding/StyleTermPicker.tsx` — `const TERMS = TAXONOMY_BY_FACET[ONBOARDING_FACET]`
- `src/lib/onboarding/config.ts` — `ONBOARDING_FACET`, `ONBOARDING_TERM_MIN` / `_MAX`, `ONBOARDING_POOL_SIZE`
- `src/lib/onboarding/terms.ts` — `StarterTermsSchema` validates against the same facet
- `src/lib/artworks/queries.ts` — `getStarterDeck`, `.overlaps("tags", terms)`

### Two things to settle in planning

1. **How the picker learns which terms are populated.** A `select distinct unnest(tags)` aggregate
   or a small RPC over the GIN-indexed `tags` column, cached — it sits on the onboarding path, so
   it should not be re-run per render.
2. **What happens when the catalogue is too thin to ask the question.** `ONBOARDING_TERM_MIN` is 2.
   If fewer than 2 style terms are populated, the picker cannot satisfy its own rule — that is the
   same bug moved somewhere new. Probably skip straight to the existing exhaustion path, but decide
   it deliberately rather than discovering it.

### Validation gate must move with the picker

`StarterTermsSchema` validates `?term=` against the full facet enum. If the picker narrows but the
schema does not, a hand-edited URL still reaches `getStarterDeck` with an empty term — which is
fine (it returns no rows) but means the guarantee is UI-only. Decide whether the gate should also
be data-driven or whether UI-only is sufficient.

### Correction, 2026-09-13

The note above says "Today 17 of 20 terms are empty". That was true when it was written
(2026-09-10, during `real-artwork-corpus` Phase 1) and is no longer: the corpus grew to 1000
pieces and enrichment ran over part of it. Counted against `supabase/seed-assets/corpus.json`
on 2026-09-13, **13 of 20 style terms are populated and 7 are empty**:

| populated                                | count |
| ---------------------------------------- | ----- |
| figurative                               | 88    |
| realism                                  | 55    |
| illustrative                             | 39    |
| geometric, folk art                      | 17 each |
| abstract                                 | 15    |
| art nouveau                              | 10    |
| expressionist, gestural                  | 5 each |
| impressionist                            | 4     |
| minimalist                               | 3     |
| surrealist, street art                   | 1 each |

Empty: hyperrealism, cubist, pop art, art deco, brutalist, naive, psychedelic.

Only 196 of the 1000 corpus rows carry enrichment tags, which is where essentially every style
tag comes from — so the unevenness is a property of enrichment coverage, not of the corpus size.

**The defect is unchanged in kind.** A collector can still pick a term with nothing behind it and
land on the exhaustion path with no likes, indistinguishable from a broken flow; and the
"brand-new production deployment" case in the note above is untouched by any of this. Only the
count moved.

The `course-completion` change routed around this rather than fixing it: `test/e2e/helpers.ts`
pins `POPULATED_STYLE_TERMS = ["figurative", "realism"]` so the browser lane and the README
screenshot capture cannot land on the exhaustion path. If this change lands and the picker only
ever offers populated terms, that constant can go.

This change stays **open and unplanned**.
