-- The write behind the unauthenticated unsubscribe link.
--
-- Phase 1's policies on `notification_preferences` are all `to authenticated`
-- and all scoped to `auth.uid()`. A recipient clicking a link in their inbox has
-- no session at all, so none of them apply: the anon key cannot satisfy an
-- own-row check when there is no own row to be had. This function is the only
-- way that caller can write, and it exists for exactly that gap.
--
-- **Why it takes a secret.** The obvious shape -- a definer function taking a
-- user id, granted to `anon` -- is a mute-anyone endpoint: this project
-- deliberately holds no service-role key, so `anon` is the only role the route
-- can present, and anything `anon` may call, the public may call. The
-- entitlement therefore has to come from something the caller proves rather than
-- from the role it holds. Node verifies the HMAC in
-- `src/lib/email/unsubscribe.ts` and then presents `p_secret`, which is checked
-- here against the Vault. Both halves are required: without the first anyone
-- could name any user, without the second anyone could call this at all.
--
-- **The signing secret is NOT this secret, and never comes near SQL.** The HMAC
-- key can mint a link for any user forever, so it stays in the Node process and
-- is never sent anywhere. `unsubscribe_rpc_secret` only buys the right to flip a
-- preference for a user the caller has already proven it holds a token for. Same
-- split, and the same reasoning, as `EMAIL_DRAIN_TRIGGER_TOKEN` versus
-- `EMAIL_DRAIN_SECRET` in 20260913120300_split_drain_trigger_token.sql.
--
-- **Nothing here goes over `pg_net`.** The rule recorded in AGENTS.md binds any
-- future caller: `net.http_request_queue` grants `PUBLIC` every privilege and
-- this project cannot revoke it, so nothing that gates data access may travel
-- over that hop. This function is called over HTTPS from the app, not from
-- Postgres, and neither of its secrets has any business in a `pg_net` request.

create function public.verify_unsubscribe_secret(p_secret text)
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
   where s.name = 'unsubscribe_rpc_secret';

  -- Raise rather than return false, so an operator can tell "this environment
  -- was never configured" from "the two values have drifted apart". Same
  -- distinction `verify_drain_secret` draws, and the same reason: the only
  -- other symptom is a link that silently does nothing.
  if v_expected is null or v_expected = '' then
    raise exception 'the unsubscribe secret is not configured in the vault'
      using errcode = 'UNS00';
  end if;

  return p_secret is not null and p_secret = v_expected;
end;
$$;

revoke execute on function public.verify_unsubscribe_secret(text)
  from public, anon, authenticated, service_role;

-- Set one user's auction-email preference on their behalf.
--
-- Upsert rather than update: under the absent-row rule most users have no row
-- until the first time this or the account page touches one, and an update that
-- matched nothing would report success while changing nothing -- the worst
-- possible outcome for an off switch.
--
-- Takes `p_enabled` rather than hard-coding false so the confirmation page can
-- offer re-subscribe over the same proven token. A link that can only ever turn
-- something off is a link that punishes a misclick.
create function public.set_auction_emails_enabled(
  p_user_id uuid,
  p_enabled boolean,
  p_secret text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.verify_unsubscribe_secret(p_secret) then
    raise exception 'invalid unsubscribe secret' using errcode = 'UNS01';
  end if;

  insert into public.notification_preferences (
    user_id, auction_emails_enabled, updated_at
  )
  values (p_user_id, p_enabled, now())
  on conflict (user_id) do update
    set auction_emails_enabled = excluded.auction_emails_enabled,
        updated_at = now();
end;
$$;

-- `anon` is the point: the caller has no session. The revoke is not optional --
-- config.toml leaves `auto_expose_new_tables` at the cloud default, so a new
-- function in `public` is born executable by everyone, and the grant below is
-- what makes that set deliberate rather than inherited.
--
-- `authenticated` is granted too because a recipient may well be signed in when
-- they click the link, and the route presents the same sessionless client
-- either way. It buys them nothing they could not already do through the
-- Phase 1 policies on their own row.
revoke execute on function public.set_auction_emails_enabled(uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_auction_emails_enabled(uuid, boolean, text)
  to anon, authenticated;
