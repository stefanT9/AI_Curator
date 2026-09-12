import type { NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/proxy";

// Next 16 renamed the Middleware file convention to Proxy. This file must sit
// at the same level as `app/`, and the exported function must be named `proxy`.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Runs on every page, including public ones — the proxy is what refreshes
  // expiring tokens, so skipping public routes would let sessions lapse.
  // Excluded: static assets, and the two routes that authenticate their own
  // callers and must not be redirected. /auth/confirm does its own cookie
  // exchange via verifyOtp. /api/email/drain is POSTed by pg_net with a bearer
  // token and no session at all — inside the matcher it would be 307'd to
  // /login with the method preserved, so the drain would fail as a plumbing bug
  // rather than as an auth error.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|auth/confirm|api/email/drain|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
