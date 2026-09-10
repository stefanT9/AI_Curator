---
change_id: real-artwork-corpus
title: Real artwork corpus
status: implementing
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

**2026-09-10, Phase 2 — trial measured, then the rate limit rewrote the plan.**

*Trial.* Two `--limit 25` runs: 50/50 enriched, 0 failures, 2.7s per piece at concurrency 4,
one model request per piece — the first-choice model never fell through. Descriptions are in a
first-person artist register; style/mood terms are defensible; 10 of 20 style and 10 of 20 mood
terms appeared across just 50 pieces. Max combined tag count is 10, so the 20-term ceiling and
its round-robin trim never fire on real data — `combineTags` is a guard, not a live path.

*What the trial could not see.* Sized at 500 on that evidence, the long run degraded badly after
~120 pieces: 22 `rate_limited` failures. Cause is ours, not the model's — OpenRouter caps `:free`
models near **20 requests/minute**, and concurrency 4 at ~10s per call is ~24/minute. The first
~120 pieces rode burst allowance. Because a pinned failure is never retried, each 429 was
silently making a piece permanently metadata-only, so the run was stopped.

*Two fixes, both owner-approved.* **`ENRICH_CONCURRENCY` 4 → 2** (~12 requests/minute), a
deliberate deviation from the plan's stated "bounded at 4" — the plan's number predates the
measurement. And **`--retry-failed`**, an opt-in that reopens pinned failures; it must be opt-in
because a pinned failure counts as done, which is what makes a plain re-run a true no-op.
Verified: concurrency 2 ran 26 further pieces with **zero** failures, and the first retried 429
piece succeeded immediately — those failures were transient, not model incapacity.

*Scripts.* `db:seed:enrich` resumes by default; `db:seed:enrich:resume` is the same command under
a name that says so; `db:seed:enrich:retry` reopens failures. All three invoke `tsx` directly —
an earlier version aliased through `npm run`, which swallows extra args (`--limit 1` was dropped
and a 1-piece check started all 830).

*Corpus state at Phase 2 close: 197 of 1000 pinned — 174 enriched, 23 failed.* Owner will drive
the remainder manually via the resume/retry scripts. Consequences carried forward:

- **Criteria 2.6 and 2.9 are left unchecked, not claimed.** Both describe a fully-enriched
  manifest: 2.6 wants every piece to carry enrichment or a failure reason (803 are untouched),
  and 2.9 wants a re-run to be byte-identical (every run so far still had work to do). What *is*
  proven is the substance underneath 2.9: across three further runs, all 146 pieces enriched at
  snapshot time came back **byte-identical**, and resume reports pinned failures as skipped.
- **Phase 3's untagged-tail criteria (3.7, 3.10) assume ~5%.** Reality is ~80% until the manual
  runs finish. Re-decide at the top of Phase 3 against the corpus that exists then.
