# List Artwork for Auction (S-01) — Plan Brief

> Full plan: `context/changes/list-artwork-for-auction/plan.md`
> Roadmap slice: `context/foundation/roadmap.md` — S-01
> PRD: `context/foundation/prd-v3.md` — US-01, FR-001, FR-002, FR-006, FR-014

## What & Why

ArtSwipe is good at putting the right artwork in front of the right collector and does nothing about
what happens next. This slice adds the missing object: an artist lists one of their own pieces for
auction with a starting price and a preset duration, can cancel it while it is untouched, and any
signed-in user can browse open auctions in a dedicated section. It ships first because every other
slice in the auction roadmap attaches to the object it creates — there is nothing to notify
collectors about, bid on, or close until an auction exists.

## Starting Point

No auction surface of any kind: thirteen migrations, no `auctions` table, no `/auctions` route, no
nav entry. What does exist is a strong and consistent set of conventions to follow — RLS on every
table with a stated argument that rules belong in the database because PostgREST is a second front
door, `claim_enrichment_slot` as the precedent for atomic check-and-write, `attachArtists` as the
batched-attribution pattern, and a three-lane test setup whose integration lane runs under real RLS
with no service-role key.

## Desired End State

An artist opens their studio, clicks "List for auction" on an unlisted piece, sets a price and picks
1, 3, or 7 days. The piece shows an "On auction" badge. Every signed-in user visiting `/auctions`
sees that auction — artwork, starting price, live countdown — and the listing artist sees theirs
marked as such with a Cancel control. An auction whose end time has passed is simply no longer in
the list, with nothing having run on a timer to make that true.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Auction state model | Timestamps, state derived | Nothing flips a flag, so nothing can be wrong — an expired auction is correctly not-open the instant the countdown hits zero, with no scheduler (which does not exist until S-03). | Plan |
| FR-002 cancel lock | `cancel_auction` RPC seam | One conditional UPDATE whose WHERE clause *is* the rule, so S-02 adds one `not exists (bids)` predicate in one place instead of auditing callers. | Plan |
| Mutation surface | No insert/update/delete policy at all | Both mutations go through `security definer` functions, making FR-002's "no edits" absolute and the one-live-auction rule unbypassable via PostgREST. | Plan |
| Cardinality | Relisting allowed, one live at a time | FR-010 says a no-bid close leaves the artwork free to relist, so relisting must work; the liveness check is time-dependent and therefore cannot be a partial unique index. | PRD + Plan |
| Duration presets | 1 / 3 / 7 days | Resolves the roadmap's one open unknown; 7 days gives S-05/S-06 notification recipients real time to act, 1 day keeps a manual walkthrough to a single day. | Plan |
| Starting price | Integer minor units + DB CHECK | No float rounding, and the CHECK stops a zero or negative floor — which matters because S-02's entire bid-validity rule is "meets the starting price". | Plan |
| Listing entry point | Studio grid row, per piece | Reuses the existing Edit/Delete action row and the `requireArtist` gate; the artist is already looking at the piece they want to list. | Plan |
| Browse scope | All open auctions incl. your own | FR-006 says "open auctions" with no exclusion, and the artist can check their listing renders as collectors see it; cancel gets a home without a fourth route. | PRD + Plan |
| Time remaining | Absolute time server-side + client countdown | A server-computed relative string is a guaranteed hydration mismatch, and a "time remaining" that never ticks is a worse signal than none. | Plan |

## Scope

**In scope:** the `auctions` table with derived state; `create_auction` and `cancel_auction` as the
only write paths; two Zod-validated Server Actions; a `server-only` query module; a pure
`src/lib/auctions/` module for durations, price, and openness; `/studio/[id]/auction` listing form;
a studio affordance; `/auctions` with card, live countdown, and inline cancel; one nav link.

**Out of scope:** bidding (S-02), timed close and any scheduler (S-03), contact exchange (S-04),
notifications and email of any kind (F-02, S-05, S-06), the on-auction deck flag (S-07, blocked on
PRD Open Question 2), editing a live auction (FR-002 permits cancel only), and every PRD §Non-Goal —
payments, in-app messaging, bundles, fees, reserve price, buy-it-now, artist analytics.

## Architecture / Approach

Strictly additive: a new table, a new `src/lib/auctions/`, a new actions file, a new route segment.
Only two existing files change at all — the studio grid gains one affordance and the app layout gains
one nav link. No existing migration, query, or action is touched, which is what makes the FR-013 and
FR-014 preservation claims cheap to hold.

```
create_auction ──┐                  ┌── /studio/[id]/auction  (list)
                 ├─ auctions table ─┤
cancel_auction ──┘   (select-only   └── /auctions             (browse + cancel)
   security definer   RLS policy)
```

The central move is closing the mutation surface. `auctions` has one policy — select, to
authenticated — and no insert, update, or delete policy. Everything that writes goes through the two
functions, which verify `auth.uid()` themselves and take a row lock on the artwork so two concurrent
listings serialise.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema and domain vocabulary | Migration (table, two functions, one policy), regenerated types, pure `src/lib/auctions/` module | The one-live-auction rule cannot be a partial unique index (`now()` is not IMMUTABLE), so it lives in the function with a row lock — easy to get subtly wrong |
| 2. Server Actions and data access | `createAuction` / `cancelAuction`, `getOpenAuctions`, studio lookup, default-lane tests | A query that filters `cancelled_at` and forgets `ends_at` shows expired auctions forever and looks fine in review |
| 3. Real-boundary proof | Eleven integration cases pinning what the policies and functions permit and refuse | Refusal tests that pass vacuously — mitigated by observing the lane fail with a policy loosened |
| 4. Listing flow and auction section | `/studio/[id]/auction`, studio affordance, `/auctions`, card, countdown, cancel, nav | The only phase touching existing files; FR-013 and FR-014 regressions must be walked manually, not inferred from green tests |

**Prerequisites:** a running local Supabase stack (`npx supabase start`) and `.env.test.local`
generated for the integration lane; the user runs `npx supabase db reset` and `npm run db:types:local`
themselves — nothing in Phase 2 typechecks until the types are regenerated.

**Estimated effort:** ~3–4 sessions across 4 phases. Phase 1 and Phase 3 carry most of the thinking;
Phase 4 is the largest in file count but the most conventional.

## Open Risks & Assumptions

- **The closed mutation surface is a stronger stance than this codebase has taken before.** It is the
  right one for FR-002, but if a later slice needs a write path this design does not anticipate, it
  means a new function rather than a policy tweak. Phase 3 exists to make sure it is right before
  three more slices depend on it.
- **The cancel lock is only half-exercised here.** FR-002's "locked once a bid exists" cannot be
  proven until S-02 makes bids possible; this slice builds the seam and marks the exact line S-02
  extends, but the rule ships untested against its main case.
- **Expiry cannot be proven in the integration lane.** The RPC computes `ends_at` from a preset and
  there is no service-role key, so no expired row can be fabricated. Mitigated by making openness a
  pure function of a row and an explicit clock, testable at any instant in the default lane.
- **"Sealed means sealed" is trivially true now and easy to break later.** `AuctionCard` is the file
  S-02 will be tempted to add a bid count to; the plan asks for a comment citing §Guardrails there.

## Success Criteria (Summary)

- An artist can list one of their own pieces with a starting price and a preset duration, see it at
  `/auctions` with a correct live countdown, and cancel it — with the piece then free to list again.
- Any signed-in user can browse open auctions and sees nothing anywhere about bids, bid counts, or
  bidders.
- Swiping, liking, the liked view, deck ordering, upload, AI tagging, and publishing all behave
  exactly as they did before — verified by walkthrough, not inferred.
