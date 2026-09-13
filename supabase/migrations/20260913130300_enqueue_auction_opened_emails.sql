-- FR-003: when a piece goes up for auction, every collector who liked it hears
-- about it -- unless they have turned auction notifications off.
--
-- The rows are written here, in the database, rather than from
-- `src/app/actions/auctions.ts`. Three reasons, in descending order of how much
-- they matter.
--
--   * **Every path that creates an auction is covered.** `create_auction`
--     (20260911120000_add_auctions.sql:73-137) is the only way an `auctions`
--     row comes into existence today, but "today" is doing work in that
--     sentence; an `after insert` trigger is true of any future path, including
--     a direct psql one. The same argument 20260913120000 made for putting the
--     close enqueue on a trigger rather than inside `close_due_auctions`.
--   * **S-06 widens the recipient query underneath a gate it cannot bypass.**
--     FR-004 adds taste-matched collectors to this same set. If the preference
--     check sat in the Server Action, S-06 would add a second recipient source
--     and §Guardrails' "off means off -- from any path" would have two places
--     to fail. Inside this function there is one join, and a new source has to
--     pass through it.
--   * **It rides the auction's own transaction.** No `after()`, no second
--     round trip, and no window in which an auction exists but its
--     notifications do not. The insert is cheap -- one index scan on
--     `interactions_artwork_id_idx` and a hash join -- and nothing in it can
--     raise, so it cannot take a listing down with it.
--
-- **The gate is a join condition, not a post-send check.** A collector who has
-- turned notifications off produces NO row. Not a row that fails to send, not a
-- row the drain skips: no row. `email_outbox` and `email_sends` both store
-- plaintext addresses (20260913120000, 20260912140000), so enqueueing and then
-- failing would write a refused recipient's address into two tables on account
-- of a message they declined -- which is the precise thing FR-005 exists to
-- prevent. `notification_preferences` is LEFT joined and a missing row reads as
-- enabled, which is the rule that table's own comment states and warns against
-- "fixing" in one place only.
--
-- **Addresses come from `auth.users`, never `profiles.email`.** That column is
-- written once by `handle_new_user` and never synced
-- (20260909144939_add_user.sql:32-49), so it can name an address the user has
-- since abandoned. Reading the `auth` schema is why this function is
-- `security definer`; `set search_path = ''` and fully-qualified names
-- throughout, as every definer function in this schema is.
--
-- **A missing address skips the row rather than inserting one**, exactly as
-- `enqueue_close_emails` does: a coalesce-and-insert would queue a row the
-- drain can never send, burning an attempt every tick until the ceiling.
--
-- **The seller is excluded even if they liked their own piece.** FR-003 names
-- likers; the artist listing the work already knows it is listed, and the body
-- ("A piece you liked on ArtSwipe is up for auction") would read as nonsense to
-- them. Nothing stops an artist liking their own artwork -- `swipe_deck` hides
-- it from the deck but `interactions` has no such constraint -- so this is a
-- real case, not a defensive one.
--
-- **The token decision this migration records** (foreshadowed by
-- 20260913130200): the payload carries the recipient's **user id**, and the
-- unsubscribe link is minted in Node at render time by
-- `src/lib/email/links.ts`. `UNSUBSCRIBE_TOKEN_SECRET` can mint a valid token
-- for any user forever, so it stays in the Node process -- never sent to
-- Postgres, never put in the Vault, and never over `pg_net`, whose
-- `net.http_request_queue` grants `PUBLIC` every privilege (AGENTS.md; see
-- 20260913120300). Minting here with `pgcrypto` over a vault-held key is
-- therefore foreclosed. The user id discloses nothing new: `claim_pending_emails`
-- already hands the drain this person's address, so their id beside it adds no
-- reader.
--
-- **No backfill.** Auctions already open when this migration runs get no rows.
-- Their likers were never promised a message, and mailing them now -- about a
-- listing that may close in an hour -- would be worse than silence. The same
-- choice, for the same reason, that 20260913120000 made for closes.
create function public.enqueue_auction_opened_emails()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  -- Read the same way `enqueue_close_emails` reads it
  -- (20260913120000_add_email_outbox.sql), so both mail paths agree on how a
  -- piece is named. `artworks.title` is `not null` and 1-120 characters
  -- (20260909160100_add_artworks.sql:8,15), and `auctions.artwork_id` is a
  -- `not null` FK, so this always finds a row.
  select a.title
    into v_title
    from public.artworks a
   where a.id = new.artwork_id;

  insert into public.email_outbox (auction_id, recipient_email, kind, payload)
  select
    new.id,
    u.email,
    'auction_opened',
    -- The shape `auctionOpenedPayloadSchema` enforces
    -- (`src/lib/email/templates.ts`), and nothing else. That schema is
    -- `z.strictObject`, so a sixth key added here without a matching field
    -- there makes every row unrenderable rather than rendering a body that
    -- quietly dropped it -- which is the point. This message reaches a
    -- collector who has not bid and may never bid, so nothing about anyone's
    -- bidding may travel with it: no amount offered, no bid count, no bidder.
    -- `starting_price_cents` is the seller's own asking figure and the only
    -- currency value permitted here.
    --
    -- `ends_at` goes in as a timestamptz, which `to_json` always renders as ISO
    -- 8601 with an offset regardless of DateStyle -- the form the payload
    -- schema requires and `formatClosing` re-renders in UTC for the reader.
    jsonb_build_object(
      'artwork_title', v_title,
      'starting_price_cents', new.starting_price_cents,
      'ends_at', new.ends_at,
      'auction_id', new.id,
      'recipient_id', i.user_id
    )
  from public.interactions i
  join auth.users u on u.id = i.user_id
  -- LEFT, and `coalesce(..., true)` below: most users have no row at all.
  -- An inner join here would silently notify nobody but the handful of people
  -- who have visited their account page, which is the failure
  -- `notification_preferences`' table comment warns about from the other side.
  left join public.notification_preferences p on p.user_id = i.user_id
  where i.artwork_id = new.artwork_id
    and i.action = 'like'
    -- The consent gate. FR-005, expressed as an absence of rows.
    and coalesce(p.auction_emails_enabled, true)
    -- FR-003 names likers, and the seller is not one of them.
    and i.user_id <> new.seller_id
    and u.email is not null
    and u.email <> '';

  return new;
end;
$$;

-- A trigger function needs no execute grant, and a new function in `public` is
-- born granted to everyone -- config.toml leaves `auto_expose_new_tables` at
-- the cloud default. Mirrors `enqueue_close_emails` (20260913120000) and
-- `handle_new_user` (20260909144939_add_user.sql:45).
revoke execute on function public.enqueue_auction_opened_emails()
  from public, anon, authenticated, service_role;

-- `after insert`, with no `when` clause: an `auctions` row is inserted exactly
-- once and never re-inserted, so the exactly-once guarantee is the insert
-- itself. (The close trigger needs a `when` because an update can repeat; this
-- one cannot.) A cancelled auction is not a case here either -- `cancelled_at`
-- is always null at insert time, and `cancel_auction` is an update this trigger
-- does not watch.
create trigger auctions_enqueue_auction_opened_emails
  after insert on public.auctions
  for each row
  execute function public.enqueue_auction_opened_emails();
