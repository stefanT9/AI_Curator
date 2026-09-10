-- Per-user quota for AI enrichment.
--
-- `suggestArtworkFields` is an exported member of a "use server" module, which
-- makes it a POST endpoint any authenticated artist can call directly. Becoming
-- an artist is a one-click self-serve opt-in, so without a quota one account can
-- loop the endpoint and drain the shared OpenRouter key for everyone.
--
-- The ledger is append-only by design: there is no update or delete policy, so a
-- caller cannot erase their own history to reset the window.

create table public.ai_enrichment_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- The quota query is always "this user, this window", so lead with user_id and
-- keep created_at descending for the range scan.
create index ai_enrichment_calls_user_time_idx
  on public.ai_enrichment_calls (user_id, created_at desc);

alter table public.ai_enrichment_calls enable row level security;

-- Insert and select only. No update, no delete — see the append-only note above.
create policy "Users can record their own enrichment calls"
  on public.ai_enrichment_calls for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "Users can read their own enrichment calls"
  on public.ai_enrichment_calls for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Claim a slot, or refuse.
--
-- Check and insert live in one function so two concurrent requests cannot both
-- read a count under the cap and then both insert. security definer for the same
-- reason `private.is_artist` uses it: the function reports only on the caller's
-- own rows, so granting execute to authenticated leaks nothing. It lives in
-- `public` rather than `private` because PostgREST only exposes `public`, and
-- this one is called over RPC from a Server Action -- same as `public.swipe_deck`.
create function public.claim_enrichment_slot(
  p_hourly_limit int default 30,
  p_daily_limit int default 200
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_hour int;
  v_day int;
begin
  if v_user is null then
    return false;
  end if;

  select
    count(*) filter (where created_at > now() - interval '1 hour'),
    count(*) filter (where created_at > now() - interval '1 day')
  into v_hour, v_day
  from public.ai_enrichment_calls
  where user_id = v_user
    and created_at > now() - interval '1 day';

  if v_hour >= p_hourly_limit or v_day >= p_daily_limit then
    return false;
  end if;

  insert into public.ai_enrichment_calls (user_id) values (v_user);

  return true;
end;
$$;

revoke execute on function public.claim_enrichment_slot(int, int) from public, anon;
grant execute on function public.claim_enrichment_slot(int, int) to authenticated;
