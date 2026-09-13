-- Auctions: the object every later auction slice (S-02 bids, S-03 close, S-04
-- contact exchange, S-05/S-06 notifications) attaches to. State is derived from
-- timestamps rather than stored in a status column: an auction is open when
-- `cancelled_at is null and ends_at > now()`. Nothing flips a flag, so nothing
-- can be wrong, and no scheduler is needed to make an expired auction stop
-- being open -- that is S-03's territory, not this slice's.
--
-- The mutation surface is closed: this table has a select policy only, and no
-- insert, update, or delete policy at all. Both writes go through
-- `create_auction` and `cancel_auction` below, which verify `auth.uid()`
-- themselves. This is a stronger stance than `artworks` takes, taken
-- deliberately: it makes FR-002's "no edits" absolute (there is no edit path
-- to close), and it makes the one-live-auction-per-artwork rule unbypassable,
-- which a plain insert policy checked only at insert time would not.
create table public.auctions (
  id uuid primary key default gen_random_uuid(),
  artwork_id uuid not null references public.artworks (id) on delete cascade,
  -- Denormalised from artworks.artist_id on purpose: S-04 needs the seller of
  -- a closed auction even if the artwork row has since been deleted, and the
  -- join is one the browse query would otherwise make on every read.
  seller_id uuid not null references public.profiles (id) on delete cascade,
  starting_price_cents bigint not null,
  ends_at timestamptz not null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint auctions_starting_price_positive check (
    starting_price_cents > 0 and starting_price_cents <= 100000000000
  ),
  constraint auctions_ends_after_start check (ends_at > created_at)
);

-- The studio's live-auction lookup and the FK.
create index auctions_artwork_id_idx on public.auctions (artwork_id);

-- The browse query's range predicate (`ends_at > now()`).
create index auctions_ends_at_idx on public.auctions (ends_at);

-- The FK, and S-04's seller lookup.
create index auctions_seller_id_idx on public.auctions (seller_id);

alter table public.auctions enable row level security;

-- FR-006: any signed-in user browses open auctions. This table holds no bid
-- data, so a blanket select stays safe when S-02 adds a separate `bids` table.
create policy "Signed-in users can read all auctions"
  on public.auctions for select
  to authenticated
  using (true);

-- Deliberately no insert, update, or delete policy. Both mutations go through
-- `create_auction` and `cancel_auction` below, which are security definer and
-- re-verify auth.uid() themselves -- see the table comment above.

create trigger auctions_set_updated_at
  before update on public.auctions
  for each row execute function public.set_updated_at();

-- The only way an auction row comes into existence. Verifies the caller is an
-- artist, owns the artwork, and has no live auction on it, then inserts, all
-- in one statement-atomic function.
--
-- A partial unique index cannot express "one live auction per artwork": the
-- predicate involves `now()`, which is not IMMUTABLE, so Postgres rejects it
-- in an index predicate. The `for update` row lock below is what makes this
-- safe under concurrency instead: two concurrent calls serialise on the
-- artwork row, so they cannot both read "no live auction" and both insert --
-- the same shape as `claim_enrichment_slot`'s check-and-insert.
--
-- Each failure mode raises a distinguishable error so the Server Action can
-- map it to a specific field error or message instead of a generic failure.
create function public.create_auction(
  p_artwork_id uuid,
  p_duration_hours int,
  p_starting_price_cents bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_owner uuid;
  v_auction_id uuid;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = 'AUC00';
  end if;

  if not private.is_artist() then
    raise exception 'caller is not an artist' using errcode = 'AUC01';
  end if;

  if p_duration_hours not in (24, 72, 168) then
    raise exception 'duration must be one of 24, 72, or 168 hours' using errcode = 'AUC02';
  end if;

  -- Lock the artwork row so a concurrent create_auction call on the same
  -- artwork serialises behind this one instead of racing it on the liveness
  -- check below.
  select artist_id into v_owner
  from public.artworks
  where id = p_artwork_id
  for update;

  -- A missing artwork and one owned by someone else are folded into the same
  -- error: this function does not confirm to a non-owner whether the id
  -- exists.
  if v_owner is null or v_owner <> v_user then
    raise exception 'artwork is not owned by caller' using errcode = 'AUC03';
  end if;

  if exists (
    select 1
    from public.auctions
    where artwork_id = p_artwork_id
      and cancelled_at is null
      and ends_at > now()
  ) then
    raise exception 'artwork already has a live auction' using errcode = 'AUC04';
  end if;

  insert into public.auctions (artwork_id, seller_id, starting_price_cents, ends_at)
  values (
    p_artwork_id,
    v_user,
    p_starting_price_cents,
    now() + make_interval(hours => p_duration_hours)
  )
  returning id into v_auction_id;

  return v_auction_id;
end;
$$;

revoke execute on function public.create_auction(uuid, int, bigint) from public, anon;
grant execute on function public.create_auction(uuid, int, bigint) to authenticated;

-- The only way an auction is cancelled. One conditional update whose where
-- clause *is* FR-002's rule: an auction can be cancelled only by its seller,
-- only once, and only while it is still open. Returns whether a row was
-- actually cancelled -- false covers "already cancelled", "already ended",
-- and "not yours" alike, deliberately, so the caller learns nothing about
-- someone else's auction from the return value.
create function public.cancel_auction(p_auction_id uuid)
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
     -- S-02 adds here: and not exists (select 1 from public.bids b where b.auction_id = id)
  returning true into v_cancelled;

  return coalesce(v_cancelled, false);
end;
$$;

revoke execute on function public.cancel_auction(uuid) from public, anon;
grant execute on function public.cancel_auction(uuid) to authenticated;
