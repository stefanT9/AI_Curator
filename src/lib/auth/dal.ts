import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import type { UserRole } from "@/types/domain";

export type AuthUser = {
  id: string;
  email: string | null;
};

export type UserProfile = AuthUser & {
  displayName: string | null;
  role: UserRole;
};

/**
 * The secure auth check. The proxy's redirect is an optimistic check only —
 * every server component, action or route handler that touches user data must
 * go through here.
 *
 * `getClaims` verifies the JWT signature against the project's public keys
 * rather than trusting the cookie. Never use `getSession` on the server.
 *
 * Cached for the render pass so a page and its layout share one verification.
 */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims?.sub) {
    return null;
  }

  // Return a narrow DTO, not the raw claims — user_metadata in particular is
  // user-editable and must never reach an authorization decision.
  return {
    id: data.claims.sub,
    email: data.claims.email ?? null,
  };
});

export const requireUser = async (): Promise<AuthUser> => {
  const user = await getAuthUser();

  if (!user) {
    redirect("/login");
  }

  return user;
};

/**
 * The role comes from `public.profiles`, never from the JWT. Same reasoning as
 * the DTO above: anything the user can edit about themselves — `user_metadata`
 * included — cannot be the input to an authorization decision. The database is
 * the only place `role` is authoritative, and RLS enforces it a second time.
 *
 * Cached alongside `getAuthUser`, so a layout and its page share one round trip.
 */
export const getProfile = cache(async (): Promise<UserProfile | null> => {
  const user = await getAuthUser();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  if (error || !data) {
    return null;
  }

  return {
    ...user,
    displayName: data.display_name,
    role: data.role,
  };
});

export const requireProfile = async (): Promise<UserProfile> => {
  const profile = await getProfile();

  if (!profile) {
    redirect("/login");
  }

  return profile;
};

/** Gate for the artist flow. Collectors are sent to the opt-in page. */
export const requireArtist = async (): Promise<UserProfile> => {
  const profile = await requireProfile();

  if (profile.role !== "artist") {
    redirect("/account");
  }

  return profile;
};
