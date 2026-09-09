# ArtSwipe — Project Plan

## One-sentence pitch

Users swipe through artwork, the AI learns their taste and recommends pieces and artists they'd enjoy — a discovery engine for art buyers.

## Problem

Art discovery is fragmented across Instagram, gallery websites, and marketplaces. People who enjoy art but aren't plugged into the art world have no simple way to explore, develop their taste, and find artists whose style resonates with them.

## Target user

Art buyer or casual collector who wants to discover new work without needing gallery connections or deep art-world knowledge.

## Core flow (MVP)

1. User creates an account and logs in
2. User is presented with artwork from a pre-seeded catalog
3. User likes or skips each piece (swipe or button interaction)
4. System builds a taste profile from interaction history
5. AI-powered recommendations improve as the user engages
6. User can browse their liked pieces and recommended artists

## Business logic

On artwork ingest, a vision model classifies each piece by style, mood, palette, medium, and subject. User interactions (likes/skips) build a preference vector. The recommendation engine computes similarity between the user's preference vector and unrated artworks to surface the most relevant pieces. This is a real domain decision happening on every recommendation — not static records in a database.

## Tech stack

- **Framework**: Next.js (App Router) with TypeScript
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL + auth + storage)
- **Image storage**: Supabase Storage or S3-compatible service
- **Vision API**: OpenAI Vision or Claude for artwork classification on ingest
- **Recommendation engine**: Content-based filtering using AI-generated tags and cosine similarity

## Data model (initial)

### Artwork

- id, title, artist_name, image_url
- AI-generated metadata: style, mood, palette, medium, subject, tags
- embedding vector (for similarity computation)
- created_at

### User

- id, email, created_at
- Managed by Supabase Auth

### Interaction

- id, user_id, artwork_id
- action: "like" | "skip"
- created_at

### Taste Profile

- user_id
- aggregated preference vector (computed from interactions)
- updated_at

## Seed catalog

MVP does not require artist uploads. The catalog is pre-seeded with ~50–100 images sourced from open datasets (WikiArt or manually curated). Each image is classified by the vision model on ingest to generate structured metadata and tags.

## Layered delivery

### Layer 1 — MVP (target: week 1)

- User registration and login (auth)
- Pre-seeded art catalog with AI-generated metadata
- Browse/swipe interface: like or skip
- Taste profile built from interaction history
- AI-powered recommendation feed
- One E2E test covering the core flow
- CI/CD pipeline: build + lint + tests

### Layer 2 — Social and artist side

- Artist accounts with upload and portfolio management
- Artist profile pages
- Follow artists
- Comments or reactions on pieces
- Search and filter by style, medium, mood

### Layer 3 — Marketplace signals

- Purchase intent / inquiry flow ("I'm interested in this piece")
- Auction or price history
- Price range filtering
- Artist analytics dashboard

## Certification requirements mapping (10xDevs 4.0)

| Requirement                    | How it's met                                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| Access control                 | Supabase Auth — user registration and login                                |
| Data management (CRUD)         | Artworks, interactions, taste profiles — domain-native data                |
| Business logic                 | AI classification on ingest + recommendation engine                        |
| Project artifacts (PRD, specs) | This document + PRD from module 1                                          |
| User-perspective test          | "User likes 5 pieces, 6th recommendation matches demonstrated preferences" |
| CI/CD pipeline                 | GitHub Actions: build → lint → test                                        |

## Key risks and mitigations

| Risk                                   | Mitigation                                                              |
| -------------------------------------- | ----------------------------------------------------------------------- |
| Image storage/serving complexity       | Use managed storage (Supabase Storage, Cloudinary) — don't self-host    |
| Recommendation quality with small data | Content-based filtering works with a single user; no cold-start problem |
| Seed catalog sourcing                  | WikiArt open dataset or manually curate ~50 images — enough for MVP     |
| Scope creep into social/marketplace    | Hard boundary: no social features, no payments in Layer 1               |
| Vision API costs                       | Classify on ingest only (once per image), not on every request          |

## Recommendation approach

Start with content-based filtering:

1. Each artwork gets a tag vector from the vision model on ingest (e.g. style: impressionist, mood: calm, palette: warm, medium: oil)
2. User's taste profile = weighted aggregation of liked artwork vectors
3. Score unrated artworks by cosine similarity to the taste profile
4. Serve highest-scoring pieces as recommendations

This approach works with zero other users (no cold-start), is simple to implement, and produces explainable results. Collaborative filtering can be added in a later layer if the user base grows.

## Project structure (planned)

```
artswipe/
├── src/
│   ├── app/                  # Next.js App Router pages
│   │   ├── layout.tsx
│   │   ├── page.tsx          # Landing / swipe feed
│   │   ├── login/
│   │   ├── register/
│   │   ├── liked/            # User's liked pieces
│   │   └── recommendations/  # AI-powered feed
│   ├── components/           # UI components
│   │   ├── ArtCard.tsx
│   │   ├── SwipeInterface.tsx
│   │   └── RecommendationFeed.tsx
│   ├── lib/                  # Utilities and services
│   │   ├── supabase.ts       # Supabase client
│   │   ├── ai.ts             # Vision API integration
│   │   └── recommend.ts      # Recommendation engine
│   └── types/                # TypeScript types
│       └── index.ts
├── tests/
│   └── e2e/
│       └── core-flow.spec.ts # MVP E2E test
├── PROJECT_PLAN.md           # This file
└── ...config files
```

## Decision log

| Date       | Decision                                             | Rationale                                                            |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-09-09 | Chose art discovery/recommendation as project        | Clear business logic, single-user MVP works, avoids empty CRUD       |
| 2026-09-09 | MVP scoped to browse + like/skip + recommendations   | Shortest path to first working flow; social and marketplace deferred |
| 2026-09-09 | Pre-seeded catalog instead of artist uploads for MVP | Removes an entire user role and upload flow from the critical path   |
| 2026-09-09 | Content-based filtering over collaborative           | Works with one user, no cold-start, simpler to implement and test    |
