-- Constrain image_path to the documented pattern: <artist_id>/<random_uuid>.<ext>
-- Added NOT VALID so existing rows can deviate, but all new/updated rows must comply.
-- Validating against production data is a separate, deliberate step.
alter table public.artworks
  add constraint image_path_pattern check (
    image_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp)$'
  ) not valid;
