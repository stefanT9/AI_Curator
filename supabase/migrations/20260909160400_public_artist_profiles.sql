-- Artist profiles are public: a collector who likes a piece needs to know whose
-- work it is, and artists are here to be found.
--
-- Policies are OR'd, so this sits alongside "Users can read their own profile":
-- you can always see yourself, and you can see anyone who is an artist.
create policy "Signed-in users can read artist profiles"
  on public.profiles for select
  to authenticated
  using (role = 'artist');

-- That policy is row-level, so on its own it would hand out the artist's email
-- along with their name. Column grants are the only thing that scopes a SELECT
-- to specific columns — nothing in the app reads `email` out of this table
-- (the signed-in user's own address comes from their JWT claims).
revoke select on public.profiles from authenticated;
grant select (id, display_name, role, created_at, updated_at)
  on public.profiles to authenticated;
