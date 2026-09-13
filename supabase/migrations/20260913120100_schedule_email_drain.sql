-- The hop: once a minute, tell the app there may be mail to send.
--
-- Separate from 20260913120000_add_email_outbox.sql for the reason
-- 20260912120100_schedule_auction_close.sql gives about its own split: the
-- schedule is operational rather than structural. It may need re-registering on
-- its own, and if an extension is unavailable in some environment the failure
-- points at this file rather than at the outbox and its trigger.
--
-- **Why a set-based drain rather than a Database Webhook.** A webhook is a
-- `for each row` trigger, so an auction with four recipients becomes four
-- POSTs, and a separate retry mechanism would still be needed because `pg_net`
-- does not retry. One per-minute job serves first attempts and retries with the
-- same code, and is set-based like `close_due_auctions` itself.
--
-- **Latency.** This minute stacks on the close sweep's minute, so worst case
-- from `ends_at` to an inbox is about two minutes. That is fine, and it is not
-- the thing §Guardrails' timing requirement is about: that requirement is that
-- *the auction closes* on time, which `place_bid` enforces to the instant under
-- a row lock, whether or not either sweep has run yet.
--
-- **Nothing here can be asserted by a test lane.** `pg_net` is fire-and-forget:
-- `net.http_post` returns a `request_id` immediately and the response lands
-- later in `net._http_response`, collected by a background worker. No lane can
-- observe that without a listener, so this hop is proven by hand, once, against
-- a local stack -- and recorded as such in the plan's manual criteria rather
-- than papered over with a test that only asserts the job row exists.

-- No guard around the extension, the same house style
-- 20260912120100_schedule_auction_close.sql:19-25 states: an environment
-- without `pg_net` should fail loudly here rather than quietly end up with no
-- drain at all, which is a silence indistinguishable from "nobody had any mail".
-- pg_net ships with the Supabase image and creates its own `net` schema.
create extension if not exists pg_net;

-- Both the URL and the bearer token come from Supabase Vault rather than being
-- inlined, which would commit the production hostname and the shared secret to
-- this repository. Two entries, on every environment that should drain:
--
--   select vault.create_secret('https://…/api/email/drain', 'email_drain_url');
--   select vault.create_secret('<the same value as EMAIL_DRAIN_SECRET>', 'email_drain_secret');
--
-- `email_drain_secret` is the same entry `verify_drain_secret` reads
-- (20260913120000_add_email_outbox.sql), so the token this job presents and the
-- token the definer functions check can never drift apart on one environment.
-- The app's `EMAIL_DRAIN_SECRET` is the third copy, and the only one that has
-- to be kept in step by hand.
--
-- The `from … where` is the missing-entry guard: with either secret absent or
-- empty the select matches no rows and no POST is made, rather than posting to
-- null or erroring in the cron log every single minute. An unconfigured
-- environment is inert, and its only symptom is outbox rows staying `pending` --
-- which is exactly what the operator's fifteen-minute query is for.
--
-- Scheduling an existing job name replaces it, so this migration is re-runnable
-- and `supabase db reset` lands exactly one drain job (two in total, with
-- `close-due-auctions`). The job runs as the role that schedules it, `postgres`,
-- which is the only role that can read `vault.decrypted_secrets` at all.
--
-- The timeout is the response collector's budget, not a cap on the work: by the
-- time it expires the request has already been made and the handler is already
-- draining. Thirty seconds is well clear of a full batch of sequential sends at
-- `send.ts`'s 8s ceiling each, so a healthy run still records its 200 in
-- `net._http_response` where the manual check can read it.
select cron.schedule(
  'drain-email-outbox',
  '* * * * *',
  $$
  select net.http_post(
    url := u.decrypted_secret,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || s.decrypted_secret
    ),
    timeout_milliseconds := 30000
  )
  from vault.decrypted_secrets u
  join vault.decrypted_secrets s on s.name = 'email_drain_secret'
  where u.name = 'email_drain_url'
    and coalesce(u.decrypted_secret, '') <> ''
    and coalesce(s.decrypted_secret, '') <> '';
  $$
);

-- Rollback, should the drain ever need stopping without a deploy:
--
--   select cron.unschedule('drain-email-outbox');
--
-- Rows then accumulate as `pending` and nothing is lost. It is independent of
-- `drop trigger auctions_enqueue_close_emails on public.auctions`, which stops
-- the enqueue instead -- either half can be disabled without the other.
