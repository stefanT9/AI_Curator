-- Raise the per-artwork tag ceiling from 10 to 20.
--
-- AI enrichment adds generated tags alongside whatever the artist typed. At a
-- ceiling of 10 the two competed for the same slots; 20 lets both coexist —
-- generated suggestions cap at 12, leaving room for the artist's own.
--
-- Widening a CHECK is permissive: every existing row already satisfies the new
-- bound, so Postgres validates it without a table rewrite and no backfill is
-- needed. The constraint keeps its original name so the schema stays
-- self-describing.

alter table public.artworks
  drop constraint artworks_tags_length;

alter table public.artworks
  add constraint artworks_tags_length check (cardinality(tags) <= 20);
