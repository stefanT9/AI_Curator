# Sealed Bidding (S-02) — Plan Brief

> Full plan: `context/changes/sealed-bidding/plan.md`
> Roadmap slice: `context/foundation/roadmap.md` — S-02
> PRD: `context/foundation/prd-v3.md` — US-01, FR-007, FR-002 (the lock-once-bid half)

## What & Why

A collector can place a bid nobody else can see, on any auction except their own, and raise it
while the auction runs. This is the slice that makes S-01's auction object do something: without
bids there is nothing to close (S-03), nobody to hand contact details to (S-04), and no reason to
notify anyone (S-05/S-06). It also finally exercises the half of FR-002 S-01 could only build a
seam for — an auction is locked once a bid exists.

## Starting Point

`auctions` exists with a deliberately closed mutation surface: a select-only RLS policy, no
insert/update/delete policy at all, and two `security definer` functions as the only write paths.
`cancel_auction` carries a literal comment marking the line this slice extends. `AuctionCard`
carries a standing instruction not to add bid controls to it. There is no per-auction route — the
only auction surface is the paginated `/auctions` grid — and nothing anywhere reads or writes a bid.

## Desired End State

A collector opens `/auctions`, clicks a piece, and lands on its detail page: artwork, starting
price, live countdown, bid form. They bid at or above the starting price and the page comes back
showing "Your bid: $150.00" — an amount only they can see. They raise it and the display follows; a
lower number is refused with a field error. The seller sees no amount, no count, no name, and finds
cancellation now refused. A second collector sees no trace of the first's bid anywhere.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Bid storage shape | One row per bidder per auction, upserted on raise | `updated_at` then records when the current amount became that bidder's standing bid, which is exactly what FR-008's earliest-wins tie-break compares — a bid ledger would add rows nothing reads. | Plan |
| Mutation surface | No insert/update/delete policy; one `place_bid` RPC | Inherits the stance `auctions` took, so "raise only, never edit or withdraw" is absolute rather than a rule callers must remember. | Plan |
| Sealed enforcement | Select policy `bidder_id = auth.uid()`, and nothing else | A cross-user read returns zero rows rather than an error, so a caller that forgets to filter leaks nothing; the seller is deliberately excluded too. | PRD + Plan |
| Bid entry point | New `/auctions/[id]` detail page | Room for clear validation and the own-bid display, and it keeps bid controls out of `AuctionCard`, which carries a standing instruction against them. | Plan |
| Own-bid visibility | Show "Your bid: $X" to that bidder only | The guardrail is about exposure to others; a collector who cannot see their own standing bid raises blind. | Plan |
| Lower resubmission | Refused with a field error (equal too) | Silently keeping the higher bid gives no signal the new number did nothing, which reads as a bug. | Plan |
| Grid affordance | Bidder-only "You've bid" badge, never an amount | Lets a collector track engagement across a paginated grid; first thing to cut if time runs short. | Plan |
| Concurrency | `for update` row lock on the auction + unique constraint | Makes the openness read and the write one decision, the same shape `create_auction` and `claim_enrichment_slot` use. | Plan |
| Concurrency proof | Dedicated real-boundary test, two simultaneous raises | S-01 explicitly left this guardrail for this slice; asserting it by inspection is what "unproven" looks like. | Plan |

## Scope

**In scope:** the `bids` table with a closed mutation surface; `place_bid` as the only write path;
the `not exists (bids)` predicate added to `cancel_auction`; a Zod-validated `placeBid` Server
Action with per-errcode messages; three reads (auction by id, own bid, own-bid ids for a page);
`/auctions/[id]`; `BidForm`; the bidder-only grid badge; thirteen real-boundary cases including
concurrency.

**Out of scope:** closing an auction or picking a winner (S-03), contact exchange (S-04),
notifications or email of any kind (F-02, S-05, S-06), the deck flag (S-07), a minimum bid
increment (dropped by FR-007), any surface showing the standing bid / bid count / bidder identity
to anyone before close, a "my bids" page, editing or withdrawing a bid, and every PRD §Non-Goal.

## Architecture / Approach

Additive in the shape S-01 established, because that surface is what this inherits.

```
                        ┌── /auctions/[id]   (detail + BidForm)
place_bid ── bids table ┤
 (security   (select:   └── /auctions        (grid + "You've bid" badge)
  definer)    own rows
              only)

cancel_auction ── + and not exists (bids)    → FR-002's lock, finally exercised
```

`place_bid` verifies `auth.uid()`, reads the auction under a row lock so the openness check and the
write are one decision, and upserts on the `(auction_id, bidder_id)` unique constraint — the
conflict path's `where` is what refuses a lower or equal resubmission. Five distinguishable
errcodes (`BID00`–`BID04`) map to field errors in the Server Action, mirroring `create_auction`'s
`AUC00`–`AUC04` convention.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema and the bid rule | Migration (table, `place_bid`, one select policy, replaced `cancel_auction`), regenerated types, `canBid` | S-01's seam comment is not copy-pasteable — its bare `id` resolves to `bids.id`, not the auction being cancelled |
| 2. Server Action and data access | `placeBid` with a per-errcode message map; three reads; default-lane tests | A read that forgets the caller is not the boundary — the select policy is, and a query written as if it were the filter would still pass mocked tests |
| 3. Real-boundary proof | Thirteen cases under real RLS, including the cross-user read and two simultaneous raises | Refusal tests that pass vacuously — mitigated by observing them fail with the policy loosened |
| 4. The bidding surface | `/auctions/[id]`, `BidForm`, own-bid display, grid badge, card link-through | The only phase touching S-01's files; FR-013/FR-014 regressions must be walked, not inferred |

**Prerequisites:** a running local Supabase stack and `.env.test.local` for the integration lane.
The user runs `npx supabase db reset` and `npm run db:types:local` themselves — nothing in Phase 2
typechecks until the second has run.

**Estimated effort:** ~3 sessions across 4 phases. Phase 1 and Phase 3 carry the thinking; Phase 4
is the largest in file count and the most conventional.

## Open Risks & Assumptions

- **"Sealed" now has a real surface to leak from.** S-01 could satisfy the guardrail by having no
  bid data at all. From here it is one policy and a discipline about what components receive as
  props — which is why `AuctionCard` gets a revised (narrower) guard comment rather than a deleted
  one.
- **The tie-break rests on trigger behaviour.** `updated_at` is meaningful only because the
  `on conflict do update` path fires the existing `before update` trigger. S-03 depends on this;
  swapping the upsert for delete-and-insert would quietly break it.
- **Bidding on an auction past `ends_at` is refused by `place_bid`'s predicate, not by a close.**
  Nothing closes an auction until S-03, so an expired auction sits in a state where bids are
  refused and no winner exists. That is correct for this slice and looks odd until S-03 lands.
- **The badge is the designated cut.** If the budget tightens, the grid badge goes first; the RPC,
  the policy, the detail page, and the concurrency proof do not.

## Success Criteria (Summary)

- A collector can bid at or above the starting price on someone else's open auction, raise it, and
  see their own standing bid — and is told clearly when an amount is below the floor or below their
  current bid.
- No surface anywhere shows anyone the standing high bid, the bid count, or a bidder's identity —
  the seller included — and a real cross-user read against the database returns zero rows.
- An auction with a bid can no longer be cancelled, and two simultaneous raises leave one row
  holding the higher amount.
