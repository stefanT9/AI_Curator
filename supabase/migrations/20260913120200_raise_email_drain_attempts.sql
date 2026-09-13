-- Raise the drain's attempt ceiling from one to three.
--
-- 20260913120000_add_email_outbox.sql deliberately shipped `attempts < 1`: a
-- row was claimed once and never again. That was ordering, not a permanent
-- choice, and its comment said so. A retry loop layered onto an unproven drain
-- can mail the same person repeatedly, and `onboarding@resend.dev` delivers
-- only to the developer's own inbox -- so the first duplicate lands on whoever
-- is testing, which is the good case, but only by luck.
--
-- The precondition is now met. A single-attempt drain was observed working end
-- to end against a local stack: a real `close_due_auctions` sweep stamped
-- `closed_at`, the trigger enqueued one row per recipient, the `pg_net` hop
-- POSTed the route handler, and every attempt landed in `email_sends` with its
-- reason -- all inside the same second, with no manual step.
--
-- **What the ceiling actually bounds.** Not a refused send: a provider's
-- refusal moves the row to `failed`, which is terminal, and `claim_pending_emails`
-- only ever considers `status = 'pending'`. The retry exists for a *lost
-- write-back* -- the drain sent (or was refused), then died before
-- `mark_email_sent` committed -- which leaves the row pending with its counter
-- already incremented. Three attempts is two more chances at a write-back that
-- did not land, and a hard stop after that.
--
-- **A duplicate message is reachable, and that is the accepted trade.** If a
-- send succeeded and only the write-back was lost, the next tick sends it
-- again. At-least-once is the right side to err on for a "you won" notice: a
-- second copy is an annoyance, a missing one is the slice failing at its only
-- job.
--
-- Rows past the ceiling stay `pending` rather than moving to `failed`, exactly
-- as before. `pending` is what the operator's "did a message get stuck" query
-- looks for, and a row nobody will retry is precisely what that query is for:
--
--   select id, kind, status, attempts, last_error, created_at
--     from public.email_outbox
--    where status = 'pending' and created_at < now() - interval '15 minutes';
--
-- Everything else about the function is unchanged -- same signature, same
-- return shape, same secret check, same `for update skip locked`. Only the
-- literal moves.
create or replace function public.claim_pending_emails(
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
       and o.attempts < 3
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

-- `create or replace` preserves the existing ACL, so these are a restatement
-- rather than a repair. Restated anyway, because the grant to `anon` is the
-- single most consequential line in this schema and it should be readable in
-- the file that last touched the function, not only in the one that created it.
-- The drain POST carries no session; the secret argument is the access control,
-- not the role.
revoke execute on function public.claim_pending_emails(text, integer)
  from public, authenticated, service_role;
grant execute on function public.claim_pending_emails(text, integer) to anon;
