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
  // Excluded: static assets, and /auth/confirm, which does its own cookie
  // exchange via verifyOtp.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|auth/confirm|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
