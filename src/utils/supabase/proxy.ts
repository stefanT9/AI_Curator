import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import type { Database } from "@/types/database";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Reachable signed out. Everything else redirects to /login. */
const PUBLIC_PATHS = ["/", "/login", "/unsubscribe"];

/** Pointless once signed in — bounce these to the app. */
const SIGNED_OUT_ONLY_PATHS = ["/login", "/signup"];

/**
 * `/unsubscribe` is public because asking someone to sign in before they can
 * stop receiving mail is not an off switch — FR-005 requires the link in a
 * notification to work straight from the inbox. It covers the Server Action's
 * POST as well as the page's GET: an action posts back to the route it was
 * rendered on, so a non-public `/unsubscribe` would 307 the submit to /login
 * with the method preserved and the switch would never flip.
 *
 * The route is safe to expose because it authenticates its own caller — the
 * HMAC token is the credential, and the page itself only renders.
 */
const isPublic = (pathname: string) =>
  PUBLIC_PATHS.includes(pathname) ||
  // Covers /signup and /signup/check-email, which is reached while the new
  // account is still unconfirmed and therefore has no session.
  pathname === "/signup" ||
  pathname.startsWith("/signup/") ||
  pathname.startsWith("/auth/");

export const updateSession = async (request: NextRequest) => {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient<Database>(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // Do not remove: this is what refreshes an expiring token and writes the new
  // cookies back through `setAll`. Server Components cannot set cookies, so
  // without this call here the session silently expires.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);

  const { pathname } = request.nextUrl;

  if (!isSignedIn && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return redirectPreservingCookies(url, supabaseResponse);
  }

  if (isSignedIn && SIGNED_OUT_ONLY_PATHS.includes(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/app";
    url.search = "";
    return redirectPreservingCookies(url, supabaseResponse);
  }

  return supabaseResponse;
};

/**
 * A redirect is a fresh response, so any cookies `setAll` just wrote onto
 * `supabaseResponse` would be dropped. Carry them over or the refreshed
 * session is lost on every redirect.
 */
const redirectPreservingCookies = (url: URL, from: NextResponse) => {
  const response = NextResponse.redirect(url);
  from.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
  return response;
};
