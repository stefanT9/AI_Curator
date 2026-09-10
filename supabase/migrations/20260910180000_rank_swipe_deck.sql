-- S-01: order the deck per collector instead of newest-first for everyone.
--
-- Two changes to `swipe_deck`, both inside the function body. The signature,
-- volatility, security context and grants are untouched — `create or replace`
-- preserves the privileges granted in 20260909160200_add_interactions.sql.
--
-- 1. The exclusion predicate narrows from "any interaction" to "a like", so a
--    piece the collector merely skipped comes back instead of disappearing
--    forever. It comes back demoted, not re-mixed with fresh work.
-- 2. The ordering becomes a four-key sort over the collector's own taste.
--
-- Taste is the distinct union of tags across the artworks this collector has
-- liked. Skips are never taste input — only a demotion signal.

create or replace function public.swipe_deck(p_limit int default 20)
returns setof public.artworks
language sql
stable
security invoker
set search_path = ''
as $$
  with taste as (
    -- One row, always: with no likes the aggregate is null, and the coalesce
    -- turns it into an empty array. A null here would make every `= any(...)`
    -- comparison null and collapse the overlap key.
    select coalesce(array_agg(distinct tg), '{}'::text[]) as tags
    from public.interactions i
    join public.artworks liked on liked.id = i.artwork_id
    cross join lateral unnest(liked.tags) as tg
    where i.user_id = (select auth.uid())
      and i.action = 'like'
  )
  select a.*
  from public.artworks a
  cross join taste
  -- Supplies the skip tier. At most one row per artwork: interactions is
  -- unique on (user_id, artwork_id) and this is pinned to one user.
  left join public.interactions i
    on i.artwork_id = a.id
    and i.user_id = (select auth.uid())
  where a.artist_id <> (select auth.uid())
    and not exists (
      select 1
      from public.interactions liked_i
      where liked_i.artwork_id = a.id
        and liked_i.user_id = (select auth.uid())
        and liked_i.action = 'like'
    )
  order by
    -- Tagged first, untagged last. Outermost, so an untagged piece sinks
    -- below even a previously-skipped one.
    (cardinality(a.tags) = 0)::int,
    -- Unseen first, previously-skipped after. The coalesce is load-bearing:
    -- for an unseen artwork the left join leaves `i.action` null, and a bare
    -- `(i.action = 'skip')::int` would be null — which sorts LAST under ASC
    -- and inverts the tier.
    coalesce((i.action = 'skip')::int, 0),
    -- The ranking itself: how many of this piece's tags the collector's taste
    -- already contains. Every tag counts once; no weighting (PRD OQ-1 open).
    (
      select count(*)
      from unnest(a.tags) as tg
      where tg = any (taste.tags)
    ) desc,
    -- The floor. Preserves today's behavior wherever scores tie, which is
    -- every row for a collector with no likes.
    a.created_at desc
  limit least(greatest(p_limit, 1), 50);
$$;
