-- One row per (user, artwork) verdict. This is the raw material the taste
-- profile and recommendation engine are built from later.

create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  artwork_id uuid not null references public.artworks (id) on delete cascade,
  action text not null check (action in ('like', 'skip')),
  created_at timestamptz not null default now(),

  -- Makes the swipe write an idempotent upsert: re-rating a piece overwrites
  -- the verdict instead of erroring or double-counting.
  unique (user_id, artwork_id)
);

-- The liked list filters on both columns together.
create index interactions_user_action_idx on public.interactions (user_id, action);

-- Foreign key, not covered by the unique index's leading column.
create index interactions_artwork_id_idx on public.interactions (artwork_id);

alter table public.interactions enable row level security;

create policy "Users can read their own interactions"
  on public.interactions for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can record their own interactions"
  on public.interactions for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can change their own interactions"
  on public.interactions for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own interactions"
  on public.interactions for delete
  to authenticated
  using ((select auth.uid()) = user_id);

-- The deck: artworks the caller has not rated yet, excluding their own work.
-- PostgREST cannot express the anti-join in one request, so it lives here.
--
-- security INVOKER, deliberately: RLS on both tables stays in force, so this
-- function grants no access the caller does not already have.
create function public.swipe_deck(p_limit int default 20)
returns setof public.artworks
language sql
stable
security invoker
set search_path = ''
as $$
  select a.*
  from public.artworks a
  where a.artist_id <> (select auth.uid())
    and not exists (
      select 1
      from public.interactions i
      where i.artwork_id = a.id
        and i.user_id = (select auth.uid())
    )
  order by a.created_at desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function public.swipe_deck(int) from public, anon;
grant execute on function public.swipe_deck(int) to authenticated;
