-- Every account starts as a collector and opts into the artist role later.
-- The role lives here, in the database, and never in the JWT: `user_metadata`
-- is user-editable, so a claim-based role would be self-granted.

create type public.user_role as enum ('collector', 'artist');

alter table public.profiles
  add column role public.user_role not null default 'collector';

-- The column default covers both the handle_new_user trigger and every row that
-- already exists, so there is nothing to backfill.

-- The existing "Users can update their own profile" policy is what lets a user
-- promote themselves — that is the opt-in mechanism. But a policy is row-level,
-- not column-level, so on its own it would also let them rewrite `email` or
-- `id`. Column grants are the missing half.
revoke update on public.profiles from authenticated;
grant update (display_name, role) on public.profiles to authenticated;

-- Helper used by the artworks and storage policies. Kept in a private schema so
-- it is not reachable through PostgREST.
create schema if not exists private;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- security definer so the policy can read profiles without depending on that
-- table's own RLS. It reports only on the caller's own row, so granting execute
-- to authenticated leaks nothing — and a policy cannot call a function the role
-- it applies to has no execute right on.
create function private.is_artist()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'artist'
  );
$$;

revoke execute on function private.is_artist() from public, anon;
grant execute on function private.is_artist() to authenticated;
