-- Bids: the sealed half of the auction. A bid is placed by a collector, is
-- visible to nobody but that collector, and can only ever go up.
--
-- The mutation surface is closed in the same way `auctions` is: this table has
-- a select policy only, and no insert, update, or delete policy at all. Every
-- write goes through `place_bid` below, which is security definer and verifies
-- `auth.uid()` itself. That stance is what makes FR-007's "raise only, never
-- edit or withdraw" absolute rather than a rule each caller has to remember --
-- there is no path that lowers an amount or removes a row.
--
-- The select policy is the *entire* "sealed" guardrail: `bidder_id =
-- auth.uid()` makes a cross-user read return zero rows rather than an error,
-- so a query that forgets to filter by bidder leaks nothing. Per AGENTS.md,
-- ownership filters in queries are for correctness and performance; this
-- policy is the access control.
--
-- The seller is deliberately *not* granted a read. §Guardrails says no bid
-- count is exposed to anyone before close, and "anyone" includes the artist
-- running the auction -- they learn only that cancellation is now refused.
-- S-03's close will run security definer and bypass RLS, so withholding the
-- read here blocks no later slice.
create table public.bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references public.auctions (id) on delete cascade,
  bidder_id uuid not null references public.profiles (id) on delete cascade,
  amount_cents bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One row per bidder per auction. This is what makes "their highest bid is
  -- the one that counts" structural rather than a caller's discipline, and it
  -- is the conflict target `place_bid`'s upsert resolves against.
  constraint bids_one_per_bidder unique (auction_id, bidder_id),

  -- Mirrors `auctions_starting_price_positive` and MAX_STARTING_PRICE_CENTS in
  -- src/lib/auctions/config.ts.
  constraint bids_amount_positive check (
    amount_cents > 0 and amount_cents <= 100000000000
  )
);

-- The browse grid's "which of these have I bid on" read, and the FK.
--
-- No separate auction_id index: `bids_one_per_bidder` has auction_id as its
-- leading column, which already serves `cancel_auction`'s `not exists` and
-- S-03's per-auction scan.
create index bids_bidder_id_idx on public.bids (bidder_id);

alter table public.bids enable row level security;

-- A bidder reads their own bids and nothing else -- see the table comment: this
-- single policy *is* the sealed guardrail, and the seller's absence from it is
-- deliberate, not an omission.
create policy "Bidders can read their own bids"
  on public.bids for select
  to authenticated
  using (bidder_id = (select auth.uid()));

-- Deliberately no insert, update, or delete policy. Every write goes through
-- `place_bid` below -- see the table comment above.

-- Load-bearing, not bookkeeping: `on conflict do update` fires this trigger,
-- so `updated_at` records the moment the current amount became that bidder's
-- standing bid. That is the timestamp FR-008's earliest-wins tie-break
-- compares, which is why the raise path is an upsert and not a
-- delete-and-insert.
create trigger bids_set_updated_at
  before update on public.bids
  for each row execute function public.set_updated_at();

-- The only way a bid comes into existence, or changes. Verifies the caller,
-- that the auction is open, that the caller is not its seller, that the amount
-- meets the starting price, and that a raise actually raises -- then writes.
--
-- The auction row is read `for update` so the openness check and the write are
-- one decision: without the lock a bid can land on an auction cancelled
-- microseconds earlier, and two concurrent bids on the same auction would not
-- serialise. Same shape as `create_auction`'s lock on the artwork row, itself
-- modelled on `claim_enrichment_slot`.
--
-- Missing, cancelled, and ended auctions all fold into BID01 on purpose: this
-- function tells a non-participant nothing about someone else's auction. Each
-- other failure mode raises a distinguishable errcode so the Server Action can
-- map it to a specific field error instead of a generic failure.
create function public.place_bid(
  p_auction_id uuid,
  p_amount_cents bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_seller uuid;
  v_starting_price bigint;
  v_bid_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'BID00';
  end if;

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

  if v_seller = v_user then
    raise exception 'seller cannot bid on own auction' using errcode = 'BID02';
  end if;

  if p_amount_cents < v_starting_price then
    raise exception 'bid is below the starting price' using errcode = 'BID03';
  end if;

  -- The `where` on the conflict path is what refuses a lower *or equal*
  -- resubmission: when it does not hold, no row is updated and nothing is
  -- returned, which leaves v_bid_id null. That absence is the refusal signal.
  insert into public.bids (auction_id, bidder_id, amount_cents)
  values (p_auction_id, v_user, p_amount_cents)
  on conflict (auction_id, bidder_id) do update
     set amount_cents = excluded.amount_cents
   where public.bids.amount_cents < excluded.amount_cents
  returning id into v_bid_id;

  if v_bid_id is null then
    raise exception 'bid must exceed your current bid' using errcode = 'BID04';
  end if;
end;
$$;

revoke execute on function public.place_bid(uuid, bigint) from public, anon;
grant execute on function public.place_bid(uuid, bigint) to authenticated;

-- The only way an auction is cancelled. One conditional update whose where
-- clause *is* FR-002's rule: an auction can be cancelled only by its seller,
-- only once, only while it is still open, and -- as of this migration -- only
-- while no bid has been placed on it. Returns whether a row was actually
-- cancelled -- false covers "already cancelled", "already ended", "not yours",
-- and "already has bids" alike, deliberately, so the caller learns nothing
-- about someone else's auction from the return value.
--
-- Replaced rather than altered: the signature is unchanged, so `create or
-- replace` keeps the existing grants and they are not restated. The `not
-- exists` subquery is qualified against `auctions.id` and not a bare `id`,
-- which inside the subquery would resolve to `bids.id` and lock the wrong
-- rows.
create or replace function public.cancel_auction(p_auction_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cancelled boolean;
begin
  update public.auctions
     set cancelled_at = now()
   where id = p_auction_id
     and seller_id = auth.uid()
     and cancelled_at is null
     and ends_at > now()
     and not exists (
       select 1 from public.bids b where b.auction_id = auctions.id
     )
  returning true into v_cancelled;

  return coalesce(v_cancelled, false);
end;
$$;
