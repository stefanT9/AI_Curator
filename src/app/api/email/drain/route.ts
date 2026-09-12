import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import * as z from "zod";
import type { Database } from "@/types/database";
import { drainOutbox } from "@/lib/email/outbox";

/**
 * The one endpoint Postgres can reach.
 *
 * S-04's two halves cannot call each other: the close runs under `pg_cron` and
 * `sendEmail` runs in Node. A per-minute `cron.schedule` calls `net.http_post`
 * against this route (20260913120100_schedule_email_drain.sql), which is the
 * entire bridge. Everything it does is in `drainOutbox`; this file is the door.
 *
 * **This route is excluded from the proxy matcher** (`src/proxy.ts`), alongside
 * `auth/confirm`. Without that, an unauthenticated POST is 307-redirected to
 * `/login` with the method preserved, and the drain fails as a plumbing bug
 * rather than as an auth error. The exclusion is safe precisely because this
 * handler authenticates its own caller and holds no session.
 *
 * **The bearer check here is belt-and-braces, not the security.** The real gate
 * is the `p_secret` argument inside `claim_pending_emails` and
 * `mark_email_sent`: the Supabase client below is built from the publishable
 * key, which is public by design, so the role buys nothing. Someone who removed
 * this check would still get an exception rather than a row. It is here so an
 * unauthenticated caller cannot make the app do work, and so the 401 shows up
 * in `net._http_response` when the two secrets drift apart.
 *
 * **The response body never names a recipient or an address.** `pg_net` stores
 * every response in `net._http_response`, a table with none of `email_outbox`'s
 * policy-free protection — so counts only.
 */

/**
 * `pg_net` sends an empty body by default, so every field is optional. The
 * bound mirrors `claim_pending_emails`' own `least(…, 200)` clamp rather than
 * trusting it.
 */
const bodySchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

/**
 * Compare hashes rather than the secrets themselves: `timingSafeEqual` throws
 * on differing lengths, and catching that throw would leak the length of the
 * real secret through the response. Hashing makes both sides 32 bytes, so the
 * comparison is constant-time over every input.
 */
const secretsMatch = (offered: string, expected: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(offered).digest(),
    createHash("sha256").update(expected).digest(),
  );

const bearer = (header: string | null): string | null => {
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if (scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
};

export async function POST(request: Request) {
  // Read inside the handler, never at module scope — `next build` imports this
  // file and CI has no secret.
  const expected = process.env.EMAIL_DRAIN_SECRET;

  // Unset must not mean open. 503 rather than 401 so an operator reading
  // `net._http_response` can tell "this environment was never configured" from
  // "the two secrets have drifted apart" — the same distinction
  // `verify_drain_secret` raises for rather than returning false.
  if (!expected) {
    return Response.json({ error: "drain_unconfigured" }, { status: 503 });
  }

  const offered = bearer(request.headers.get("authorization"));
  if (!offered || !secretsMatch(offered, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // An absent or unparseable body is the normal case: `net.http_post` with no
  // body at all is what the cron job sends.
  const raw = await request.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  // Not `createClient` from `src/utils/supabase/server.ts`: that one is
  // cookie-aware and there are no cookies here. A sessionless client is exactly
  // right — the drain's authority comes from the secret it passes, not from who
  // it is.
  const supabase = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const summary = await drainOutbox(supabase, { limit: parsed.data.limit });

  return Response.json(summary);
}
