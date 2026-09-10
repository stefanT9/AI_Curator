---
change_id: real-artwork-corpus
title: Real artwork corpus
status: impl_reviewed
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

**2026-09-10, during Phase 1 — corpus size raised from ~168 to 1000.** Owner's call, taken
after the Phase 1 spot-check confirmed the metadata tags read as true of the pieces. `plan.md`
and `plan-brief.md` were updated to describe the 1000-piece corpus rather than left describing
one that no longer exists. Consequences: the untagged tail scales to ~50 (5%) so Phase 3's
newest-20 check stays satisfiable, and Phase 2 becomes ~1000 enrichment calls — to be settled
at the start of that phase, not assumed here.

**2026-09-10, after Phase 1 — onboarding coverage fixed at the root, not in the corpus.**
Owner's call. The picker will offer only terms with artworks behind them, computed from the
catalogue, as a **separate change** (application code, out of this change's scope). Effects
here: Phase 3's curatorial overrides are dropped entirely and its coverage stage becomes a
report that always exits 0; Phase 2 no longer has to reach 20/20, so a subset of the 1000 is a
legitimate corpus rather than a gap to paper over. Rationale: a 19th-century-heavy CC0 corpus
genuinely lacks `street art`, and a brand-new production deployment has the same empty-pool bug
regardless of what this corpus contains — so the picker, not the seed data, is where it belongs.

**2026-09-10, Phase 1 impl review — merge constraint.** Phases 1-4 must land together. Phase 1
deletes the placeholder PNGs that `seed.sql` still references 54 times; only Phase 4's `generate`
stage rewrites those rows. The branch is intentionally non-functional for local dev in between.
See the plan's "Known Intermediate State" section.

**2026-09-10, before Phase 2 — trial first.** Enrich 25 pieces, measure per-piece latency,
failure rate and tag quality, then choose the full number. Requires a `--limit` option on the
enrich stage. OpenRouter account measured: credits present (not free-tier), so the cap is 1000
free-model requests/day; `:free` models cost nothing. `enrichFromImage` can spend up to 3
requests per piece via its fallback chain.
