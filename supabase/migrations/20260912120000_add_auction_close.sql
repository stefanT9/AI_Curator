-- The timed close: the outcome of an auction, recorded once, durably.
--
-- `auctions` derives state from timestamps rather than storing it (see
-- 20260911120000_add_auctions.sql), and this migration is a deliberate
-- exception to that stance rather than a retreat from it. Two things force
-- the exception: S-04 (contact exchange) needs a durable, exactly-once event
-- to trigger on, and the winning amount has to reach the seller, who is
-- deliberately denied a read on `bids` altogether. Both are facts about the
-- world at the instant the auction ended, so freezing them is the same move
-- `auctions.seller_id` already makes -- capture a value when it becomes
-- meaningful, so a later change cannot silently rewrite history.
--
-- Everything else about "is this auction open" stays derived. `closed_at`
-- simply joins `cancelled_at` and `ends_at` as the third term of that
-- predicate, in every place that states it: `place_bid` and `cancel_auction`
-- below, and `isOpen` / the browse queries in src/lib/auctions/.

alter table public.auctions
  add column closed_at timestamptz,
  add column winning_bid_id uuid references public.bids (id) on delete set null,
  add column winning_amount_cents bigint;

comment on column public.auctions.closed_at is
  'When the sweep recorded this auction''s outcome. Always the real clock, never close_due_auctions'' p_now -- that parameter governs due-ness only.';

comment on column public.auctions.winning_bid_id is
  'The bid that won, or null when the auction ended with no bids. `on delete set null` rather than cascade: losing the bid row must not erase the fact that the auction closed.';

comment on column public.auctions.winning_amount_cents is
  'The published result, frozen at close. The `bids` row stays the source of truth for the bid itself; this column exists because the seller cannot read `bids` at all and must still learn what their work sold for.';

-- The sweep's due-ness scan, partial on exactly the rows the sweep can still
-- act on. `auctions_ends_at_idx` cannot serve this: it spans every row ever
-- created, and closed auctions accumulate forever while the due set stays
-- near-empty.
create index auctions_due_close_idx
  on public.auctions (ends_at)
  where closed_at is null and cancelled_at is null;

-- The close itself. One statement, run every minute by the pg_cron job
-- registered in 20260912120100_schedule_auction_close.sql.
--
-- `p_now` is a test seam, not a clock: it decides which auctions are *due*
-- and nothing else. `closed_at` is always the real `now()`, so a test that
-- closes an auction whose `ends_at` is hours away still records a truthful
-- timestamp. This is the same explicit-clock seam `isOpen`/`canBid` use in
-- src/lib/auctions/status.ts, for the reason stated there: the integration
-- lane runs under real RLS with no service-role key, so it cannot fabricate
-- a row whose `ends_at` has already passed.
--
-- That seam is also why this function is granted to NOBODY. A future `p_now`
-- in a signed-in user's hands would close live auctions early and hand
-- themselves the win. The `revoke` below has no matching `grant`, and that
-- omission is load-bearing -- it is the whole reason exposing `p_now` is
-- safe. It cannot be skipped either: config.toml leaves
-- `auto_expose_new_tables` at the cloud default, so a new function in
-- `public` is created with execute already granted to `anon`,
-- `authenticated`, `service_role` and `public` -- every one of which has to
-- be taken away. `service_role` is in that list for tidiness rather than
-- safety: its key holder can update these columns directly anyway, but an
-- accidental `rpc("close_due_auctions", { p_now })` from a future script is
-- worth making impossible rather than merely unwise.
-- What is left: the cron job (running as `postgres`, which owns this
-- function) and a direct postgres connection.
--
-- `for update skip locked` is the same row lock `place_bid` takes, for the
-- same reason -- without it a bid can land between the due-ness read and the
-- winner selection and be silently dropped from the result. `skip locked`
-- rather than a plain `for update`: a contended auction should be skipped and
-- closed on the next tick (it is past `ends_at` anyway, so `place_bid`'s own
-- check refuses the bid in flight), whereas a plain `for update` would hold
-- locks for the whole sweep transaction and block bids on every *other*
-- auction in the batch.
--
-- The comparator is FR-008: highest amount wins, and at equal amounts the
-- earlier `updated_at` wins -- the timestamp `bids_set_updated_at` exists to
-- produce, which is why a bidder who raises correctly forfeits their earlier
-- queue position. `id asc` is appended because `updated_at` is only
-- transaction-time resolution: it makes the winner deterministic in the
-- pathological tie, and makes a fixture pick the same winner on every run.
--
-- Idempotent by `closed_at is null`: a second sweep finds the same auction no
-- longer due and changes nothing, the conditional-update shape
-- `cancel_auction` already uses. Cancelled auctions are skipped forever --
-- "the seller withdrew" and "it ran and nobody bid" are situations FR-010
-- treats differently, so the two terminal states stay disjoint.
create function public.close_due_auctions(p_now timestamptz default now())
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_closed integer;
begin
  with due as (
    select a.id
      from public.auctions a
     where a.closed_at is null
       and a.cancelled_at is null
       and a.ends_at <= p_now
     order by a.ends_at
       for update skip locked
  ),
  winners as (
    select d.id as auction_id, b.id as bid_id, b.amount_cents
      from due d
      left join lateral (
        select b.id, b.amount_cents
          from public.bids b
         where b.auction_id = d.id
         order by b.amount_cents desc, b.updated_at asc, b.id asc
         limit 1
      ) b on true
  )
  update public.auctions a
     set closed_at = now(),
         winning_bid_id = w.bid_id,
         winning_amount_cents = w.amount_cents
    from winners w
   where a.id = w.auction_id;

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

-- Deliberately no `grant` after this -- see the comment above. The absence is
-- the access control.
revoke execute on function public.close_due_auctions(timestamptz)
  from public, anon, authenticated, service_role;

-- Closed is authoritative, not inferred.
--
-- Both functions below gain `and closed_at is null`. Without it, "closed"
-- only means "no more bids" as long as `closed_at` and `ends_at` happen to
-- agree -- and they need not: `close_due_auctions(p_now)` can close an
-- auction whose `ends_at` is still in the future, which is exactly what the
-- integration lane does. The extra term makes the rule structural instead.
--
-- Replaced rather than altered: the signatures are unchanged, so `create or
-- replace` keeps the existing grants and they are not restated -- the same
-- note 20260911190000_add_bids.sql makes about `cancel_auction`.
create or replace function public.place_bid(
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

  -- `closed_at is null` sits inside the locking select, not after it, so the
  -- openness check and the write remain one decision.
  select seller_id, starting_price_cents
    into v_seller, v_starting_price
    from public.auctions
   where id = p_auction_id
     and cancelled_at is null
     and closed_at is null
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

-- Same addition, same reasoning: a closed auction is over, so there is
-- nothing left to withdraw. `false` keeps covering every refusal alike, so
-- the caller still learns nothing about someone else's auction.
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
     and closed_at is null
     and ends_at > now()
     and not exists (
       select 1 from public.bids b where b.auction_id = auctions.id
     )
  returning true into v_cancelled;

  return coalesce(v_cancelled, false);
end;
$$;

-- Backfill. Every auction already past its end time is closed here, so the
-- deploy leaves no row in a state the new branches were not written for --
-- and so the close path is exercised against real data the moment it ships.
-- One transaction is the right call at current volume; if this table ever
-- holds a large backlog of expired auctions, that is the line to reconsider.
do $$
begin
  perform public.close_due_auctions();
end;
$$;
