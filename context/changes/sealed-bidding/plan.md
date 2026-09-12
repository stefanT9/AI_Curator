# Sealed Bidding (S-02) Implementation Plan

## Overview

A collector places a bid nobody else can see. This slice adds the `bids` object, the only write
path to it, and the surface a bid is placed from — plus the half of FR-002 that S-01 could build a
seam for but not exercise: an auction is locked once a bid exists.

Two guardrails land here and neither can be retrofitted. "Sealed means sealed … across every
surface the product exposes" is a property of the RLS policy, not the components. "Bidding is
correct under concurrency" is a property of a row lock and a unique constraint, not of the Server
Action. Both are proven in the database and then proven again, for real, against a running stack.

## Current State Analysis

S-01 shipped the auction object and, deliberately, nothing that touches bids:

- **`supabase/migrations/20260911120000_add_auctions.sql`** — `auctions` with state derived from
  timestamps (`cancelled_at is null and ends_at > now()`), a select-only RLS policy, and **no
  insert, update, or delete policy at all**. Both writes go through `create_auction` /
  `cancel_auction`, which are `security definer` and re-verify `auth.uid()` themselves.
- **`cancel_auction` carries the exact seam this slice fills**: `-- S-02 adds here: and not exists
  (select 1 from public.bids b where b.auction_id = id)`. FR-002's lock is a one-predicate change
  in one place, which is why S-01 built the cancel path as a single conditional `UPDATE`.
- **`src/components/auctions/AuctionCard.tsx:13-18`** carries a standing instruction: "No bid
  control, no bid count, no bidder name anywhere in this component … This is the file S-02 will be
  tempted to add them to; don't."
- **There is no per-auction route.** `src/app/(app)/auctions/page.tsx` is a paginated grid of
  `AuctionCard`s and the only auction surface that exists.
- **`create_auction` is the precedent for atomic check-and-write** (`… for update` on the artwork
  row, then the guarded insert), itself modelled on `claim_enrichment_slot`
  (`supabase/migrations/20260910101500_add_enrichment_quota.sql:43`).
- **`src/lib/auctions/`** holds `config.ts` (duration presets, price bounds mirroring the DB
  constraints), `price.ts` (`parsePriceToCents` / `formatCents`), `status.ts` (`isOpen`,
  `msRemaining`, `formatRemaining` — pure, explicit-clock), and `queries.ts` (`server-only`).
- **`test/integration/auctions.int.ts`** proves the closed mutation surface for real: direct
  PostgREST `insert` and `update` against `auctions` are refused. Its header names this slice as an
  inheritor of that surface.

What is missing is everything about bids: no table, no RPC, no action, no surface, and no proof
that a bid one collector places is invisible to another.

## Desired End State

A signed-in collector opens `/auctions`, clicks a piece, and lands on its detail page: the artwork,
the starting price, a live countdown, and a bid form. They enter an amount at or above the starting
price and submit; the page comes back showing "Your bid: $150.00" — an amount only they can see.
They raise it; the display follows. They try a lower number and get told their bid must exceed
their current one. They cannot bid on their own listing, and the artist cannot see that anyone has
bid at all — only that cancellation is now refused.

Verified by: the integration lane refusing every write and every cross-user read it should refuse,
including two simultaneous raises resolving to one row holding the higher amount; and a manual
walkthrough confirming no surface anywhere displays a bid amount, a bid count, or a bidder name.

### Key Discoveries:

- **The tie-break needs no bid history.** FR-008 resolves ties at the highest amount by "the one
  placed earliest". With one row per bidder upserted on raise, the existing `set_updated_at`
  trigger (`supabase/migrations/20260909160100_add_artworks.sql:64`) stamps exactly when the
  current amount became that bidder's standing bid — which is the timestamp the tie-break compares.
  A full bid ledger would add rows nothing reads.
- **The sealed guardrail is one policy.** A select policy of `bidder_id = auth.uid()` makes a
  cross-user read return *zero rows*, not an error — so a caller that forgets to filter leaks
  nothing. Per `AGENTS.md`, ownership filters in queries are for correctness, never access control.
- **No policy for the seller, deliberately.** §Guardrails says no bid count is exposed to *anyone*
  before close. The seller is included. S-03's close runs `security definer` and bypasses RLS, so
  restricting reads here blocks no later slice.
- **`create_auction`'s error-code convention is the model**: a distinguishable Postgres errcode per
  refusal, mapped to a user-facing message in `RPC_ERROR_STATES`
  (`src/app/actions/auctions.ts:56-73`). `AUC00`–`AUC04` are taken; this slice uses `BID00`–`BID04`.
- **An applied migration is never edited** (`AGENTS.md`). `cancel_auction` changes via
  `create or replace function` in the new migration.

## What We're NOT Doing

- **Closing an auction, or picking a winner.** No scheduler, no close path, no `winner_id`. That is
  S-03 (`timed-auction-close`), and nothing here anticipates its shape beyond storing a timestamp
  it can tie-break on.
- **Contact exchange, or any disclosure of one user's details to another** — S-04.
- **Notifications or email of any kind.** No send path exists (F-02) and nothing here creates one.
  Placing a bid notifies nobody.
- **The on-auction flag in the swipe deck** — S-07, blocked on PRD Open Question 2.
- **A minimum bid increment.** FR-007 dropped it: under sealed bidding an increment requires
  beating a number you cannot see. The starting price is the only floor.
- **Any surface showing the standing high bid, the bid count, or a bidder's identity** — to anyone,
  including the seller, before close. That is the guardrail, not a deferral.
- **A "my bids" page.** The bidder-only badge on the browse grid and the detail page cover it; a
  dedicated route is not in FR-006 or FR-007.
- **Editing or withdrawing a bid.** FR-007 allows raising only. Nothing deletes a bid row.
- **Every PRD §Non-Goal** — payments, in-app messaging, bundles, fees, reserve price, buy-it-now,
  artist analytics.

## Implementation Approach

Additive in the same shape S-01 used, because the surface it established is the thing being
inherited: one new table with the same closed mutation surface, one new `security definer` function
as the only write path, one new route segment, one new client component. Two existing files change
substantively — `cancel_auction` gains its FR-002 predicate, and `AuctionCard` gains a link and a
bidder-only badge.

```
                        ┌── /auctions/[id]   (detail + BidForm)
place_bid ── bids table ┤
 (security   (select:   └── /auctions        (grid + "You've bid" badge)
  definer)    own rows
              only)

cancel_auction ── + and not exists (bids)    → FR-002's lock, finally exercised
```

The central move is that `bids` has exactly one policy — select, scoped to the caller's own rows —
and no insert, update, or delete policy. `place_bid` verifies `auth.uid()`, takes a row lock on the
auction so the openness read and the write are one decision, and upserts on the
`(auction_id, bidder_id)` unique constraint so "their highest bid is the one that counts" is
structural rather than a rule the caller must remember.

## Critical Implementation Details

**The seam comment's SQL is not copy-pasteable as written.** S-01 left
`and not exists (select 1 from public.bids b where b.auction_id = id)`. Inside that subquery `id`
resolves to `bids.id`, not the auction being updated — it must be qualified against the UPDATE's
target relation (`auctions.id`). The predicate is correct in intent and wrong in scope; a silent
mis-resolution here would make cancellation refuse or permit the wrong rows.

**`updated_at` is load-bearing, not bookkeeping.** It is the timestamp FR-008's tie-break compares,
because the `on conflict do update` path fires the existing `before update` trigger and stamps the
moment the current amount became that bidder's standing bid. Do not replace the upsert with a
delete-and-insert, and do not add a second "bid placed at" column — `created_at` records when the
bidder first bid, `updated_at` records when their standing amount was set, and S-03 reads the
latter.

**The row lock is what makes the openness check meaningful.** Reading `cancelled_at` / `ends_at`
without `for update` lets a bid land on an auction cancelled microseconds earlier. Locking the
auction row makes the read and the write one decision, and serialises concurrent bids on the same
auction — the same shape `create_auction` uses on the artwork row.

## Phase 1: Schema and the bid rule in the database

### Overview

The `bids` table, the `place_bid` function as its only write path, the select policy that is the
"sealed" guardrail, and the FR-002 predicate added to `cancel_auction`. Nothing in TypeScript
compiles against this until the types are regenerated, which the user does.

### Changes Required:

#### 1. The migration

**File**: `supabase/migrations/20260911190000_add_bids.sql`

**Intent**: Create the bid object with the same closed mutation surface `auctions` has, and make
every rule in FR-007 a property of the database rather than of a caller. Lead the file with a
comment stating why the surface is closed and why the select policy excludes the seller — the same
service the `auctions` migration's header comment performs.

**Contract**:

- `public.bids`: `id uuid pk default gen_random_uuid()`, `auction_id uuid not null references
  public.auctions (id) on delete cascade`, `bidder_id uuid not null references public.profiles (id)
  on delete cascade`, `amount_cents bigint not null`, `created_at`, `updated_at`.
- `unique (auction_id, bidder_id)` — one row per bidder per auction. This is what makes "their
  highest bid is the one that counts" structural; it is also the conflict target the upsert needs.
- `check (amount_cents > 0 and amount_cents <= 100000000000)` — mirrors
  `auctions_starting_price_positive` and `MAX_STARTING_PRICE_CENTS` in `src/lib/auctions/config.ts`.
- Index on `bidder_id` (the browse grid's "which of these have I bid on" read, and the FK). No
  separate `auction_id` index: the unique constraint's index has `auction_id` as its leading
  column, which serves `cancel_auction`'s `not exists` and S-03's per-auction scan.
- `alter table public.bids enable row level security;`
- Exactly one policy: `select` to `authenticated` `using (bidder_id = (select auth.uid()))`. No
  insert, update, or delete policy. Comment it with §Guardrails, and state that the seller is
  deliberately not granted a read.
- `create trigger bids_set_updated_at before update on public.bids for each row execute function
  public.set_updated_at();`

#### 2. `place_bid` — the only way a bid comes into existence

**File**: `supabase/migrations/20260911190000_add_bids.sql` (same migration)

**Intent**: One `security definer` function that verifies the caller, that the auction is open,
that the caller is not the seller, that the amount meets the starting price, and that a raise
actually raises — then writes. Each refusal raises a distinguishable errcode so the Server Action
can map it to a field error rather than a generic failure. Missing, cancelled, and ended auctions
fold into one error: the function tells a non-participant nothing about someone else's auction.

**Contract**: `public.place_bid(p_auction_id uuid, p_amount_cents bigint) returns void`,
`language plpgsql`, `volatile`, `security definer`, `set search_path = ''`, with
`revoke execute … from public, anon` and `grant execute … to authenticated` — the same preamble
`create_auction` uses. Errcodes: `BID00` not authenticated · `BID01` auction not open (missing,
cancelled, or ended) · `BID02` seller cannot bid on own auction · `BID03` below starting price ·
`BID04` not higher than the caller's current bid.

The body reads the auction under a row lock, then upserts. The upsert is the non-obvious part —
the `where` on the conflict path is what refuses a lower *or equal* resubmission, and the absent
`returning` row is how that refusal is detected:

```sql
  select seller_id, starting_price_cents
    into v_seller, v_starting_price
    from public.auctions
   where id = p_auction_id
     and cancelled_at is null
     and ends_at > now()
     for update;

  if not found then
    raise exception 'auction is not open' using errcode = 'BID01';
  end if;
  -- … BID02 / BID03 checks …

  insert into public.bids (auction_id, bidder_id, amount_cents)
  values (p_auction_id, v_user, p_amount_cents)
  on conflict (auction_id, bidder_id) do update
     set amount_cents = excluded.amount_cents
   where public.bids.amount_cents < excluded.amount_cents
  returning id into v_bid_id;

  if v_bid_id is null then
    raise exception 'bid must exceed your current bid' using errcode = 'BID04';
  end if;
```

#### 3. `cancel_auction` gains FR-002's lock

**File**: `supabase/migrations/20260911190000_add_bids.sql` (same migration)

**Intent**: Replace `cancel_auction` so an auction with any bid cannot be cancelled. `create or
replace function` with an unchanged signature keeps the existing grants, so they are not restated.
Replace S-01's seam comment with the live predicate, and keep the surrounding comment's explanation
of why `false` covers every refusal alike.

**Contract**: the `where` clause gains
`and not exists (select 1 from public.bids b where b.auction_id = auctions.id)` — qualified against
the UPDATE's target relation, not the bare `id` the seam comment wrote.

#### 4. Domain types and the biddability predicate

**File**: `src/types/domain.ts`, `src/lib/auctions/status.ts`

**Intent**: Name the new row shape once, and express "can this viewer bid on this auction right
now" as a pure function rather than a condition re-derived in the page and the form.

**Contract**: `export type Bid = Database["public"]["Tables"]["bids"]["Row"];` in `domain.ts`.
`canBid(auction: Pick<Auction, "cancelled_at" | "ends_at" | "seller_id">, viewerId: string, now:
Date): boolean` in `status.ts`, returning `isOpen(auction, now) && auction.seller_id !== viewerId`
— explicit clock, same reasoning as its neighbours.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db reset`
- Types regenerate with `bids` present: `npm run db:types:local`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- `canBid` unit tests pass: `npm run test`

#### Manual Verification:

- `supabase/migrations/20260911190000_add_bids.sql` contains no `for insert`, `for update`, or
  `for delete` policy on `bids`, and exactly one `for select` policy scoped to `bidder_id`.
- The regenerated `src/types/database.ts` shows `place_bid` and the `bids` row type.

**Implementation Note**: this phase needs a local stack and two commands the user runs themselves
(`npx supabase db reset`, `npm run db:types:local`). Nothing in Phase 2 typechecks until the second
one has run. Pause for manual confirmation before Phase 2.

---

## Phase 2: Server Action and data access

### Overview

`placeBid` as the single mutation entry point with a Zod boundary and a per-errcode message map,
plus the three reads the surface needs: one auction by id, the caller's own bid on it, and — for
the grid badge — which of a page's auctions the caller has bid on.

### Changes Required:

#### 1. `placeBid`

**File**: `src/app/actions/auctions.ts`

**Intent**: Validate the auction id and the typed amount at the boundary, call the RPC, and map
each errcode to either a field error on the amount or a form-level message. No redirect: the
collector stays on the detail page and sees their new standing bid, so `revalidatePath` is the
whole of the post-write behaviour.

**Contract**: `export async function placeBid(_state: BidFormState, formData: FormData):
Promise<BidFormState>` with `BidFormState = { errors?: { amount?: string[] }; message?: string } |
undefined`. Guarded by `requireUser()`. The amount reuses `parsePriceToCents` (identical bounds to
the starting price, and the same `.refine` shape `StartingPriceSchema` uses). A `BID_ERROR_STATES`
map alongside the existing `RPC_ERROR_STATES`: `BID03` and `BID04` produce `errors.amount`,
`BID00`–`BID02` produce `message`. Revalidates `/auctions/[id]` and `/auctions`.

#### 2. Reads for the detail page and the grid

**File**: `src/lib/auctions/queries.ts`

**Intent**: Add the three reads the new surface needs, following the module's existing shapes — one
cached single-row read (as `getArtwork` does for the detail page's `generateMetadata` + body), and
one batched lookup for the grid (as `getLiveAuctionsByArtwork` does for the studio).

**Contract**:

- `getAuction = cache(async (id: string): Promise<AuctionWithArtwork | null>)` — by id, **without**
  the openness predicate: an ended or cancelled auction still renders, it just is not biddable.
  Reuses `attachArtworks`.
- `getOwnBid = cache(async (auctionId: string): Promise<Bid | null>)` — selects from `bids` by
  `auction_id` and `maybeSingle()`. The select policy is what scopes it to the caller; note that in
  a comment, since the absence of a `bidder_id` filter looks like an oversight otherwise and
  `AGENTS.md` is explicit that the filter would not be the security boundary anyway.
- `getOwnBidAuctionIds = async (auctionIds: string[]): Promise<Set<string>>` — one `in()` query,
  never per row; returns empty for an empty input, as its neighbours do.

#### 3. Default-lane tests

**File**: `test/actions/auctions.test.ts`, `test/lib/auctions-status.test.ts`,
`test/lib/auctions-queries.test.ts`

**Intent**: Cover the Zod gates that never reach the database, the errcode→message mapping, and
`canBid`. Supabase stays mocked in this lane — what the database actually refuses is Phase 3's job,
and conflating the two is what makes a refusal test vacuous.

**Contract**: `placeBid` cases — malformed auction id and unparseable/zero/over-max amount are
refused before `rpc` is called; each of `BID00`–`BID04` maps to its expected state shape; the happy
path calls `rpc("place_bid", { p_auction_id, p_amount_cents })` with cents, not dollars. `canBid`
cases — open + other's auction, open + own auction, cancelled, ended. Query cases follow the
module's existing mock shape, including `getOwnBidAuctionIds([])` issuing no query.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- Production build passes: `npm run build`

#### Manual Verification:

- `placeBid` is the only new export of the `"use server"` module — no helper leaked into the public
  endpoint surface (`AGENTS.md`: every export of a `"use server"` module is a public endpoint).
- No query in `src/lib/auctions/queries.ts` selects a bid amount belonging to anyone but the caller.

---

## Phase 3: Real-boundary proof

### Overview

The phase this slice exists for. Everything above is an intention until a real Postgres with real
RLS refuses what the design says it refuses — and two guardrails are only checkable here: a
cross-user read of `bids`, and two simultaneous bids resolving to one row.

### Changes Required:

#### 1. The integration suite

**File**: `test/integration/bids.int.ts`

**Intent**: Pin what the database permits and refuses, under real RLS with no service-role key,
before any UI rests on it. Model the file on `test/integration/auctions.int.ts` — a header comment
stating what only this lane can prove, one fixture set created in `beforeAll`, and three users
minted once (`sign_in_sign_ups` is rate-limited to 30 per 5 minutes per IP): a seller artist, and
two collectors as bidder and foil.

**Contract**: cases, each asserting the errcode or the row state rather than merely "it failed" —

1. A bid at exactly the starting price is accepted.
2. A bid one cent below the starting price is refused (`BID03`).
3. The seller bidding on their own auction is refused (`BID02`).
4. A raise updates the same row: still one row for that bidder, higher `amount_cents`, `updated_at`
   strictly greater than before.
5. A lower resubmission is refused (`BID04`) and the stored amount is unchanged; an *equal*
   resubmission is refused the same way.
6. A bid on a cancelled auction is refused (`BID01`).
7. A direct PostgREST `insert` into `bids` is refused.
8. A direct `update` of the caller's own bid row is refused (there is no update policy — raising
   goes through the RPC).
9. A direct `delete` is refused.
10. **The sealed read**: collector B selects `bids` for an auction A has bid on and receives zero
    rows — and a `count` query returns 0, not 1.
11. The seller selects `bids` on their own auction and receives zero rows.
12. `cancel_auction` returns `false` once a bid exists, and the auction is still open afterward
    (FR-002's lock, exercised for the first time).
13. **Concurrency**: two `place_bid` calls from the same bidder issued together (`Promise.all`,
    different amounts) leave exactly one row holding the higher amount, with no error other than a
    possible `BID04` on the lower one. Two different bidders bidding together both succeed, with
    one row each.

### Success Criteria:

#### Automated Verification:

- The integration lane passes against a running local stack: `npm run test:integration`
- The default lane is still green: `npm run test`
- Linting and formatting pass: `npm run lint` · `npm run format:check`

#### Manual Verification:

- The refusal tests are not vacuous: temporarily loosen the `bids` select policy to `using (true)`,
  re-run the lane, and observe cases 10 and 11 fail — then restore it. Per
  `context/foundation/lessons.md`, a refusal test that has never been seen failing proves nothing.
- Case 13 is observed to actually race — the two calls are issued without awaiting the first.

**Implementation Note**: this lane needs `.env.test.local` and a running stack; the user starts it.
Pause for manual confirmation before Phase 4.

---

## Phase 4: The bidding surface

### Overview

The route that does not exist yet, the form that places a bid, the bidder-only display of their own
standing bid, and the one badge on the browse grid. The only phase touching files S-01 shipped.

### Changes Required:

#### 1. The auction detail page

**File**: `src/app/(app)/auctions/[id]/page.tsx`

**Intent**: One auction, full size: the artwork, the starting price, the live countdown, and
whichever control applies to this viewer — the bid form, the seller's cancel control, or a plain
"this auction has ended" note. A missing and an out-of-reach auction are the same `notFound()`, as
`src/app/(app)/artwork/[id]/page.tsx` reasons.

**Contract**: `export default async function AuctionDetailPage({ params }: PageProps<"/auctions/[id]">)`
plus `generateMetadata` sharing the cached `getAuction`. `requireUser()` gates it. Renders
`BidForm` when `canBid(auction, user.id, new Date())`, `CancelAuctionButton` when the viewer is the
seller, and neither when the auction is closed. Reads `getOwnBid(id)` and passes the current amount
to the form.

#### 2. The bid form

**File**: `src/components/auctions/BidForm.tsx`

**Intent**: A client component driving `placeBid` through `useActionState`, in the shape
`AuctionForm` established. It shows the collector their own standing bid and nothing about anyone
else's — the one place in the product where a bid amount is rendered, and it belongs to the viewer.

**Contract**: `BidForm({ auctionId, startingPriceCents, currentBidCents }: { auctionId: string;
startingPriceCents: number; currentBidCents: number | null })`. Hidden `auctionId` input; a
`Field`-based amount input hinted with the floor (`formatCents(startingPriceCents)`, or the current
bid when raising); submit label "Place bid" / "Raise bid"; `state.errors.amount` under the field
and `state.message` in a `role="alert"`. When `currentBidCents` is non-null, a line reading
`Your bid: {formatCents(currentBidCents)}` with a note that only they can see it.

#### 3. The card links through, and says whether *you* have bid

**File**: `src/components/auctions/AuctionCard.tsx`

**Intent**: Make the card the entry point to the detail page, and add the bidder-only badge. The
standing "don't add bids here" comment is revised rather than deleted — it becomes narrower and
therefore more useful: this component may show that *you* have bid, and never an amount, a count,
or another bidder's identity.

**Contract**: the card's artwork and title link to `/auctions/${auction.id}`. New optional prop
`hasBid?: boolean`, rendering a small "You've bid" badge alongside the existing "Your listing"
treatment. No new prop carries an amount.

#### 4. The browse grid resolves the badge

**File**: `src/app/(app)/auctions/page.tsx`

**Intent**: One batched lookup for the page's auctions, never one per card, matching how the studio
resolves live auctions for its grid.

**Contract**: after `getOpenAuctionsPage`, call `getOwnBidAuctionIds(auctions.map((a) => a.id))`
and pass `hasBid={bidAuctionIds.has(auction.id)}` per card.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- Unit tests pass: `npm run test`
- Production build passes: `npm run build`

#### Manual Verification:

- As a collector: bid on someone else's auction, see "Your bid" appear, raise it, watch it update;
  try a lower amount and get the field error; try below the starting price and get the field error.
- As the seller of that auction: the detail page and the grid show no bid amount, no bid count, and
  no bidder name; Cancel is now refused with the auction still listed.
- As a second collector: the first collector's bid is invisible everywhere — grid, detail page, and
  the badge, which shows only for auctions you bid on yourself.
- FR-013 regression walkthrough: swipe, like, unlike, open `/liked`, and confirm deck ordering is
  unchanged.
- FR-014 regression walkthrough: upload an artwork with AI tagging and publish it.

---

## Testing Strategy

### Unit Tests (`npm run test`, Supabase mocked):

- `placeBid`'s Zod gates: malformed auction id, unparseable amount, zero, over `MAX_STARTING_PRICE_CENTS`.
- Each of `BID00`–`BID04` mapping to its expected `BidFormState`.
- The RPC is called with minor units, not dollars.
- `canBid` across open / own / cancelled / ended.
- `getOwnBidAuctionIds([])` issuing no query.

### Integration Tests (`npm run test:integration`, real RLS, local only):

The thirteen cases in Phase 3. The two that cannot be replaced by anything cheaper are the
cross-user read (case 10/11 — the sealed guardrail) and the concurrent raise (case 13 — the
concurrency guardrail).

### Manual Testing Steps:

1. As artist A, list a piece; as collector B, open `/auctions`, click the card, bid the starting
   price exactly; confirm "Your bid" appears.
2. Raise it; confirm the display follows. Enter a lower amount; confirm the field error and that
   the stored bid is unchanged after a refresh.
3. As artist A, open the auction: confirm nothing about bids appears anywhere, and Cancel now does
   nothing (the auction stays listed).
4. As collector C, open the same auction: confirm no amount, no count, no name, and no "You've bid"
   badge; place a bid and confirm only your own appears.
5. Confirm no auction surface anywhere renders someone else's amount — grid, detail, studio.
6. Walk FR-013 (swipe / like / liked view / ordering) and FR-014 (upload / tag / publish).

## Performance Considerations

Volume is low (PRD `target_scale`: small, low qps) and the reads added are bounded: one row by id,
one bid by auction, one `in()` over at most `AUCTIONS_PAGE_SIZE` (24) auction ids. The unique index
on `(auction_id, bidder_id)` serves both the upsert's conflict resolution and `cancel_auction`'s
`not exists`; the `bidder_id` index serves the grid lookup.

## Migration Notes

One forward-only migration. `bids` is new, so there is no data to convert. `cancel_auction` is
replaced with a strictly narrower `where` clause — an auction with bids stops being cancellable,
which is the intended behaviour change and affects no existing row (no bids exist yet). No
migration edits an applied file; `.github/workflows/migrations.yml` applies this one on merge to
`main`.

## References

- Roadmap slice: `context/foundation/roadmap.md` — S-02
- PRD: `context/foundation/prd-v3.md` — US-01, FR-007, FR-002, §Guardrails, §Access Control
- Prior slice (the surface this inherits): `context/archive/2026-09-11-list-artwork-for-auction/plan.md`
- The seam this fills: `supabase/migrations/20260911120000_add_auctions.sql` (`cancel_auction`)
- Atomic check-and-write precedent: `supabase/migrations/20260910101500_add_enrichment_quota.sql:43`
- Closed-surface proof to model Phase 3 on: `test/integration/auctions.int.ts`
- Standing guardrail comment to revise: `src/components/auctions/AuctionCard.tsx:13-18`
- Lessons applied: `context/foundation/lessons.md` — "Prove each Progress item before checking it
  off", "Check the branch before the first commit of a change"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and the bid rule in the database

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db reset` — 86b6382
- [x] 1.2 Types regenerate with `bids` present: `npm run db:types:local` — 86b6382
- [x] 1.3 Type checking passes: `npm run typecheck` — 86b6382
- [x] 1.4 Linting passes: `npm run lint` — 86b6382
- [x] 1.5 Formatting passes: `npm run format:check` — 86b6382
- [x] 1.6 `canBid` unit tests pass: `npm run test` — 86b6382

#### Manual

- [x] 1.7 No insert/update/delete policy on `bids`; exactly one select policy scoped to `bidder_id` — 86b6382
- [x] 1.8 Regenerated `src/types/database.ts` shows `place_bid` and the `bids` row type — 86b6382

### Phase 2: Server Action and data access

#### Automated

- [x] 2.1 Unit tests pass: `npm run test` — fd393e9
- [x] 2.2 Type checking passes: `npm run typecheck` — fd393e9
- [x] 2.3 Linting passes: `npm run lint` — fd393e9
- [x] 2.4 Formatting passes: `npm run format:check` — fd393e9
- [x] 2.5 Production build passes: `npm run build` — fd393e9

#### Manual

- [x] 2.6 `placeBid` is the only new export of the `"use server"` module — fd393e9
- [x] 2.7 No query selects a bid amount belonging to anyone but the caller — fd393e9

### Phase 3: Real-boundary proof

#### Automated

- [x] 3.1 Integration lane passes against a running local stack: `npm run test:integration` — fd4390b
- [x] 3.2 Default lane is still green: `npm run test` — fd4390b
- [x] 3.3 Linting and formatting pass: `npm run lint` · `npm run format:check` — fd4390b

#### Manual

- [x] 3.4 Refusal tests observed failing with the select policy loosened to `using (true)`, then restored — fd4390b
- [x] 3.5 Case 13's two calls observed issued without awaiting the first — fd4390b

### Phase 4: The bidding surface

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck`
- [x] 4.2 Linting passes: `npm run lint`
- [x] 4.3 Formatting passes: `npm run format:check`
- [x] 4.4 Unit tests pass: `npm run test`
- [x] 4.5 Production build passes: `npm run build`

#### Manual

- [x] 4.6 Collector: bid, raise, lower-bid error, below-floor error all behave as specified
- [x] 4.7 Seller: no bid amount, count, or bidder name anywhere; Cancel refused with the auction still listed
- [x] 4.8 Second collector: another bidder's bid invisible everywhere, including the badge
- [x] 4.9 FR-013 walkthrough: swipe, like, unlike, `/liked`, deck ordering unchanged
- [x] 4.10 FR-014 walkthrough: upload with AI tagging and publish unchanged
