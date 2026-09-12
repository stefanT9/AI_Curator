-- Stop treating "we never got to try" as "the provider said no".
--
-- 20260913120000_add_email_outbox.sql:365-368 makes `failed` terminal, and
-- justifies it: "a send the provider refused is a fact, recorded once". That is
-- true, and it is only true of two of the six `SendFailure` variants.
-- `not_permitted` (403, the shared sending domain) and `invalid_recipient` (422)
-- are verdicts about this recipient and will be the same verdict next minute.
--
-- The other four are not verdicts at all. `rate_limited` (429), `unavailable`
-- (5xx and network) and `timeout` are about the moment; `unconfigured` is
-- returned by src/lib/email/send.ts before a request is made at all, because
-- `RESEND_API_KEY` is absent. Marking those terminal means a deploy that
-- reaches production with the key missing or rotated walks the entire queue on
-- its first tick, marks every message `failed`, and loses it: `failed` is
-- excluded from `claim_pending_emails`, so nothing retries, and the operator's
-- "stuck for fifteen minutes" query looks only at `pending`, so nothing reports
-- it either. Silent, total, and recoverable only by hand-written SQL against a
-- table with no policies -- on the slice whose job is telling someone they won.
--
-- **`deferred` is the third outcome.** It writes the ledger row exactly as
-- `failed` does -- the attempt happened and is a fact -- but leaves the outbox
-- row `pending` so the next tick picks it up again. Nothing about the retry is
-- new: `attempts` was already incremented at claim time and the ceiling raised
-- to three by 20260913120200, and that machinery has had nothing to bound until
-- now, because every failure retired its own row before the ceiling could see
-- it.
--
-- Neither check constraint moves. `email_outbox.status` stays
-- (pending, sent, failed) because a deferred row *is* pending, which is the
-- point -- it stays visible to the operator query throughout. `email_sends.status`
-- stays (sent, failed) because the ledger records attempts, and a deferred
-- attempt failed; the reason column already carries which kind of failure it
-- was. So `deferred` is a vocabulary this function accepts, not a state either
-- table stores.
--
-- Which side each variant falls on is decided in TypeScript (src/lib/email/outbox.ts),
-- next to the union that defines them, rather than duplicated here as a list of
-- strings this function would have to be re-migrated to keep in step.
create or replace function public.mark_email_sent(
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

  -- Three values in, two values stored. `deferred` is rejected by neither check
  -- constraint because it never reaches one: it maps to `pending` below and to
  -- `failed` in the ledger.
  if p_status is null or p_status not in ('sent', 'failed', 'deferred') then
    raise exception 'unknown send status: %', p_status using errcode = 'EML02';
  end if;

  -- `and o.status = 'pending'` makes this idempotent. The retry the ceiling
  -- bounds is for a *lost write-back*, where this function never ran -- but
  -- "never ran" and "ran and the caller never heard back" are indistinguishable
  -- from the drain's side, so the second is reachable too, and more reachable
  -- since deferred rows legitimately come back around. Without the guard a
  -- replay writes a second ledger row for one send and can flip a `sent` row to
  -- `failed`. With it, a replay matches nothing and raises EML03 below, which
  -- the drain already swallows per-row.
  update public.email_outbox o
     set status = case when p_status = 'deferred' then 'pending' else p_status end,
         sent_at = case when p_status = 'sent' then now() else o.sent_at end,
         -- Kept on a deferred row rather than cleared: it is why the row is
         -- still here, and it is what an operator reads when the fifteen-minute
         -- query turns it up.
         last_error = case when p_status = 'sent' then null else p_reason end
   where o.id = p_id
     and o.status = 'pending'
  returning o.recipient_email, o.kind
       into v_recipient, v_kind;

  -- Covers both "no such row" and "that row is already settled". The message
  -- says so, because the two want different investigations.
  if v_recipient is null then
    raise exception 'no pending outbox row: %', p_id using errcode = 'EML03';
  end if;

  perform public.record_email_send(
    v_recipient,
    v_kind,
    case when p_status = 'sent' then 'sent' else 'failed' end,
    p_reason,
    p_provider_id
  );
end;
$$;

-- `config.toml` leaves `auto_expose_new_tables` at the cloud default, so a
-- `create or replace` does not re-grant -- but restate it anyway, the way
-- 20260913120200 does, so the grant is visible in the file that last touched
-- the function rather than only in the one that first created it.
revoke execute on function public.mark_email_sent(text, uuid, text, text, text)
  from public, authenticated, service_role;
grant execute on function public.mark_email_sent(text, uuid, text, text, text) to anon;
