import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Reachable signed out. Everything else redirects to /login. */
const PUBLIC_PATHS = ["/", "/login"];

/** Pointless once signed in — bounce these to the app. */
const SIGNED_OUT_ONLY_PATHS = ["/login", "/signup"];

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

  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
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
