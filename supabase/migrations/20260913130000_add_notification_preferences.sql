-- The consent half of S-05: a per-user switch for auction notifications.
--
-- FR-005 gives every collector an auction-notification preference, on by
-- default, and the PRD revised FR-003 to depend on it -- "a like was never
-- consent to be emailed". This table is that dependency's storage. Nothing
-- sends yet; the switch exists before anything can be gated by it, so that no
-- code path ever ships that could notify someone who cannot refuse.
--
-- **Why a table rather than a column on `profiles`.** `profiles` carries two
-- select policies: own-row (20260909144939_add_user.sql:15-18) and
-- artist-profiles-readable-by-any-signed-in-user
-- (20260909160400_public_artist_profiles.sql:6-9). The second is scoped by
-- nothing but the column grant. A preference column there would have to join
-- that grant to be readable by its own owner, and joining it would expose the
-- column on every artist row to every signed-in user -- one collector reading
-- another person's notification setting. The same revoke that keeps
-- `profiles.email` private is what makes `profiles` the wrong home. A table
-- with a single own-row policy has no second reader to scope.

create table public.notification_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  auction_emails_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- The rule this table encodes twice, stated once where both halves can see it.
comment on table public.notification_preferences is
  'Optional, at most one row per user. **An absent row means enabled.** There is no backfill and handle_new_user does not write here, so most users will never have a row at all -- the column default and every reading query''s null-handling encode the same rule in two places. A query that left-joins and treats a missing row as opted-out breaks FR-005 silently, for exactly the users who never touched the setting. Do not "fix" either half on its own.';

comment on column public.notification_preferences.auction_emails_enabled is
  'False means the enqueue path must produce NO row for this user -- not a row that fails to send. email_outbox and email_sends both store plaintext addresses, so enqueueing and then failing would write a refused recipient''s address into two tables on account of a message they declined.';

comment on column public.notification_preferences.updated_at is
  'Set by the writer, not by a trigger. Only of interest to an operator asking when somebody opted out; nothing reads it.';

alter table public.notification_preferences enable row level security;

-- Own-row and nothing else. Unlike `profiles`, this table has no second,
-- wider-audience policy -- and it must never grow one. A user's notification
-- setting is not public the way an artist's display name is.
create policy "Users can read their own notification preferences"
  on public.notification_preferences for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own notification preferences"
  on public.notification_preferences for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

-- Both USING and WITH CHECK, as on `profiles`: USING alone would let a user
-- reassign the row's user_id and take over somebody else's preference.
create policy "Users can change their own notification preferences"
  on public.notification_preferences for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- No delete policy, deliberately. Deleting a row means "enabled" under the
-- absent-row rule above, which the update path already expresses -- and a
-- delete grant would let a client clear the row rather than set it to true,
-- reaching the same state by a path nothing else in the schema knows about.
