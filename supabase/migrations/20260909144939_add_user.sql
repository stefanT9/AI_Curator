-- Profiles keyed to auth.users, created automatically on signup.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- `to authenticated` alone is authentication without authorization: it checks the
-- role but not which rows. Always pair it with an ownership predicate.
create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

-- Update needs both USING and WITH CHECK, or a user could reassign the row's id.
create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- No insert policy: rows come only from the trigger below.

-- security definer is required here — the auth admin role that inserts into
-- auth.users cannot otherwise write to public.profiles. Keep it locked down:
-- empty search_path, fully-qualified names, and no execute grant to callers.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- The trigger only fires on insert, so anyone who signed up before this
-- migration ran would have no profile. Backfill them.
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;
