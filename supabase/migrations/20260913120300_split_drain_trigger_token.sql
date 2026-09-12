-- Stop routing the secret that gates the addresses through a table we do not
-- own.
--
-- 20260913120100 has the cron job present `email_drain_secret` as its bearer
-- token, and 20260913120000_add_email_outbox.sql has `verify_drain_secret` read
-- that same entry. One value, two jobs -- which was the neat part, and is the
-- bug: `pg_net` persists the request it is given, headers included, in
-- `net.http_request_queue` until its background worker drains the row.
--
-- That table is not ours to protect. On the Supabase image its ACL is
-- `=arwdDxtm/supabase_admin` -- `PUBLIC` holds every privilege on it, and on
-- `net._http_response` -- and schema `net` carries `=U/supabase_admin` besides.
-- Nor can this project revoke any of it: the grantor is `supabase_admin`,
-- migrations run as `postgres`, and `postgres` is not a member, so every
-- `revoke` returns "no privileges could be revoked" and the grant survives.
-- Verified against a local stack, 2026-09-12.
--
-- So any signed-in user who polls `net.http_request_queue` between the cron
-- firing and the worker draining it reads the bearer token out of `headers`.
-- While that token is also `email_drain_secret`, what they have is the access
-- control for `claim_pending_emails` -- granted to `anon`, because the drain has
-- no session (20260913120000:346-348) -- and one call with the publishable key,
-- which is public by design, returns `recipient_email` and every pending
-- payload's `counterparty_email`. §Access Control permits exactly one new
-- disclosure, between a winner and a seller. That is a different feature.
--
-- **The fix is to make the leaked token worth nothing.** Two entries now:
--
--   `email_drain_trigger_token` -- presented in the header, therefore assumed
--   public. All it can do is ask the route to drain, and a drain sends mail
--   that was already queued to people already entitled to it.
--
--   `email_drain_secret` -- unchanged, still what `verify_drain_secret` reads,
--   and now held only by Postgres and by the app's own environment. It never
--   enters a header, a body, or a URL, so no `pg_net` table ever sees it.
--
-- The route keeps checking the header (`src/app/api/email/drain/route.ts`)
-- because an endpoint anyone can spin costs real sends and real attempts. It is
-- just no longer the same key as the one over the data -- which is what
-- "belt-and-braces, not the security" in that file's docblock was always
-- supposed to mean.
--
-- Three entries on every environment that should drain, then:
--
--   select vault.create_secret('https://…/api/email/drain', 'email_drain_url');
--   select vault.create_secret('<EMAIL_DRAIN_TRIGGER_TOKEN>', 'email_drain_trigger_token');
--   select vault.create_secret('<EMAIL_DRAIN_SECRET>', 'email_drain_secret');
--
-- Scheduling an existing job name replaces it, so this re-registers the same
-- one job rather than adding a second; `supabase db reset` still lands exactly
-- two jobs in total. The guard, the timeout and the rollback are unchanged from
-- 20260913120100 -- see that file for why each is the way it is.
select cron.schedule(
  'drain-email-outbox',
  '* * * * *',
  $$
  select net.http_post(
    url := u.decrypted_secret,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || t.decrypted_secret
    ),
    timeout_milliseconds := 30000
  )
  from vault.decrypted_secrets u
  join vault.decrypted_secrets t on t.name = 'email_drain_trigger_token'
  where u.name = 'email_drain_url'
    and coalesce(u.decrypted_secret, '') <> ''
    and coalesce(t.decrypted_secret, '') <> '';
  $$
);
