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
