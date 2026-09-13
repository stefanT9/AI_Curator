-- The send ledger: what this app tried to mail, and what came of it.
--
-- F-02's promise is that a failed send is visible rather than silent, and this
-- table is the whole of that mechanism. `grep -rn "console\." src/` returns
-- zero matches -- the project has no logger and no logging convention to
-- extend -- so one row per attempt is the only record that survives to be
-- asked about afterwards. "Was anyone mailed, and did it work" is a question
-- about history, not about a moment.
--
-- Append-only, like `ai_enrichment_calls`
-- (20260910101500_add_enrichment_quota.sql): there is no update and no delete
-- path from any client, so a caller cannot erase a failure it would rather not
-- have.
--
-- Two choices below are load-bearing and neither is tidiness:
--
--   * **No policies at all.** RLS is enabled and nothing follows it, so the
--     table is invisible and unwritable from every Supabase client and is read
--     over a direct connection -- the "the absence is the access control"
--     posture `close_due_auctions` takes
--     (20260912120000_add_auction_close.sql:129-132). An owner-readable policy
--     would look harmless today and stop being harmless the moment S-05 mails
--     an artist's likers: rows recording a collector's address against the
--     notifying artist's `actor_id` would hand that artist addresses which
--     `profiles.email`'s column grant has withheld from everyone since
--     20260909160400_public_artist_profiles.sql. This is an operational record
--     for the developer, not a user-facing feature.
--   * **`actor_id` is nullable.** A send with no user context is legitimate,
--     and it is the *normal* case for S-04, whose trigger is the per-minute
--     pg_cron close with no session attached at all. `not null` would pass
--     every test written today and break the first real consumer.

create table public.email_sends (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete cascade,
  recipient text not null,
  kind text not null check (char_length(kind) between 1 and 64),
  status text not null check (status in ('sent', 'failed')),
  reason text,
  provider_id text,
  created_at timestamptz not null default now()
);

comment on column public.email_sends.actor_id is
  'Who the send was made on behalf of, or null when there was no session -- a pg_cron-triggered send has none, and the smoke lane calls sendEmail with no user at all. Set by record_email_send from auth.uid(), never by a caller.';

comment on column public.email_sends.kind is
  'What sort of message this was (''auction_closed'', ''artwork_liked'', ...). Free text rather than an enum: a new message type should not need a migration.';

comment on column public.email_sends.reason is
  'The SendFailure variant when status is ''failed'' -- one of unconfigured, not_permitted, invalid_recipient, rate_limited, unavailable, timeout. Null on success.';

comment on column public.email_sends.provider_id is
  'The provider''s message id when status is ''sent'' -- the handle to quote when asking Resend what happened to a message. Null on failure.';

-- The operator's question is always "what failed recently", scanned newest
-- first over the whole table, so lead with created_at descending. There is no
-- per-user query to serve: nobody reads this table through a client.
create index email_sends_recent_idx
  on public.email_sends (created_at desc);

alter table public.email_sends enable row level security;

-- Deliberately no policies after this -- see the header. The omission is the
-- access control: RLS with an empty policy set denies every select, insert,
-- update and delete from `anon` and `authenticated` alike, which leaves the
-- definer function below and a direct postgres connection as the only ways in.

-- The one writer.
--
-- `actor_id` is taken from `(select auth.uid())` inside the function and there
-- is no actor parameter, so a caller cannot attribute a row to somebody else.
-- That is the only reason granting execute to `authenticated` is safe: the
-- call writes a row the caller could not otherwise write, but it can only
-- write it about itself.
--
-- security definer because the table has no insert policy and is never going
-- to get one. `set search_path = ''` and fully-qualified names throughout, as
-- every definer function in this schema does.
--
-- The revoke is not optional: config.toml leaves `auto_expose_new_tables` at
-- the cloud default, so a new function in `public` is born with execute
-- granted to `anon`, `authenticated`, `service_role` and `public`. Without the
-- revoke, a signed-out caller could write ledger rows naming any recipient
-- they liked.
create function public.record_email_send(
  p_recipient text,
  p_kind text,
  p_status text,
  p_reason text default null,
  p_provider_id text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.email_sends (
    actor_id, recipient, kind, status, reason, provider_id
  )
  values (
    (select auth.uid()), p_recipient, p_kind, p_status, p_reason, p_provider_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.record_email_send(text, text, text, text, text)
  from public, anon;
grant execute on function public.record_email_send(text, text, text, text, text)
  to authenticated;
