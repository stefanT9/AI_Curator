---
change_id: list-artwork-for-auction
title: An artist lists a piece for auction, and it shows up somewhere
status: archived
created: 2026-09-11
updated: 2026-09-11
archived_at: 2026-09-11T15:23:33Z
---

## Notes

Roadmap slice **S-01** (`context/foundation/roadmap.md`), the north star of the auction roadmap and
the first slice to ship. PRD refs: US-01, FR-001, FR-002, FR-006, FR-014 in
`context/foundation/prd-v3.md`.

Every other slice in the roadmap attaches to the auction object this change creates — there is
nothing to notify collectors about (S-05, S-06), nothing to bid on (S-02), and nothing to close
(S-03, S-04) until an auction exists. That is why the schema decisions here are load-bearing well
beyond this slice.

### Decisions taken during planning (2026-09-11)

| Decision | Choice |
| --- | --- |
| Auction state | Timestamps, state derived: `cancelled_at is null and ends_at > now()` |
| FR-002 cancel lock | `cancel_auction` RPC seam — one conditional UPDATE, S-02 adds one predicate |
| Cardinality | Relisting allowed; one live auction per artwork, enforced in `create_auction` |
| Listing entry point | Studio grid row, per piece → `/studio/[id]/auction` |
| Duration presets | 1 / 3 / 7 days |
| Starting price | Integer minor units (`bigint`) + DB CHECK; currency implicit |
| Browse scope | `/auctions` lists all open auctions including your own; cancel inline |
| Time remaining | Server-rendered absolute time + client countdown component |

### Roadmap unknown, now resolved

> "Which preset durations are offered? FR-001 requires presets but does not name them."
> — Owner: TBD (implementation). **Resolved: 1 / 3 / 7 days.**

### Deviation discovered during Phase 4 implementation (2026-09-11)

The plan's "Implementation Approach" said nothing in `src/lib/artworks/` would be modified. That held
until manual testing of Phase 4 against the local seed corpus (one demo artist, 1000 artworks) hit a
real `"URI too long"` failure: `getLiveAuctionsByArtwork` (Phase 2) was being called with every one of
that artist's artwork ids at once, and a PostgREST `in()` filter with 1000 UUIDs built a GET request
whose query string the client refused to send.

Fix, agreed with the user: paginate the Studio grid rather than batch the query. `src/lib/artworks/queries.ts`
gained `STUDIO_PAGE_SIZE` and `getArtistArtworksPage()` as pure additions — the existing `getArtistArtworks`
(used by the public artist page) is untouched, and `getLiveAuctionsByArtwork`'s contract is unchanged; it is
now only ever called with at most `STUDIO_PAGE_SIZE` (24) ids. See commit `f1f098a`.

The implementation review that followed (`reviews/impl-review.md`, finding F1) caught the same unbounded-`in()`
shape on `getOpenAuctions`/`/auctions` and applied the identical fix pre-emptively (`AUCTIONS_PAGE_SIZE`,
`getOpenAuctionsPage()`, a shared `Pagination` component and `parsePage` helper) before it could reproduce
against a larger corpus of live auctions.
