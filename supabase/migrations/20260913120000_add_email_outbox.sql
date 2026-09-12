-- The outbox: what the close decided each person should be told, held until
-- something outside Postgres can actually send it.
--
-- S-04 has to bridge two halves that cannot reach each other. `close_due_auctions`
-- runs under pg_cron and is granted to nobody
-- (20260912120000_add_auction_close.sql:129-132); `sendEmail` lives in Node and
-- is the only code in the repo that talks to a mail provider. A
-- database-triggered close cannot call Node, so the close writes rows here and a
-- drain running in Node takes them away. This migration is the whole database
-- half: the table, the trigger that fills it, and the two operations the drain
-- is allowed to perform.
--
-- Three choices below are load-bearing.
--
--   * **No policies at all.** RLS is enabled and nothing follows it, so the
--     table is invisible and unwritable from every Supabase client -- the same
--     "the absence is the access control" posture `close_due_auctions`
--     (20260912120000_add_auction_close.sql:129-132) and `email_sends`
--     (20260912140000_add_email_sends.sql:64-67) already take. It matters more
--     here than in either of those: every row holds a plaintext email address,
--     including a *counterparty's*. `profiles` has withheld `email` from every
--     client since 20260909160400_public_artist_profiles.sql by revoking the
--     column grant, and a readable policy on this table would hand back exactly
--     what that revoke took away -- to anyone, not just to the two people
--     FR-009 means to introduce.
--   * **The addresses are resolved at enqueue time and stored on the row.**
--     That is what lets the drain hold a credential that buys two operations
--     rather than one that can read addresses for its own sake.
--   * **`payload` is jsonb, not columns.** The project otherwise prefers
--     columns, and this is the deliberate exception: the four `kind` variants
--     genuinely differ in what they carry, and the difference is the access
--     control (see the trigger below). Modelling them as nullable columns would
--     make "an `auction_lost` row has no counterparty" a convention rather than
--     a fact about the row.

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid references public.auctions (id) on delete cascade,
  recipient_email text not null,
  kind text not null check (
    kind in ('auction_won', 'auction_sold', 'auction_lost', 'auction_unsold')
  ),
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'sent', 'failed')
  ),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.email_outbox is
  'One row per intended message. Written only by enqueue_close_emails, read and updated only through claim_pending_emails / mark_email_sent. RLS is on with no policies: the omission is the access control, and it is what keeps plaintext addresses off every client.';

comment on column public.email_outbox.auction_id is
  'What this message is about, for the operator tracing a row back to its cause. The drain never reads it -- everything a message needs is in recipient_email, kind and payload, which is what lets the drain hold a credential that cannot look anything up.';

comment on column public.email_outbox.recipient_email is
  'Resolved from auth.users.email at enqueue time, never from profiles.email -- that column is written once by handle_new_user and never synced (20260909144939_add_user.sql:32-49), so it can name an address the user has since abandoned. A wrong address here is a wrong disclosure.';

comment on column public.email_outbox.payload is
  'Everything the message needs beyond the recipient, per kind. jsonb because the four variants differ in what they may contain -- an auction_lost payload has no amount and no counterparty at all.';

comment on column public.email_outbox.attempts is
  'Incremented by claim_pending_emails on every row it hands out, before any send is attempted. A row whose write-back is lost is therefore bounded rather than retried forever: past the ceiling it stays pending-but-exhausted and shows up in the operator query.';

-- Pending rows stay near-empty while sent rows accumulate forever -- the same
-- asymmetry `auctions_due_close_idx` describes
-- (20260912120000_add_auction_close.sql:32-38), and the same answer.
create index email_outbox_pending_idx
  on public.email_outbox (created_at)
  where status = 'pending';

alter table public.email_outbox enable row level security;

-- Deliberately no policies after this -- see the header. RLS with an empty
-- policy set denies every select, insert, update and delete from `anon` and
-- `authenticated` alike, which leaves the definer functions below and a direct
-- postgres connection as the only ways in.

-- The enqueue: filling the outbox as a side effect of the close.
--
-- `close_due_auctions` is deliberately untouched. The research this slice
-- inherits assumed the enqueue would ride inside its `update ... from winners w`
-- statement; a trigger gets the same guarantee from the same proven property
-- without editing a function the integration lane already pins, and covers
-- every close path including a direct psql one.
--
-- **Exactly-once comes from the `when` clause, and rests on a proven fact.**
-- `closed_at` is written once and never moves: `close_due_auctions` only ever
-- considers rows `where closed_at is null`, and
-- test/integration/auction-close.int.ts:339-352 asserts a second sweep leaves it
-- untouched -- with a comment naming this slice as the reason it bothers. So the
-- null -> not-null transition happens at most once per auction, and so does this
-- trigger.
--
-- **Addresses come from `auth.users`, not `profiles`.** See the column comment
-- on `recipient_email`. Reading a table in the `auth` schema is why this
-- function is `security definer`; `set search_path = ''` and fully-qualified
-- names throughout, as every definer function in this schema does.
--
-- **A missing address skips the row rather than inserting one.** A
-- coalesce-and-insert would produce a row the drain can never send, failing
-- every tick until the ceiling. The same applies to the counterparty address on
-- the two contact-exchange kinds: a `won`/`sold` message whose entire purpose is
-- to name the other party cannot be composed without it, so the row is not
-- written at all rather than written half-useful.
--
-- **The loser set is defined by bid id, not by amount.** A tie at the winning
-- amount is resolved by `updated_at`/`id` in the close (FR-008), and the bidder
-- who lost that tie is still a loser. `is distinct from` rather than `<>`
-- because it reads the same in the null case, even though this branch only runs
-- when `winning_bid_id` is not null.
--
-- **No backfill.** Auctions already closed when this migration runs get no
-- rows. 20260912120000_add_auction_close.sql:233-242 backfilled on purpose and
-- said why; the opposite choice deserves the same treatment. Those auctions
-- predate the feature, their participants were never promised a message, and
-- mailing them now -- possibly weeks late, possibly about a sale already
-- settled -- would be wrong.
create function public.enqueue_close_emails()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_title text;
  v_seller_email text;
  v_winner_id uuid;
  v_winner_email text;
begin
  select a.title
    into v_title
    from public.artworks a
   where a.id = new.artwork_id;

  select u.email
    into v_seller_email
    from auth.users u
   where u.id = new.seller_id;

  -- Nobody bid. FR-010's Socrates note settles the framing this row is
  -- eventually rendered with: a closing notice with the piece free to relist,
  -- not a failure report. Nothing here carries an amount or a counterparty
  -- because there is neither.
  if new.winning_bid_id is null then
    if v_seller_email is not null and v_seller_email <> '' then
      insert into public.email_outbox (auction_id, recipient_email, kind, payload)
      values (
        new.id,
        v_seller_email,
        'auction_unsold',
        jsonb_build_object('artwork_title', v_title)
      );
    end if;

    return new;
  end if;

  select b.bidder_id
    into v_winner_id
    from public.bids b
   where b.id = new.winning_bid_id;

  select u.email
    into v_winner_email
    from auth.users u
   where u.id = v_winner_id;

  if v_seller_email = '' then
    v_seller_email := null;
  end if;

  if v_winner_email = '' then
    v_winner_email := null;
  end if;

  -- The contact exchange, both directions. Each row needs its own recipient's
  -- address *and* the other party's, so both are guarded together.
  if v_seller_email is not null and v_winner_email is not null then
    insert into public.email_outbox (auction_id, recipient_email, kind, payload)
    values
      (
        new.id,
        v_seller_email,
        'auction_sold',
        jsonb_build_object(
          'artwork_title', v_title,
          'amount_cents', new.winning_amount_cents,
          'counterparty_email', v_winner_email
        )
      ),
      (
        new.id,
        v_winner_email,
        'auction_won',
        jsonb_build_object(
          'artwork_title', v_title,
          'amount_cents', new.winning_amount_cents,
          'counterparty_email', v_seller_email
        )
      );
  end if;

  -- Everyone else who bid. No amount, no counterparty, no bid count -- the
  -- §Access Control boundary, expressed as an absence in the payload so no
  -- later template can render what was never stored.
  insert into public.email_outbox (auction_id, recipient_email, kind, payload)
  select
    new.id,
    u.email,
    'auction_lost',
    jsonb_build_object('artwork_title', v_title)
  from public.bids b
  join auth.users u on u.id = b.bidder_id
  where b.auction_id = new.id
    and b.id is distinct from new.winning_bid_id
    and u.email is not null
    and u.email <> '';

  return new;
end;
$$;

-- A trigger function needs no execute grant, and a new function in `public` is
-- born granted to everyone -- config.toml leaves `auto_expose_new_tables` at the
-- cloud default. Mirrors `handle_new_user` (20260909144939_add_user.sql:45).
revoke execute on function public.enqueue_close_emails()
  from public, anon, authenticated, service_role;

create trigger auctions_enqueue_close_emails
  after update of closed_at on public.auctions
  for each row
  when (old.closed_at is null and new.closed_at is not null)
  execute function public.enqueue_close_emails();

-- The drain's credential.
--
-- The drain POST carries no session at all: pg_net calls a route handler, which
-- builds a Supabase client from the publishable key and is therefore `anon`. So
-- the secret argument is the access control, not the role -- a caller holding
-- the publishable key (which is public by design) but not the secret gets an
-- exception rather than a row.
--
-- The value is read from Supabase Vault by a fixed name rather than baked into
-- this migration, which keeps it out of the repo and out of the cron job
-- definition. `supabase_vault` is already installed on both the local stack and
-- the linked project.
--
-- A missing or empty vault entry **raises**. Returning false would be the same
-- outcome for a wrong secret, but the operator needs to tell "someone called
-- with the wrong token" apart from "this environment was never configured" --
-- and an unconfigured environment must never be mistaken for an open one.
--
-- Granted to nobody: it is called only by the two functions below, which run as
-- `postgres` and therefore own it. Exposing it would hand out an oracle to
-- brute-force against.
create function public.verify_drain_secret(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_expected text;
begin
  select s.decrypted_secret
    into v_expected
    from vault.decrypted_secrets s
   where s.name = 'email_drain_secret';

  if v_expected is null or v_expected = '' then
    raise exception 'the email drain secret is not configured in the vault'
      using errcode = 'EML00';
  end if;

  return p_secret is not null and p_secret = v_expected;
end;
$$;

revoke execute on function public.verify_drain_secret(text)
  from public, anon, authenticated, service_role;

-- Take pending work.
--
-- `attempts` is incremented on every row handed out, *before* any send is
-- attempted, so a drain that dies mid-batch cannot cause an unbounded resend
-- loop. `for update skip locked` is the same lock `close_due_auctions` and
-- `place_bid` take, for the same reason: two overlapping drains degrade into two
-- smaller batches rather than mailing the same person twice.
--
-- The ceiling starts at **one**: a row is claimed once and never again. That is
-- deliberate ordering, not a permanent choice -- Phase 2 raises it with a
-- `create or replace` once a single-attempt drain has been observed working end
-- to end. A retry loop layered onto an unproven drain can mail the same person
-- repeatedly, and `onboarding@resend.dev` delivers only to the developer's own
-- inbox, so the first duplicate lands on whoever is testing -- the good case,
-- but only by luck.
--
-- Rows past the ceiling stay `pending` rather than moving to `failed`: pending
-- is what the operator's "did a message get stuck" query looks for
-- (`select ... where status = 'pending' and created_at < now() - interval '15 minutes'`),
-- and a row nobody will retry is exactly what that query is for.
create function public.claim_pending_emails(
  p_secret text,
  p_limit integer default 50
)
returns table (
  id uuid,
  kind text,
  recipient_email text,
  payload jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.verify_drain_secret(p_secret) then
    raise exception 'invalid drain secret' using errcode = 'EML01';
  end if;

  return query
  with claimed as (
    select o.id
      from public.email_outbox o
     where o.status = 'pending'
       and o.attempts < 1
     order by o.created_at
     limit least(greatest(coalesce(p_limit, 50), 0), 200)
       for update skip locked
  )
  update public.email_outbox o
     set attempts = o.attempts + 1
    from claimed c
   where o.id = c.id
  returning o.id, o.kind, o.recipient_email, o.payload;
end;
$$;

revoke execute on function public.claim_pending_emails(text, integer)
  from public, authenticated, service_role;
grant execute on function public.claim_pending_emails(text, integer) to anon;

-- Report what happened.
--
-- Two writes, one call: the outbox row's outcome, and the `email_sends` ledger
-- row that outlives it. The ledger keeps its single writer -- this calls
-- `public.record_email_send` internally, definer calling definer, rather than
-- the drain calling it over PostgREST. It has to: `record_email_send` is granted
-- to `authenticated` only, and 20260912140000_add_email_sends.sql:81-85 states
-- why `anon` must stay revoked ("a signed-out caller could write ledger rows
-- naming any recipient they liked"). `actor_id` therefore lands null, which is
-- the case that migration documents as *normal* for this slice.
--
-- `recipient` and `kind` are read off the row rather than taken as parameters,
-- so a caller cannot attribute a send to a recipient the row does not name --
-- the same reasoning that keeps `record_email_send` free of an actor parameter.
--
-- A `failed` status is terminal here. The retry the ceiling above bounds is for
-- a *lost write-back*, where this function never ran at all; a send the provider
-- refused is a fact, recorded once, and visible in `email_sends` with its
-- reason.
create function public.mark_email_sent(
  p_secret text,
  p_id uuid,
  p_status text,
  p_reason text default null,
  p_provider_id text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient text;
  v_kind text;
begin
  if not public.verify_drain_secret(p_secret) then
    raise exception 'invalid drain secret' using errcode = 'EML01';
  end if;

  -- The same two-value vocabulary `email_sends.status` checks, verified before
  -- the update so a bad status cannot leave the outbox row in a state the check
  -- constraint on the ledger would then reject.
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'unknown send status: %', p_status using errcode = 'EML02';
  end if;

  update public.email_outbox o
     set status = p_status,
         sent_at = case when p_status = 'sent' then now() else o.sent_at end,
         last_error = case when p_status = 'failed' then p_reason else null end
   where o.id = p_id
  returning o.recipient_email, o.kind
    into v_recipient, v_kind;

  if v_recipient is null then
    raise exception 'no such outbox row: %', p_id using errcode = 'EML03';
  end if;

  perform public.record_email_send(
    v_recipient, v_kind, p_status, p_reason, p_provider_id
  );
end;
$$;

revoke execute on function public.mark_email_sent(text, uuid, text, text, text)
  from public, authenticated, service_role;
grant execute on function public.mark_email_sent(text, uuid, text, text, text) to anon;
