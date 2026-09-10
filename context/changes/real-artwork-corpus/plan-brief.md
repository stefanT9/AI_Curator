# Real Artwork Corpus — Plan Brief

> Full plan: `context/changes/real-artwork-corpus/plan.md`

## What & Why

Replace the 54-piece synthetic ranking-evaluation corpus with 1000 real public-domain artworks
sampled from the Art Institute of Chicago, tagged from museum metadata plus the real enrichment
pipeline. F-01's own plan-brief named the limitation this closes: "the corpus is designed, not
sampled from real data. It can only show whether ranking _discriminates between clusters_, not
whether the tag vocabulary matches real artwork." Along the way it fixes a defect the synthetic
corpus was hiding — its tags are largely off-vocabulary, so **17 of 20 onboarding style pickers
currently return an empty starter pool**.

## Starting Point

`supabase/seed.sql` seeds three identities, 54 artworks in four designed clusters, and 8 likes;
five placeholder PNGs of 1.8–5.3 KB stand in for the art. Only 8 of its 16 distinct tags exist in
`src/lib/ai/taxonomy.ts` — it uses `blue`, `minimal`, `oil`, `warm`, `street`, `high-contrast`
where the vocabulary has `blue dominant`, `minimalist`, `oil painting`, `warm palette`,
`street art`, `high contrast`. Since `getStarterDeck` filters `overlaps("tags", terms)` against
the 20-term style facet, and the corpus carries only `abstract`, `geometric` and `figurative`,
most new collectors are dumped onto onboarding's exhaustion path.

## Desired End State

`npm run db:seed:fetch` once, then `npm run db:reset`, and the local catalogue is 1000 real
artworks by real artists — paintings, prints, ceramics, photographs, sculpture — tagged entirely
from the controlled vocabulary across all five facets. Every one of the 20 style terms yields a
non-empty starter pool. A fresh clone regenerates the identical corpus from a committed manifest.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Source | Art Institute of Chicago API | 62,056 CC0 works, no API key, and metadata that maps onto three of our five facets. |
| Assets | Fetch script; bytes gitignored | Keeps ~260 MB out of git history; the manifest is the durable artifact instead. |
| Corpus shape | Sample naturally, clusters emerge | The honest test of ranking on real data, rather than on a designed instrument. |
| Tagging | Museum metadata + enrichment top-up | Metadata knows medium/subject/palette; `style_titles` is period labels, so style and mood must come from the model. |
| Judging | Derive group labels after sampling | Keeps a walk a transcription, as F-01's was, without pretending the groups were planted. |
| Style coverage | Verify after enrichment, override gaps | Public domain predates `street art` and `pop art`; an override is a reviewable manifest line, not a hidden fudge. |
| Size | ~950 tagged + ~50 untagged | Exceeds the 20-card deck for S-02 refill; the untagged tail keeps S-01's demotion key observable. |
| Manifest → rows | Script generates `seed.sql`; both committed | `seed.sql` stays the single mechanism `db reset` applies, and regeneration is a reviewable SQL diff. |
| Runner | `tsx` devDependency | Plain Node cannot resolve the extensionless imports inside `src/lib/ai/enrich.ts`. |

Two decisions taken without asking, both stated in the plan: the untagged tail (your
"150+" answer didn't cover it, and S-01's outermost sort key is unobservable without one), and
retaining one seeded artist (keeps `db:seed:images` on its existing UUID path).

> **Amended during Phase 1 (2026-09-10):** corpus size raised from ~168 to **1000** at the
> owner's request. The untagged tail scales with it (~50, 5%), or a tail of eight would never
> surface in the newest-20 window a walk actually sees.

## Scope

**In scope:** `scripts/build-corpus.ts` (four stages), `tsx` devDependency, four npm scripts,
`supabase/seed-assets/corpus.json`, a regenerated corpus region in `supabase/seed.sql`, deletion
of the five placeholder PNGs, `.gitignore`, `test/build-corpus.test.ts`, a new `judgment.md` with
a recorded baseline, and updates to `seed-assets/README.md`, `AGENTS.md` and `roadmap.md`.

**Out of scope:** any schema change, migration or type regeneration; any application code
(`swipe_deck`, `getStarterDeck`, the onboarding picker, the upload flow); a second seeding
mechanism; committed image bytes; production or linked-project seeding; automated ranking
assertions; retro-tagging real artworks; a second image source; preserving F-01's baseline as
comparable.

## Architecture / Approach

`supabase/seed-assets/corpus.json` is the source of truth and the unit of review — per piece it
pins the AIC object id, `image_id`, piece UUID, truncated title, artist attribution, final tags,
enrichment description and `created_at` slot. `scripts/build-corpus.ts` runs in four stages over
that one file: `fetch` (network → manifest + gitignored JPEGs), `enrich` (images → manifest,
resumable), `coverage` (manifest → 20/20 style-term report), `generate` (manifest → `seed.sql`
below a do-not-hand-edit marker). Determinism survives AIC changing or a model being retired,
because regeneration reads the manifest, not the network. `seed.sql`'s hand-authored identity
section — which encodes non-re-derivable GoTrue knowledge about empty-string token columns —
stays above the marker, untouched.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Fetch script and manifest | `tsx`, the script, 1000 pinned pieces + local JPEGs | The IIIF 403 returns HTML with a success-shaped pipeline; must assert `content-type` |
| 2. Enrichment top-up | Style, mood and descriptions pinned into the manifest | ~1000 free-tier calls at a 25 s ceiling — non-resumable would mean restarting from zero |
| 3. Coverage and overrides | 20/20 style terms guaranteed; the untagged tail chosen | Overrides becoming a way to hit the number rather than an honest gap record |
| 4. `seed.sql` generation | A generated corpus region; re-derived like history | Slots ordered by tag group would make a broken ranking look correct |
| 5. Judgment and docs | Emergent cheat-sheet, walks, recorded baseline | Leaving the baseline as an unfilled template |

**Prerequisites:** a running local Supabase stack (owner-operated), network access to
`api.artic.edu`, and `OPENROUTER_API_KEY` in `.env.local` for Phase 2 only.
**Estimated effort:** ~2–3 sessions across 5 phases; Phase 2 is mostly unattended wall-clock,
Phase 1 is the bulk of the writing.

## Open Risks & Assumptions

- **Natural sampling gives up the controlled discrimination case.** F-01 deliberately shared `oil`
  between two clusters so ranking had one overlap to discriminate. Emergent groups may separate
  cleanly or overlap messily, and a disappointing walk will be ambiguous between "ranking is weak"
  and "the tag distribution is thin". Recorded as a finding rather than a corpus defect.
- **The F-01 recorded baseline stops being comparable.** Cluster codes cease to exist, so the
  archived measurements become history of the synthetic corpus, not a "before" for anything
  current. Phase 5 annotates rather than rewrites.
- **A handful of style terms will be curatorial, not observed.** `street art`, `pop art`,
  `psychedelic` and likely `brutalist` postdate most CC0 material.
- **AIC's free tier and the free model roster both churn.** The manifest is the mitigation: once
  pinned, neither is needed again.
- Assumes AIC's `classification_titles` and `subject_titles` are consistent enough across
  departments for one synonym table. Phase 1's spot-check exists to catch it early if not.
- Assumes 1000 pieces yields enough tag overlap for ranking to concentrate visibly. If it does
  not, Open Roadmap Question 1 (tag weighting) becomes the next thing to answer.

## Success Criteria (Summary)

- A collector picking any of the 20 onboarding style terms gets a non-empty starter set.
- `/discover` shows recognisable real artwork with real titles, visibly interleaved across tag
  groups rather than grouped.
- A fresh clone plus `db:seed:fetch` and `db:reset` reproduces the corpus identically, and a
  recorded walkthrough exists over the emergent groups.
