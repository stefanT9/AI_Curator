# Ranking Evaluation Corpus — Plan Brief

> Full plan: `context/changes/ranking-eval-corpus/plan.md`
> Roadmap item: `context/foundation/roadmap.md` § Foundations → F-01
> PRD: `context/foundation/prd-v2.md`

## What & Why

Seed the local database with a deliberately-clustered set of tagged artworks, three fixed
identities, and a like history — so the tag-match ordering built in S-01 can be **judged** rather
than guessed at. The roadmap put this first because a bad ranking fails silently: it still returns
cards. With one developer account and no tag backfill for pre-enrichment artworks, there is
currently nothing to tell a good ordering from a broken one.

## Starting Point

`supabase/config.toml:85-89` already enables a seed hook pointing at `./seed.sql` — and that file
has never existed. There is no seed data, no fixtures, and no `scripts/` directory anywhere in the
repo. The deck query works and the tag column is populated for new uploads, but the catalogue is
whatever the owner has manually uploaded.

## Desired End State

After a reset and one upload command, you log in as a seeded "warm" collector who already has
eight likes in one tag cluster, and swipe a deck drawn from 54 artworks spanning four visually
distinct clusters plus six untagged pieces. A second "cold" collector gives you the zero-likes
state on the same catalogue. Both reproduce identically after every reset, because every id is a
hardcoded UUID.

## Key Decisions Made

| Decision          | Choice                                       | Why (1 sentence)                                                                                   | Source  |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------- |
| Judgment mode     | Human swipe-through, no automated assertion  | There is no ranking contract to assert against until S-01 ships.                                   | Plan    |
| Seeding mechanism | `supabase/seed.sql`                          | The config hook already exists, runs as superuser so RLS is moot, and needs no service-role key.   | Plan    |
| Identity creation | Raw `auth.users` + `auth.identities` inserts | Profiles have no insert policy — they only arrive via the existing `on_auth_user_created` trigger. | Plan    |
| Identity count    | Three (1 artist, 2 collectors)               | `swipe_deck` hides your own work, so the corpus owner cannot also be the judge.                    | Plan    |
| Corpus shape      | 4 clusters × 12, plus 6 untagged             | Exceeds the 20-card deck so refill is exercised; untagged pieces make Open Question 4 observable.  | Plan    |
| Cluster overlap   | `oil` shared by two clusters                 | Gives the ordering one discrimination case, not just four cleanly separated islands.               | Plan    |
| Images            | One placeholder per cluster                  | Makes judging a glance instead of a per-card tag read.                                             | Plan    |
| Like history      | Warm collector seeded, cold collector empty  | Both the ranked and cold-start paths become observable without any clicking.                       | Plan    |
| Scope guard       | Corpus, not a fixtures framework             | Named directly in F-01's Risk line as the failure mode to watch.                                   | Roadmap |

## Scope

**In scope:** `supabase/seed.sql` (identities, 54 artworks, 8 likes); five committed placeholder
PNGs; a seed-workflow README; an `AGENTS.md` note; a judgment walkthrough recording the pre-S-01
baseline.

**Out of scope:** any schema change or migration; type regeneration (`db:types:local` is banned in
this repo); automated ordering assertions or a `.live.ts` lane; production or linked-project
seeding; generated SQL; any application code, including the deck query and upload flow.

## Architecture / Approach

One new SQL file plus one asset directory — no new tooling and no new dependency. `seed.sql` is
applied automatically at the end of `supabase db reset`, after all migrations, running as superuser
so RLS never enters the picture. Storage is the one thing SQL cannot reach, so the five placeholder
images go up through the already-pinned CLI devDependency: `npx supabase storage cp --local -r`
using the `ss:///bucket/path` scheme. Determinism comes from hardcoded UUIDs and
`on conflict do nothing` on every insert, making the file safe under both reset and manual re-run.

## Phases at a Glance

| Phase                              | What it delivers                              | Key risk                                                                     |
| ---------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| 1. Seeded identities               | Three logins that work                        | `auth.identities` is easy to omit — a user row alone cannot sign in          |
| 2. Cluster placeholder images      | Five PNGs in the bucket                       | Upload must be re-run after every reset; easy to mistake for one-time setup  |
| 3. Artwork corpus and like history | 54 artworks, 8 likes                          | Clusters contiguous by `created_at` would make a broken ranking look correct |
| 4. Docs and judgment walkthrough   | Reproducible workflow and a recorded baseline | Skipping the baseline leaves nothing to compare S-01 against                 |

**Prerequisites:** a running local Supabase stack (owner-operated), and the pinned CLI
devDependency (already installed).
**Estimated effort:** ~1–2 sessions across 4 phases; Phase 3 is the bulk of the writing.

## Open Risks & Assumptions

- Assumes the local GoTrue version resolves password login through `auth.identities` on
  `provider = 'email'`. Phase 1's login checkpoint exists to catch this early if the shape differs.
- Assumes `supabase db reset` clears Storage objects. If it turns out to preserve them, the Phase 4
  documentation is stricter than necessary — harmless, but worth correcting.
- The corpus is designed, not sampled from real data. It can only show whether ranking
  _discriminates between clusters_, not whether the tag vocabulary matches real artwork.
- Seeded users share one weak password. Acceptable local-only; the file must never touch a linked
  project, which the file-top comment and README both state.

## Success Criteria (Summary)

- Logging in as the warm collector shows a 20-card deck and exactly eight liked pieces; the cold
  collector shows the same catalogue with none.
- A clean `supabase db reset` plus the upload command reproduces the corpus identically, with
  images rendering rather than 404ing.
- A pre-S-01 baseline is recorded showing clusters interleaved and unrelated to the warm
  collector's likes — the thing S-01 will be judged against.
