-- First-run onboarding needs a DB-authoritative signal for a mandatory gate, so
-- the answer cannot be spoofed from the client or inferred from a heuristic.
--
-- A nullable timestamptz rather than a boolean default-false: it answers "when"
-- as well as "whether", and null is the natural "not yet". No default and no
-- backfill — every existing account is deliberately treated as not-onboarded
-- and routed through the flow. A blanket backfill would permanently exclude
-- exactly the accounts this change exists to serve.
alter table public.profiles
  add column onboarded_at timestamptz;

-- Both grants on this table are exhaustive revoke-then-grant statements, so a
-- new column is invisible and unwritable until each is re-issued in full.
-- Re-issuing the whole grant is the established pattern here, not an additive
-- one.

-- The collector stamps this themselves when they finish the flow, so it joins
-- display_name and role on the writable list. The row-level "Users can update
-- their own profile" policy still scopes the write to their own row.
revoke update on public.profiles from authenticated;
grant update (display_name, role, onboarded_at) on public.profiles to authenticated;

-- The select grant is table-wide, so onboarded_at becomes readable on artist
-- profiles too via "Signed-in users can read artist profiles". That is an opaque
-- timestamp with no privacy weight, and narrowing it would mean splitting the
-- grant per policy — not worth it. `email` stays off the list, as before.
revoke select on public.profiles from authenticated;
grant select (id, display_name, role, onboarded_at, created_at, updated_at)
  on public.profiles to authenticated;
