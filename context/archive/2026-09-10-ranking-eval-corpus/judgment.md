# Judgment walkthrough — tag-match ordering

F-01 exists so a tag-match ordering can be _judged_ by swiping, not guessed at.
This is the procedure S-01 uses to check whether its ranking beats today's
newest-first deck. Run it once now to record the pre-S-01 baseline, then again
after S-01 ships and compare.

## Setup

1. `npx supabase db reset`
2. Upload the placeholder images (see `../../../supabase/seed-assets/README.md`).
3. Confirm the corpus: 54 artworks, 48 tagged in four clusters of twelve, six
   untagged. Warm collector has eight likes, all Blue abstraction.

Cluster cheat-sheet (identify a card by its image and title, not its tags):

| Cluster          | Image  | Title style                          |
| ---------------- | ------ | ------------------------------------ |
| Blue abstraction | a1.png | "Cobalt Grid", "Azure Partition", …  |
| Warm portraiture | a2.png | "Ochre Portrait…", "Sitter in Amber" |
| Muted landscape  | a3.png | "Grey Estuary Morning", "Fog Over…"  |
| Neon street      | a4.png | "Rain on Sixth Avenue", "Arcade…"    |
| Untagged         | a0.png | "Untitled Study I–VI"                |

## Walk A — warm collector

`seed-collector-warm@artswipe.local` / `seedpassword`

1. Open `/discover`. Do **not** swipe.
2. Record the cluster of each of the first 20 cards, in order, as a column of
   cluster names (B / W / M / N / U).
3. Note where untagged (U) pieces land — this observation feeds Open Question 4
   (where untagged artworks sit in the ordering).

**Pre-S-01 expectation:** the deck is ordered newest-first (`created_at` desc).
`seed.sql` staggers `created_at` in round-robin cluster order, so the 20 cards
should be **interleaved** — roughly one of each cluster repeating — with **no
relationship** to the warm collector's eight Blue abstraction likes. Two untagged
pieces (slots 35 and 42 of 54) fall inside the newest-20 window.

**Post-S-01 expectation:** Blue abstraction pieces are concentrated at the front
of the deck. The four unliked Blue abstraction pieces (`b…09`–`b…0c`) should lead;
`oil`-sharing Warm portraiture / Muted landscape pieces may rank above the other
clusters as a partial match. Liked pieces never reappear (FR-006).

## Walk B — cold collector

`seed-collector-cold@artswipe.local` / `seedpassword`

1. Open `/discover`. Record the first 20 clusters the same way.

**Pre- and post-S-01 expectation:** identical. With no likes there is nothing to
match on, so the cold-start deck should stay newest-first and **not change**
between the two runs. If S-01 alters this deck, that is a cold-start regression.

## Recorded baseline (pre-S-01)

Cluster codes: 1 = Blue abstraction, 2 = Warm portraiture, 3 = Muted landscape,
4 = Neon street, U = untagged.

- **Date / commit:** 2026-09-10, phase 4 of `ranking-eval-corpus`
- **Walk A (warm collector), first ~20 clusters:**
  `4, 2, 4, 2, 4, 2, U, 3, 1, 3, 2, 3, U, 3, 4, U, 4, 2`
- **Walk A, untagged positions:** 7, 13, 16 — sprinkled through the mid-deck,
  neither at the front nor absent. This is the pre-S-01 answer to Open Question 4:
  untagged pieces currently sit wherever their `created_at` puts them, with no
  deliberate placement.
- **Walk B (cold collector), first ~20 clusters:** effectively identical to
  Walk A — same newest-first deck, minus nothing meaningful (the warm collector's
  8 likes only remove 8 Blue abstraction pieces from a 54-piece corpus).
- **Interleaved, unrelated to likes? (Y/N):** **Y.** The warm collector's eight
  likes are _all_ Blue abstraction (cluster 1), yet cluster 1 appears only once in
  the first ~18 cards. Clusters are shuffled together with no run longer than an
  adjacent pair. Today's deck does no tag-match ranking — this is the "before"
  state S-01 must visibly improve on (Blue abstraction concentrated at the front).
