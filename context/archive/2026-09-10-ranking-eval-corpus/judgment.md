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

| Cluster          | Code | Image  | Title style                               |
| ---------------- | ---- | ------ | ----------------------------------------- |
| Blue abstraction | 1    | a1.png | "[1] Cobalt Grid", "[1] Azure Partition"  |
| Warm portraiture | 2    | a2.png | "[2] Ochre Portrait…", "[2] Sitter in…"   |
| Muted landscape  | 3    | a3.png | "[3] Grey Estuary Morning", "[3] Fog…"    |
| Neon street      | 4    | a4.png | "[4] Rain on Sixth Avenue", "[4] Arcade…" |
| Untagged         | U    | a0.png | "[U] Untitled Study I–VI"                 |

> **Amended 2026-09-10 by `personalized-deck-ranking` (S-01).** `seed.sql` titles
> originally carried no prefix, which made a walk a matter of telling four
> near-identical placeholder images apart. Each title now leads with its cluster
> code, so a card states its own code and the walk is a transcription rather than
> a judgment call. Recording is unaffected — the codes are the same.

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

**Pre-S-01 expectation:** identical to Walk A. With no likes there is nothing to
match on, so the cold-start deck stays newest-first.

> **Amended 2026-09-10 by `personalized-deck-ranking` (S-01).** This expectation
> originally read "identical pre- and post-S-01 … if S-01 alters this deck, that is
> a cold-start regression." S-01 demotes untagged artworks below every tagged piece
> by design, which changes the cold-start deck, so the original expectation would
> read correct behavior as a regression.
>
> **Post-S-01 expectation:** tagged pieces **newest-first**, with the **untagged
> tail** below all of them. A collector with no likes scores zero against every
> piece, so the tag-overlap key ties everywhere and `created_at desc` remains the
> effective ordering _within_ the tagged tier. Untagged pieces no longer appear
> mid-deck (baseline slots 7, 13, 16) — that is the intended change, not a
> regression. A cold-start regression is now: tagged pieces out of `created_at`
> order, or an untagged piece appearing above a tagged one.
>
> The recorded baseline measurements below are untouched — only this
> forward-looking expectation changed.

> **Annotated 2026-09-10 by `add-onboarding-flow-for-collector` (S-04). Nothing above
> is retracted.** Both expectations recorded for Walk B held for S-01 and remain the
> correct check for that slice — re-run this walk against S-01 and judge it by the
> post-S-01 expectation exactly as written.
>
> What changed is the walk's _premise_, not its expectation. Walk B exists to observe a
> collector who has no likes. S-04 makes onboarding mandatory at
> `(app)/layout.tsx`, so `seed-collector-cold@artswipe.local` now reaches `/discover`
> only _after_ the first-run flow, and the flow's whole purpose is to leave it holding
> likes. Signing in and opening `/discover` therefore no longer produces a cold deck —
> it redirects to `/onboarding`, and whatever deck follows is warm.
>
> **The fixture is still reachable pre-onboarding.** The gate reads
> `profiles.onboarded_at`, and the flow is the only thing that writes it. To run Walk B
> as specified, stamp the column directly and rate nothing:
>
> ```sql
> update public.profiles set onboarded_at = now()
> where id = (select id from auth.users where email = 'seed-collector-cold@artswipe.local');
> ```
>
> That satisfies the gate while leaving the collector with zero `interactions` rows —
> genuinely cold, which is what this walk measures. `npx supabase db reset` returns it
> to null. Note that S-04 also gives cold-start a second, in-product route: a collector
> who completes onboarding but skips every starter piece is released with zero likes and
> lands on this same deck. If you would rather observe that path, walk it instead of
> stamping — the expected ordering is identical.

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
