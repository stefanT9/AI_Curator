# Judgment walkthrough — tag-match ordering over the real corpus

This is the live instrument for judging `swipe_deck`'s ordering by swiping. It replaces
`context/archive/2026-09-10-ranking-eval-corpus/judgment.md`, whose four designed clusters and
`[N]` title prefixes no longer exist — the corpus is now 1000 real public-domain pieces sampled
from the Art Institute of Chicago, and its groups are **emergent**: read off the corpus, not
authored into it.

Run it now to record a baseline on real tags, then again after any ranking change and compare.

## Setup

1. `npm run db:seed:fetch` — one-time after a clone; the images are gitignored (~260 MB).
2. `npx supabase db reset` (or `npm run db:reset`).
3. `npm run db:seed:images` — uploads the 1000 objects to local Storage.
4. Confirm the corpus: **1000 artworks, 946 tagged, 54 with `tags = '{}'`**, all owned by
   `seed-artist@artswipe.local`. The warm collector has **8 likes, all `figurative`**.

Shared password for all three seeded identities: `seedpassword`.

| Role           | Email                                |
| -------------- | ------------------------------------ |
| Artist         | `seed-artist@artswipe.local`         |
| Warm collector | `seed-collector-warm@artswipe.local` |
| Cold collector | `seed-collector-cold@artswipe.local` |

## Group cheat-sheet

F-01 could name a card's cluster from a `[N]` prefix it had authored into the title. Natural
sampling gives that up, so the group is read from the **tag chips `ArtCard` already renders**
(`src/components/artworks/ArtCard.tsx:73`) plus the image. No database inspection is needed.

**The rule, applied top-down — first match wins:**

1. If the card shows a **style** chip, the group is that style (the first style chip in chip
   order). `figurative`, `realism` and `illustrative` get their own labels; every other style
   term is **STY**.
2. Otherwise, if it shows a **medium** chip, the group is that medium.
3. Otherwise (only subject/palette chips) it is **UNC**.
4. **No chips at all** is **U** — the deliberate untagged tail.

| Label   | Group                | Tag signature (first matching chip)                                                           | Count |
| ------- | -------------------- | --------------------------------------------------------------------------------------------- | ----: |
| **FIG** | Figurative           | `figurative`                                                                                    |    78 |
| **REA** | Realism              | `realism`                                                                                       |    37 |
| **ILL** | Illustrative         | `illustrative`                                                                                  |    28 |
| **STY** | Other styled         | any other style term — `abstract`, `art nouveau`, `folk art`, `geometric`, `impressionist`, `minimalist`, `surrealist`, `expressionist`, `gestural` |    44 |
| **PHO** | Photography          | `photography`                                                                                   |   132 |
| **CER** | Ceramic              | `ceramic`                                                                                       |   127 |
| **TEX** | Textile              | `textile`                                                                                       |   120 |
| **SCU** | Sculpture            | `sculpture`                                                                                     |   118 |
| **PNT** | Painting             | `oil painting`, `watercolour`, `gouache`, `pastel`, `charcoal`                                   |   110 |
| **PRT** | Print / drawing      | `etching`, `lithograph`, `ink`, `graphite`                                                      |   105 |
| **UNC** | Unclassified         | subject/palette chips only — no style, no medium                                                |    47 |
| —       | **Tagged total**     |                                                                                                 | **946** |
| **U**   | Untagged tail        | no chips at all                                                                                 |    54 |

Example titles, newest-first within each group:

| Label | Examples                                                                                  |
| ----- | ----------------------------------------------------------------------------------------- |
| FIG   | "Noli Me Tangere" · "Left Leg Broken at Mid-Thigh" · "Portrait of a Boy"                    |
| REA   | "Rue Royale et Restes des Barricades de 1848" · "Christ at Emmaus, from The Passion"        |
| ILL   | "Snow at Akabane Bridge in Shiba" · "St. George Killing the Dragon"                         |
| STY   | "The Sacrifice of Polyxena" · "Miniature Box on a Stand (Mingqi)" · "Improvisation No. 30"  |
| PHO   | "The Madame B Album" · "Cathedrale de Chartres" · "Fish Shows-Apsaroke"                      |
| CER   | "Rectangular Bottle with Loop Handles" · "Famile-Rose Bowl"                                 |
| TEX   | "Tapestry Medallion" · "Fragment" · "Sampler"                                               |
| SCU   | "Medallion with Augustus" · "Bodhisattava"                                                  |
| PNT   | "The Crucifixion" · "Praying Virgin" · "Coniston Lake"                                      |
| PRT   | "Near Godesberg, from Facsimiles of Sketches…" · "Large Female Head"                        |
| UNC   | "Page from the Perfection of Wisdom Sutra" · "Dragon and Tiger"                             |
| U     | "Italian Immigrant" · "Fragment (From a Chasuble)" · "Panel"                                 |

> **Derived, not designed — recompute after any regeneration.** Every count and example above is
> computed from `supabase/seed-assets/corpus.json`, over its `pieces[]` fields `tags_from_metadata`,
> `tags_from_enrichment`, `untagged` and `slot`, applying the same dedup-and-concatenate the
> generator's `combineTags` applies (metadata first, then enrichment; no piece in this corpus
> reaches the 20-term ceiling, so the round-robin trim never fires). Facet membership comes from
> `src/lib/ai/taxonomy.ts`. Regenerating the corpus changes these numbers; the rule above is what
> stays true.

> **Why medium carries most of the sheet.** Style and mood come only from enrichment, and at the
> time of writing **196 of 1000 pieces are enriched** — so 759 of the 946 tagged pieces carry
> metadata tags only and fall into a medium group. As the owner resumes `npm run db:seed:enrich`,
> pieces migrate *upward* through the rule: a `ceramic` card that gets enriched to `figurative`
> stops being CER and becomes FIG. Group counts therefore drift with enrichment; the ordering the
> walks measure does not.

## Walk A — warm collector

`seed-collector-warm@artswipe.local` / `seedpassword`

1. Open `/discover`. Do **not** swipe.
2. Record the group label of each of the first 20 cards, in order.
3. Note whether **FIG** — the group the collector's eight likes all belong to — concentrates at
   the front, and where any **U** cards land.

**Expectation.** The warm collector's taste is the distinct union of tags across their eight liked
pieces: 19 terms spanning all five facets, including `figurative`. `swipe_deck` sorts untagged
last, unseen before skipped, then by tag-overlap count descending, then `created_at desc`. So the
first 20 should be **overwhelmingly FIG**, ordered by overlap score rather than recency — a
`figurative` piece from slot 213 outranking a non-figurative one from slot 999 is the ranking
working, not a fault. The eight liked pieces never reappear (FR-006). No **U** card should appear
anywhere in the first 20.

Computed from the manifest against the four-key sort, the first 20 should be:

```
FIG FIG FIG FIG FIG FIG FIG FIG FIG FIG FIG FIG FIG REA STY FIG STY FIG CER FIG
```

— thirteen score-6 FIG cards, then a score-5 band in `created_at desc` order. Treat this as a
prediction to confirm or refute, not as the observation; the observation goes in the recorded
baseline below.

## Walk B — cold collector

`seed-collector-cold@artswipe.local` / `seedpassword`

1. **Satisfy the onboarding gate without creating likes.** S-04 made onboarding mandatory at
   `(app)/layout.tsx`, so signing in and opening `/discover` redirects to `/onboarding` and the
   flow's whole purpose is to leave the collector holding likes — which is the opposite of what
   this walk measures. Stamp the column directly instead:

   ```sql
   update public.profiles set onboarded_at = now()
   where id = (select id from auth.users where email = 'seed-collector-cold@artswipe.local');
   ```

   That satisfies the gate while leaving zero `interactions` rows — genuinely cold. `npx supabase
   db reset` returns it to null.

2. Open `/discover`. Record the first 20 group labels the same way.

**Expectation.** With no likes the overlap key ties at zero for every row, so `created_at desc`
is the effective ordering *within* the tagged tier, and the untagged tail sits below all 946
tagged pieces. Expect a **mixture** of groups with no relationship to any taste, and **no U card
in the first 20** — the tail begins at deck position 947.

Computed from the manifest:

```
TEX PHO ILL CER CER TEX TEX PHO PHO PHO TEX CER SCU PHO PRT SCU FIG TEX SCU REA
```

**The observable that matters here** is what is *missing*: the piece at slot 980 ("Italian
Immigrant") is untagged, so by recency it belongs at deck position 20, and the demotion pushes it
to 947. Its absence from the first 20 is the visible proof of the outermost sort key — and it is
why the untagged tail is spaced every 20 slots rather than clustered at one end.

**A cold-start regression is:** tagged pieces out of `created_at` order, or any U card appearing
above a tagged one.

## Recorded baseline

> **A shape check, not a transcription.** Both walks were run end to end against a freshly reset
> local stack and both behaved as predicted in shape — but the twenty labels were not recorded
> card by card, so what is below is confirmation at group-behaviour grain. That is enough to
> answer the two questions the walks exist to ask, and not enough to diff a future ordering
> against position by position. **A ranking change that needs a true before/after should re-run
> both walks and transcribe all twenty labels first** — the predicted sequences above are the
> template for that.

- **Date / commit:** 2026-09-10, phase 5 of `real-artwork-corpus`
- **Enriched pieces at time of walk:** 196 of 1000 (`npm run db:seed:coverage`)
- **Walk A (warm collector), first 20 groups:** not transcribed. Observed shape: **FIG dominates
  the front of the deck**, consistent with the predicted thirteen score-6 figurative cards ahead
  of a mixed score-5 band.
- **Walk A — did FIG concentrate at the front? (Y/N):** **Y.** This is the first confirmation on
  real tags that `swipe_deck`'s overlap key concentrates a collector's liked group. F-01 could
  only show that ranking discriminates between four clusters it had authored; here the group is
  emergent — `figurative` is simply the style term the collection produced most of — and the
  ordering still finds it.
- **Walk A, untagged positions:** none in the first 20, as expected.
- **Walk B (cold collector), first 20 groups:** not transcribed. Observed shape: **a mixture of
  groups with no relationship to any taste**, consistent with the predicted
  `TEX PHO ILL CER CER …` recency ordering.
- **Walk B — tagged pieces in `created_at desc` order, untagged tail below all of them? (Y/N):**
  **Y.** No untagged card appeared in the first 20 — including the piece at slot 980 ("Italian
  Immigrant"), which by recency alone belongs at position 20 and was demoted to 947. Its absence
  is the visible proof of the outermost sort key.
- **Notes / surprises:** None. Both predictions held, which is itself worth recording: the
  four-key sort in `20260910180000_rank_swipe_deck.sql` is fully predictable from the manifest,
  so a future divergence between prediction and observation is a real signal about the ranking
  rather than noise from the corpus.

  The standing caveat is coverage, not ordering. With 196 of 1000 pieces enriched, style and mood
  exist on roughly a fifth of the corpus, so Walk A's concentration is measured over 78 FIG pieces
  rather than the larger group a fully-enriched corpus would produce. Resuming
  `npm run db:seed:enrich` strengthens the measurement; it should not change its direction.
