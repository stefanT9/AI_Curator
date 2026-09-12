-- The trigger for the close: a per-minute pg_cron job.
--
-- Separate from 20260912120000_add_auction_close.sql on purpose. The schedule
-- is operational rather than structural -- it may need re-registering on its
-- own, and if `pg_cron` is unavailable in some environment the failure points
-- at this file rather than at the outcome columns.
--
-- Per-minute is the §Guardrails timing decision: an auction has to close
-- close enough to its stated end time that a collector watching the clock is
-- not misled. Vercel Hobby cron was ruled out and cannot be substituted here
-- -- it fires at most once a day, anywhere inside its scheduled hour, which
-- misses that guardrail by orders of magnitude. Do not "simplify" this into a
-- `vercel.ts` cron entry; doing so would need a paid plan and still be worse.
--
-- The lag this schedule leaves is cosmetic, never a late bid: `place_bid`
-- refuses at the exact instant `ends_at` passes, under a row lock, whether or
-- not the sweep has run yet.
--
-- No guard around the extension. An environment without `pg_cron` should fail
-- loudly here rather than quietly end up with no scheduler at all -- which is
-- precisely the "countdown reaches zero and nothing happens" failure this
-- slice exists to prevent. pg_cron is fixed to `pg_catalog` and creates its
-- own `cron` schema; it reads jobs from the database named by
-- `cron.database_name`, which is `postgres` both locally and on the linked
-- project.
create extension if not exists pg_cron;

-- Scheduling an existing job name replaces it, so this migration is
-- re-runnable and `supabase db reset` lands exactly one job. The job runs as
-- the role that schedules it -- `postgres`, which owns `close_due_auctions`
-- and is therefore the only role that can execute it at all.
select cron.schedule(
  'close-due-auctions',
  '* * * * *',
  $$select public.close_due_auctions();$$
);
