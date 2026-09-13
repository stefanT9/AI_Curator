-- Keep exhausted rows out of the index the drain reads every minute.
--
-- `email_outbox_pending_idx` (20260913120000:71-73) covers
-- `(created_at) where status = 'pending'`, which was the right predicate when
-- every failure retired its own row. It is no longer: 20260913120400 leaves a
-- transiently-failed row `pending` so the next tick retries it, and a row that
-- exhausts the ceiling stays `pending` for good, because pending is what the
-- operator's "stuck for fifteen minutes" query looks for.
--
-- So exhausted rows accumulate in the index, and being the oldest they sort to
-- the head of `claim_pending_emails`' `order by created_at` — re-read and
-- discarded on every claim, every minute, forever, before the scan can reach
-- any live work.
--
-- The predicate now matches the claim's own `where` exactly. That does couple
-- the index to the ceiling literal: raise `attempts < 3` in the function and
-- this index silently stops covering the new range. The alternative considered
-- was a fourth `status` value, `abandoned`, which would carry the exhausted
-- rows out of `pending` on its own and read better in the operator query --
-- rejected for now only because it moves rows out of the state that query is
-- written against, which is a bigger change than this one. If the ceiling moves
-- again, revisit that rather than bumping the literal here.
--
-- Built concurrently would be the production-safe form, but `create index
-- concurrently` cannot run inside a transaction block and migrations do. The
-- table is small enough for this to be uncontended: only exhausted and in-
-- flight rows are `pending` at any moment.
drop index if exists public.email_outbox_pending_idx;

create index email_outbox_pending_idx
  on public.email_outbox (created_at)
  where status = 'pending' and attempts < 3;

comment on index public.email_outbox_pending_idx is
  'Covers claim_pending_emails'' exact where clause. Rows past the attempt '
  'ceiling stay `pending` for the operator query but drop out of here, so they '
  'stop being rescanned every minute. Keep the `attempts` bound in step with '
  'the function (20260913120200, 20260913120400).';

-- While here: `email_sends.reason` has carried a seventh value since the drain
-- shipped, and its comment never said so. `src/lib/email/outbox.ts` writes
-- `unrenderable` when a payload cannot be composed -- which is not a
-- `SendFailure` at all, because the message was never offered to a provider.
-- The distinction is the point ("Resend refused it" and "we could not render
-- it" want different fixes), so the column that records it should name it.
comment on column public.email_sends.reason is
  'Why a send did not succeed, when status is ''failed''. Usually a SendFailure variant -- one of '
  'unconfigured, not_permitted, invalid_recipient, rate_limited, unavailable, timeout. Also '
  '''unrenderable'', written by the outbox drain when a payload could not be composed and so was '
  'never offered to a provider at all. Null on success.';
