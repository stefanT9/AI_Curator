# ArtSwipe — Project Plan

> **Status: reconciled 2026-09-13 with what actually shipped.** This began as a
> pre-build planning document and is kept true rather than frozen — the sections
> below describe the product that exists. Where the build diverged from the
> original intent, the **decision log** at the bottom records why; it is
> append-only, and the four founding entries are untouched. For how the work was
> done, see [`docs/delivery-story.md`](docs/delivery-story.md); to run it, see
> [`README.md`](README.md).

## One-sentence pitch

Users swipe through artwork, the AI learns their taste and recommends pieces and artists they'd enjoy — a discovery engine for art buyers.

## Problem

Art discovery is fragmented across Instagram, gallery websites, and marketplaces. People who enjoy art but aren't plugged into the art world have no simple way to explore, develop their taste, and find artists whose style resonates with them.

## Target user

Art buyer or casual collector who wants to discover new work without needing gallery connections or deep art-world knowledge. A second role arrived with Layer 2: the **artist**, who uploads and manages their own catalogue and can put a piece up for auction. Any collector can become an artist from their account page.

## Core flow

1. User creates an account and logs in
2. **Onboarding**: the collector picks two to four style terms and likes five pieces from a starter deck drawn from them — so the first real deck is already ranked rather than falling back to newest-first
3. User likes or skips each piece (drag, buttons, or arrow keys)
4. The taste profile is the distinct union of tags across everything the collector has liked; skips are a demotion signal and never taste input
5. `/discover` orders the deck by tag overlap against that profile, recomputed per request
6. User can browse their liked pieces, open an artwork or artist page, and browse open auctions

## Business logic

Two real domain decisions happen on demand, neither of them a stored record:

- **Deck ranking.** `swipe_deck` (`supabase/migrations/20260910180000_rank_swipe_deck.sql`) sorts on four keys — tagged before untagged, unseen before skipped, tag overlap descending, `created_at` descending — against a taste set computed inline from the collector's own likes. It runs in SQL, under RLS, as the signed-in user.
- **Auction resolution.** `close_due_auctions` (`supabase/migrations/20260912120000_add_auction_close.sql`) runs under `pg_cron`, picks the highest sealed bid at the stated end time with the earliest bid breaking a tie, and records the outcome once, durably, on the auction row.

Feeding both: on upload, a vision model classifies each piece into a controlled tag vocabulary. Enrichment is optional and never blocks a mutation — `enrichFromImage` never throws, and the publish-time top-up runs in `after()`, once the user's own data is already written.

## Tech stack

- **Framework**: Next.js 16 (App Router) with TypeScript strict. Request interception lives in `src/proxy.ts` — this version's name for middleware.
- **Styling**: Tailwind CSS v4
- **Database**: Supabase (PostgreSQL + Auth + Storage). **RLS is the security boundary**; ownership filters in queries are for correctness and index selectivity, never for access control.
- **Image storage**: Supabase Storage. Images upload from the browser straight to the bucket; only the object key travels through a Server Action, which is capped at 1 MB.
- **Vision API**: OpenRouter free vision tier via the Vercel AI SDK, behind `src/lib/ai/`
- **Email**: Resend, behind `src/lib/email/` — one send path, one append-only ledger
- **Scheduled work**: `pg_cron` inside Postgres, not a platform cron
- **Validation**: Zod at every external boundary
- **Deployment**: Vercel, with migrations auto-deployed from `main`

## Data model

### Artwork

- id, artist_id, title, description, image_path
- tags — a single `text[]` mixing artist-typed free text and AI-generated controlled-vocabulary terms, by design
- created_at

There is **no embedding column**. Similarity is tag overlap computed in SQL; see the decision log.

### User / Profile

- Identity and credentials managed by Supabase Auth
- `profiles` carries display name, artist status, `onboarded_at`, and the auction-notification preference

### Interaction

- id, user_id, artwork_id
- action: "like" | "skip"
- created_at
- Unique on (user_id, artwork_id)

### Auction and Bid

- `auctions`: artwork_id, seller_id, starting_price_cents, ends_at, closed_at, winning bid
- `bids`: auction_id, bidder_id, amount_cents — **sealed**: RLS returns only your own, to everyone including the seller
- Locked once a bid exists; correctness under concurrency comes from a row lock and a unique constraint, not from the Server Action

### Email

- `email_sends`: append-only delivery ledger. RLS enabled with **no policies at all** — the absence is the access control
- `email_outbox`: rows written by an `after update of closed_at` trigger and drained over `/api/email/drain`. Same policy absence, and it matters more: every row holds a plaintext address

Taste is **not** a stored profile. It is derived per query from interaction history, which is what keeps it always current and free of a sync path.

## Seed catalog

1000 public-domain artworks from the Art Institute of Chicago, tagged from museum metadata plus the real enrichment pipeline, generated into `supabase/seed.sql` from the committed manifest at `supabase/seed-assets/corpus.json`. Local development only.

The original plan said artist uploads were out of scope for the MVP. They shipped in Layer 2, so the catalogue is now both: a seeded corpus for evaluation and demo, and whatever artists upload.

## Layered delivery

### Layer 1 — MVP ✅ delivered

- User registration and login (auth)
- Pre-seeded art catalog with AI-generated metadata
- Browse/swipe interface: like or skip
- Taste profile built from interaction history
- AI-powered recommendation feed
- One E2E test covering the core flow
- CI/CD pipeline: build + lint + tests

### Layer 2 — Social and artist side — substantially delivered

- ✅ Artist accounts with upload and portfolio management (the studio)
- ✅ Artist profile pages
- ❌ Follow artists — not built
- ❌ Comments or reactions on pieces — not built
- ❌ Search and filter by style, medium, mood — not built; ranking supplanted the need for the MVP

### Layer 3 — Marketplace signals — substantially delivered, and reversed in scope

The original plan drew a hard boundary here. It was moved deliberately after the recommendation engine worked: discovery with nothing to _do_ at the end of it is a demo, not a product.

- ✅ A full auction mechanism: listing, sealed bids, a timed `pg_cron` close, deterministic winner selection
- ✅ Contact exchange at close — the winner and the seller get each other's details
- ✅ Targeted notification: everyone who liked a piece hears when it goes to auction, with a one-click unsubscribe that needs no session
- ❌ Price range filtering, artist analytics — not built
- ❌ Taste-matched auction targeting (notify collectors whose taste matches, whether or not they saw the piece) — specified, not built

## Certification requirements mapping (10xDevs 4.0)

| Requirement                    | How it's met                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access control                 | Supabase Auth for credentials; `src/proxy.ts` for session refresh and route gating; RLS policies on every table as the actual boundary. Proven against a real stack by `npm run test:integration`           |
| Data management (CRUD)         | Artworks (create, edit, delete via the artist studio), interactions, auctions, bids, profiles and notification preferences — every mutation through a Zod-validated Server Action in `src/app/actions/`     |
| Business logic                 | Per-collector deck ranking in `swipe_deck`, and deterministic auction resolution in `close_due_auctions` — both computed on demand in SQL, plus vision-model enrichment on upload                           |
| Project artifacts (PRD, specs) | This document, three PRD generations and three roadmaps in `context/foundation/`, a risk-ranked test plan, and 14 archived changes in `context/archive/` each carrying research, a plan and a review        |
| User-perspective test          | `test/e2e/taste-loop.spec.ts` — a real browser signs a collector up, walks onboarding, likes five pieces, and asserts the next deck is ordered by tag overlap with them. Nothing mocked. `npm run test:e2e` |
| CI/CD pipeline                 | `.github/workflows/verify.yml` runs format → lint → typecheck → test → build on every PR and push to `main`; `.github/workflows/migrations.yml` auto-deploys migrations; Vercel deploys the app             |

## Key risks and mitigations

| Risk                                   | Mitigation                                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image storage/serving complexity       | Use managed storage (Supabase Storage, Cloudinary) — don't self-host                                                                                                                                                        |
| Recommendation quality with small data | Content-based filtering works with a single user; no cold-start problem. In practice onboarding was still needed — a collector with zero likes ranks against nothing                                                        |
| Seed catalog sourcing                  | WikiArt open dataset or manually curate ~50 images — enough for MVP. Delivered instead as 1000 pieces from the Art Institute of Chicago                                                                                     |
| Scope creep into social/marketplace    | Hard boundary: no social features, no payments in Layer 1. **Reversed for the marketplace half** — the auction mechanism shipped deliberately; no payments were ever taken, and contact exchange is where the product stops |
| Vision API costs                       | Classify on ingest only (once per image), not on every request. The free tier's **latency**, not its cost, is what has since become the problem                                                                             |

## Recommendation approach

Content-based, computed in SQL:

1. Each artwork carries tags — from museum metadata, the vision model on ingest, or the artist
2. The collector's taste is the distinct union of tags across the artworks they have liked
3. Unrated artworks are scored by how many of their tags fall in that set
4. The deck is that score, descending, behind two coarser keys (tagged first, unseen before skipped)

The original plan called for embeddings and cosine similarity. Tag overlap over the enriched controlled vocabulary discriminates well enough on this corpus, is explainable, needs no `pgvector`, and can be read straight out of psql — which is what made it judgeable against a recorded baseline. Collaborative filtering remains out of scope.

## Project structure

```
artswipe/
├── src/
│   ├── app/
│   │   ├── (app)/            # authenticated: discover, liked, studio, auctions, artwork, artist, account
│   │   ├── (auth)/           # login, signup — signed-out only
│   │   ├── (onboarding)/     # style picker + starter deck, one route, two states
│   │   ├── actions/          # Server Actions by domain; every mutation goes through one
│   │   ├── api/email/drain/  # the pg_cron → Node bridge
│   │   ├── auth/             # confirm route, error page
│   │   ├── unsubscribe/      # public, session-free
│   │   └── page.tsx          # landing
│   ├── components/           # artworks, auctions, auth, account, onboarding, ui
│   ├── lib/                  # ai, artworks, auctions, auth, email, notifications, onboarding
│   ├── types/                # database.ts (GENERATED), domain.ts (hand-written)
│   ├── utils/supabase/       # client / server / proxy factories
│   └── proxy.ts              # Next 16's name for middleware
├── supabase/
│   ├── migrations/           # 28 migrations, applied in timestamp order
│   ├── seed-assets/          # corpus manifest + build pipeline
│   └── seed.sql              # local ranking-evaluation corpus
├── test/
│   ├── *.test.ts             # default lane (mocked)
│   ├── integration/          # real Supabase boundary
│   ├── smoke/                # real external providers
│   ├── e2e/                  # one browser test, Risk #7
│   └── screenshots/          # README capture — not a test lane
├── context/                  # the /10x-* workflow: foundation, changes, archive
├── docs/delivery-story.md    # how it was built
├── PROJECT_PLAN.md           # this file
└── ...config files
```

## Decision log

| Date       | Decision                                                          | Rationale                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-09 | Chose art discovery/recommendation as project                     | Clear business logic, single-user MVP works, avoids empty CRUD                                                                                                                                                               |
| 2026-09-09 | MVP scoped to browse + like/skip + recommendations                | Shortest path to first working flow; social and marketplace deferred                                                                                                                                                         |
| 2026-09-09 | Pre-seeded catalog instead of artist uploads for MVP              | Removes an entire user role and upload flow from the critical path                                                                                                                                                           |
| 2026-09-09 | Content-based filtering over collaborative                        | Works with one user, no cold-start, simpler to implement and test                                                                                                                                                            |
| 2026-09-10 | Artist uploads added after all, reversing the row above           | Enrichment needs something to enrich that is not seed data, and an artist role is what makes the auction mechanism mean anything later                                                                                       |
| 2026-09-10 | Embeddings dropped; ranking is tag overlap in SQL                 | Explainable, needs no `pgvector`, readable straight from psql — which is what let S-01 be judged against a recorded pre-change baseline rather than guessed                                                                  |
| 2026-09-10 | Mandatory onboarding before the first deck                        | A collector with zero likes ranks against nothing and sees `created_at desc` — to a first-time viewer that fallback _is_ the product                                                                                         |
| 2026-09-10 | A real-boundary test lane against a live local stack              | "Does a published artwork lose its image?" is a question about what Storage does, and no amount of mocking can answer it. It immediately found a silent no-op delete                                                         |
| 2026-09-10 | Corpus replaced with 1000 real public-domain pieces               | A designed 54-piece corpus can show that ranking discriminates between clusters, never that the tag vocabulary matches real artwork                                                                                          |
| 2026-09-11 | Marketplace boundary reversed — the auction mechanism is in scope | Discovery that ends with nowhere to go is a demo. Contact exchange, not payments, is where the product stops                                                                                                                 |
| 2026-09-12 | `pg_cron` for the timed close, not a platform cron                | Vercel's Hobby plan fires once a day anywhere inside its hour, which cannot satisfy "closes close enough to its stated end time"                                                                                             |
| 2026-09-12 | One outbound-email path with an append-only ledger, built first   | Three slices needed it; building the choke point before them is what stops three callers inventing three of their own                                                                                                        |
| 2026-09-12 | An outbox bridge, because Postgres cannot call Node               | The close happens inside the database where no app code runs. A trigger writes rows, a job POSTs the drain                                                                                                                   |
| 2026-09-13 | The drain's trigger token and RPC secret split into two values    | `pg_net` persists its request into a table whose ACL grants `PUBLIC` everything and that this project cannot revoke, so anything in that header is public                                                                    |
| 2026-09-13 | E2E coverage reinstated after being deliberately excluded         | `test-plan.md` had recorded browser coverage as not planned. Risk #7 spans auth, the proxy, RLS, the RPC and the rendered deck at once — no other lane does, and it was the one certification criterion nothing demonstrated |
| 2026-09-13 | AI enrichment left broken rather than patched in a docs change    | The free vision roster regressed to 26–70s against a 25s budget. The fix is a budget-per-caller decision with test implications — `context/changes/ai-enrichment-budget/`                                                    |
