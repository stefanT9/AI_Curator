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
