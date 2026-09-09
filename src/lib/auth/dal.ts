import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";

export type AuthUser = {
  id: string;
  email: string | null;
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
