-- ---------------------------------------------------------------------------
-- Ranking evaluation corpus (F-01) — LOCAL DEVELOPMENT DATABASE ONLY.
--
-- This file is NOT a migration. It is applied automatically at the end of
-- `supabase db reset`, after every migration, and runs as superuser so RLS
-- never enters the picture. It must NEVER be run against a linked or
-- production project: it writes directly into `auth.users` / `auth.identities`
-- and seeds accounts that share one weak password.
--
-- Every identifier is a hardcoded UUID and every insert carries
-- `on conflict do nothing`, so the file is safe under `supabase db reset` and
-- safe to re-run by hand against an already-seeded database.
--
-- Workflow (reset + image upload): supabase/seed-assets/README.md
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- Phase 1: Seeded identities
--
-- One artist and two collectors, created as `auth.users` + `auth.identities`
-- pairs. The `on_auth_user_created` trigger produces each `profiles` row from
-- the `auth.users` insert (default role `collector`); the artist's role is
-- promoted afterwards. A password login is resolved through `auth.identities`
-- on `provider = 'email'` — a `auth.users` row alone cannot sign in.
--
-- Shared password for all three: seedpassword
-- ===========================================================================

-- GoTrue scans `confirmation_token`, `recovery_token`, `email_change*`,
-- `phone_change*` and `reauthentication_token` into Go strings and errors on
-- NULL — a user row with NULLs there exists but cannot sign in. Every text
-- token column is therefore written as an empty string, not left to default.
insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token,
  email_change_token_new,
  email_change_token_current,
  email_change,
  phone_change,
  phone_change_token,
  reauthentication_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'seed-artist@artswipe.local',
    crypt('seedpassword', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now(),
    '', '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'seed-collector-warm@artswipe.local',
    crypt('seedpassword', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now(),
    '', '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'seed-collector-cold@artswipe.local',
    crypt('seedpassword', gen_salt('bf')),
    now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now(),
    '', '', '', '', '', '', '', ''
  )
on conflict (id) do nothing;

insert into auth.identities (
  id,
  provider_id,
  user_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
)
values
  (
    gen_random_uuid(),
    'seed-artist@artswipe.local',
    '00000000-0000-4000-8000-000000000001',
    '{"sub": "00000000-0000-4000-8000-000000000001", "email": "seed-artist@artswipe.local", "email_verified": true, "phone_verified": false}'::jsonb,
    'email',
    now(),
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    'seed-collector-warm@artswipe.local',
    '00000000-0000-4000-8000-000000000002',
    '{"sub": "00000000-0000-4000-8000-000000000002", "email": "seed-collector-warm@artswipe.local", "email_verified": true, "phone_verified": false}'::jsonb,
    'email',
    now(),
    now(),
    now()
  ),
  (
    gen_random_uuid(),
    'seed-collector-cold@artswipe.local',
    '00000000-0000-4000-8000-000000000003',
    '{"sub": "00000000-0000-4000-8000-000000000003", "email": "seed-collector-cold@artswipe.local", "email_verified": true, "phone_verified": false}'::jsonb,
    'email',
    now(),
    now(),
    now()
  )
on conflict (provider_id, provider) do nothing;

-- Trigger-created profiles carry only (id, email). Set display names, and
-- promote the artist — the two collectors keep the default `collector` role.
update public.profiles
set display_name = case id
  when '00000000-0000-4000-8000-000000000001' then 'Seed Artist'
  when '00000000-0000-4000-8000-000000000002' then 'Seed Collector (warm)'
  when '00000000-0000-4000-8000-000000000003' then 'Seed Collector (cold)'
end
where id in (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003'
);

update public.profiles
set role = 'artist'
where id = '00000000-0000-4000-8000-000000000001';

-- ===========================================================================
-- Phase 3: Artwork corpus and like history
--
-- 48 tagged artworks in four clusters of twelve, plus six untagged, all owned
-- by the seeded artist. Each cluster points at its own placeholder image
-- (uploaded separately — see supabase/seed-assets/README.md). `oil` is shared
-- between "Warm portraiture" and "Muted landscape" on purpose: it gives a
-- tag-match ordering one overlap case to discriminate rather than four cleanly
-- separated islands. Do not remove it.
--
-- `created_at` is staggered across all 54 rows in round-robin cluster order
-- (with untagged pieces sprinkled through, including near the newest end), so
-- the current newest-first deck ordering is visibly interleaved. A corpus
-- where clusters were contiguous by insertion order would make a broken
-- ranking look like a working one.
--
-- Base instant for the stagger: 2026-01-01 00:00:00+00, plus one hour per
-- global slot. Higher slot = newer = nearer the front of the deck.
--
-- Every title carries its cluster code as a `[N]` prefix — [1] Blue
-- abstraction, [2] Warm portraiture, [3] Muted landscape, [4] Neon street,
-- [U] untagged. The judgment walkthroughs are recorded as sequences of these
-- codes, and reading a deck off four near-identical placeholder images is
-- error-prone; the prefix makes each card self-labelling. It exists for the
-- local evaluation corpus only — no production artwork is titled this way.
-- ===========================================================================

-- Cluster 1 — Blue abstraction: abstract / blue / geometric / minimal
insert into public.artworks (id, artist_id, title, tags, image_path, created_at)
values
  ('b0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '[1] Cobalt Grid',        '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '1 hour'),
  ('b0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '[1] Azure Partition',    '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '5 hour'),
  ('b0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '[1] Prussian Lattice',   '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '10 hour'),
  ('b0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '[1] Indigo Field Study', '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '15 hour'),
  ('b0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '[1] Cerulean Fold',      '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '19 hour'),
  ('b0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '[1] Sapphire Interval',  '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '24 hour'),
  ('b0000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', '[1] Ultramarine Stack',  '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '29 hour'),
  ('b0000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', '[1] Navy Tessellation',  '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '33 hour'),
  ('b0000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', '[1] Cyan Meridian',      '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '38 hour'),
  ('b0000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '[1] Powder Blue Quadrant', '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '43 hour'),
  ('b0000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', '[1] Steel Blue Cadence', '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '47 hour'),
  ('b0000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '[1] Midnight Modulus',   '{abstract,blue,geometric,minimal}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a1.png', timestamptz '2026-01-01 00:00:00+00' + interval '51 hour')
on conflict (id) do nothing;

-- Cluster 2 — Warm portraiture: portrait / figurative / warm / oil
insert into public.artworks (id, artist_id, title, tags, image_path, created_at)
values
  ('c0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '[2] Ochre Portrait of a Stranger', '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '2 hour'),
  ('c0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '[2] Sitter in Amber Light',    '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '6 hour'),
  ('c0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '[2] Terracotta Half-Length',   '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '11 hour'),
  ('c0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '[2] The Reader in Sienna',     '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '16 hour'),
  ('c0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '[2] Portrait with Copper Scarf', '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '20 hour'),
  ('c0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '[2] Study in Warm Flesh Tones', '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '25 hour'),
  ('c0000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', '[2] Woman by a Rust Wall',     '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '30 hour'),
  ('c0000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', '[2] Old Friend in Umber',      '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '34 hour'),
  ('c0000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', '[2] Self-Portrait at Dusk',    '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '39 hour'),
  ('c0000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '[2] Boy with a Marigold',      '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '44 hour'),
  ('c0000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', '[2] Seated Figure, Firelight', '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '48 hour'),
  ('c0000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '[2] Portrait in Burnt Orange', '{portrait,figurative,warm,oil}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a2.png', timestamptz '2026-01-01 00:00:00+00' + interval '52 hour')
on conflict (id) do nothing;

-- Cluster 3 — Muted landscape: landscape / muted / oil / pastoral
insert into public.artworks (id, artist_id, title, tags, image_path, created_at)
values
  ('d0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '[3] Grey Estuary Morning',  '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '3 hour'),
  ('d0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '[3] Fog Over Low Hills',    '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '7 hour'),
  ('d0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '[3] Fallow Field, Overcast', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '12 hour'),
  ('d0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '[3] Distant Rain, Slate Sky', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '17 hour'),
  ('d0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '[3] Hedgerow in Winter',    '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '22 hour'),
  ('d0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '[3] The Drained Marsh',     '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '26 hour'),
  ('d0000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', '[3] Pale Pasture at Noon',  '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '31 hour'),
  ('d0000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', '[3] Chalk Downs Under Cloud', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '36 hour'),
  ('d0000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', '[3] River Bend, Still Water', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '40 hour'),
  ('d0000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '[3] Muted Valley, Late Autumn', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '45 hour'),
  ('d0000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', '[3] Coastal Flats, Grey Light', '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '49 hour'),
  ('d0000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '[3] Moorland, Fading Day',  '{landscape,muted,oil,pastoral}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a3.png', timestamptz '2026-01-01 00:00:00+00' + interval '53 hour')
on conflict (id) do nothing;

-- Cluster 4 — Neon street: street / neon / high-contrast / photography
insert into public.artworks (id, artist_id, title, tags, image_path, created_at)
values
  ('e0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '[4] Rain on Sixth Avenue',          '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '4 hour'),
  ('e0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '[4] Arcade Alley, 2 AM',            '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '9 hour'),
  ('e0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '[4] Signage, Wet Asphalt',          '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '13 hour'),
  ('e0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '[4] Crossing Under Pink Light',     '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '18 hour'),
  ('e0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '[4] Late Bus, Neon Window',         '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '23 hour'),
  ('e0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '[4] Convenience Store Glow',        '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '27 hour'),
  ('e0000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', '[4] Motel Sign, No Vacancy',        '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '32 hour'),
  ('e0000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', '[4] Underpass in Magenta',          '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '37 hour'),
  ('e0000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', '[4] Taxi Rank, Electric Blue',      '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '41 hour'),
  ('e0000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '[4] Night Market Stalls',           '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '46 hour'),
  ('e0000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', '[4] Subway Mouth, Cyan Haze',       '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '50 hour'),
  ('e0000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '[4] Boulevard, Last Light and Neon', '{street,neon,high-contrast,photography}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a4.png', timestamptz '2026-01-01 00:00:00+00' + interval '54 hour')
on conflict (id) do nothing;

-- Untagged — six pieces with no tags, so the cold-start and no-match paths are
-- observable. Sprinkled through the stagger (slots 8, 14, 21, 28, 35, 42), two
-- of which fall inside the newest-20 window.
insert into public.artworks (id, artist_id, title, tags, image_path, created_at)
values
  ('f0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study I', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '8 hour'),
  ('f0000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study II', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '14 hour'),
  ('f0000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study III', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '21 hour'),
  ('f0000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study IV', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '28 hour'),
  ('f0000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study V', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '35 hour'),
  ('f0000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '[U] Untitled Study VI', '{}', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000a0.png', timestamptz '2026-01-01 00:00:00+00' + interval '42 hour')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Like history — warm collector only.
--
-- Eight likes, all inside the Blue abstraction cluster (b…01 through b…08).
-- The remaining four (b…09 through b…0c) are deliberately left unliked so the
-- deck still has unseen Blue abstraction members to serve. The cold collector
-- gets no rows at all — both the ranked and cold-start paths are then
-- observable without a single click.
-- ---------------------------------------------------------------------------
insert into public.interactions (user_id, artwork_id, action)
values
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000003', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000004', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000005', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000006', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000007', 'like'),
  ('00000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000008', 'like')
on conflict (user_id, artwork_id) do nothing;
