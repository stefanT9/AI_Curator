---
change_id: real-artwork-corpus
title: Real artwork corpus
status: archived
created: 2026-09-10
updated: 2026-09-11
archived_at: 2026-09-11T07:50:43Z
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

*Retry proved the 429s transient.* Running `--retry-failed` over the 23 pinned failures recovered
**22 of them**, all on the first attempt at concurrency 2. Nothing about those pieces was hard for
the model; they were casualties of our own request rate. This is the evidence for keeping
concurrency at 2 and for making retry an ordinary part of the workflow rather than a rescue hatch.

*Corpus state at Phase 2 close: 197 of 1000 pinned — 196 enriched, 1 failed.* Owner will drive
the remainder manually via the resume/retry scripts. Consequences carried forward:

- **Criteria 2.6 and 2.9 are left unchecked, not claimed.** Both describe a fully-enriched
  manifest: 2.6 wants every piece to carry enrichment or a failure reason (803 are untouched),
  and 2.9 wants a re-run to be byte-identical (every run so far still had work to do). What *is*
  proven is the substance underneath 2.9: across three further runs, all 146 pieces enriched at
  snapshot time came back **byte-identical**, and resume reports pinned failures as skipped.
- **Phase 3's untagged-tail criteria (3.7, 3.10) assume ~5%.** Reality is ~80% until the manual
  runs finish. Re-decide at the top of Phase 3 against the corpus that exists then.

**2026-09-10, Phase 3 — coverage measured: 67/100 terms, and one finding worth carrying.**
The report vindicates the picker reversal: `street art` has exactly 1 piece and `psychedelic`,
`pop art`, `cubist`, `art deco`, `brutalist`, `hyperrealism` and `naive` have none. A 19th-century
CC0 collection genuinely lacks them.

**But the palette facet is capped by our own mapper, not by the collection.** Only 7 of 20 palette
terms are reachable at all: `paletteTags` emits monochrome, black and white, desaturated, muted,
vivid and three hue-dominants, and enrichment's palette terms are deliberately discarded in favour
of the museum's HSL reading. So `sepia`, `warm palette`, `cool palette`, `pastel palette`,
`earth tones`, `jewel tones`, `neon`, `high contrast`, `primary colours`, `complementary`,
`gradient` and `metallic` can never be covered however much of the corpus is enriched. That is a
design consequence, not a fact about public-domain art — **the data-driven picker change should
not treat the two kinds of "uncovered" as one category.**

Untagged tail: exactly 50 pieces (5.0%), spaced every 20 slots, deterministic from `slot` alone,
with one piece inside each end-window so the sort key is observable whichever end Phase 4 calls
newest. Coverage re-runs byte-identical. Style/mood coverage will grow as the owner resumes
enrichment; the report says so and is the honest way to re-measure.

**2026-09-10, Phase 4 — generated, verified against the local stack, with two numbers worth carrying.**

*The corpus is real and applies cleanly.* `db reset` seeded 1000 artworks, 8 warm likes,
0 cold, and 0 rows violating `image_path_pattern`; `db:seed:images` put 1000 objects in the
bucket. The identities section above the marker was proved byte-identical by diff, and a
second `db:seed:generate` left both `seed.sql` and `corpus.json` unchanged byte for byte.

*`tags = '{}'` reads 54, not 50.* Fifty are the deliberate untagged tail. The other four —
aic 217672 and 217697 (Xugu calligraphy), 269138, 270369 — are pieces whose AIC metadata
mapped to no taxonomy term at all and which enrichment has not reached. They will drop out
of the count as the owner resumes enrichment, because style and mood come only from the
model. Criterion 4.9 says "~50" and is satisfied, but the number is a reading of the
half-enriched state, not a stable property of the corpus.

*Criterion 4.14 was confirmed against the terms that have pieces behind them.* With 803 of
1000 pieces unenriched, roughly 13 of the 20 style terms are populated; the owner confirmed
the picker works for those. Full style coverage was never this change's promise after the
2026-09-10 picker reversal — the data-driven picker change is what stops a collector meeting
an empty pool. Recorded rather than reworded, per the lesson on Progress items.

*The like history is emergent, not designed.* The generator picked `figurative` as the most
populous style term and liked its eight oldest members, pinning both into the manifest under
`like_history` so Phase 5's walkthrough can name the group instead of rediscovering it.

**2026-09-10, Phase 5 close — the instrument is re-established, and one thing about it is weaker
than the plan assumed.** `judgment.md` groups by a first-match rule (style chip → medium chip →
subject-only), because with 196 of 1000 pieces enriched, 759 of the 946 tagged pieces carry no
style term at all and the plan's implied style-only grouping would have left most of the corpus
ungrouped. Both walks were run and both predictions held — Walk A concentrates `figurative` at
the front, Walk B shows no untagged card in the first 20 — but **the twenty labels were not
transcribed card by card**, so the recorded baseline is a shape check, not a positional diff. A
future ranking change needing a true before/after must re-transcribe first; the doc says so where
the baseline is recorded, and the manifest-computed predicted sequences are the template.

Two departures from the plan's Phase 5 contract, both deliberate. The supersede annotation went
**under the archived file's H1 rather than appended**, because criterion 5.9 asks for the reader
to be told within the first screen. And the roadmap entry does **not** carry the plan's promised
residual "a handful of style terms are covered by curatorial override" — overrides were dropped
on 2026-09-10 and never built. What is recorded instead is the real residual, and the distinction
Phase 3 found: style/mood gaps are facts about public-domain art and narrow as enrichment
resumes, whereas 13 of 20 palette terms are unreachable by `paletteTags` itself. The data-driven
picker change must not conflate them.

Progress items 2.6 and 2.9 are carried into archive unchecked, per the Phase 2 decision above.
