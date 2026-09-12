import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { sendEmail } from "./send";
import { composeCloseEmail } from "./templates";

/**
 * The drain: claim a batch of queued messages, compose them, send them, report
 * what happened.
 *
 * This is the Node half of S-04's bridge. The database half writes
 * `email_outbox` rows as a side effect of the close and cannot call out; this
 * runs in the app and cannot be woken by Postgres on its own, so a per-minute
 * `pg_cron` job POSTs the route handler that calls this.
 *
 * Written as a function over a Supabase client rather than inline in the route
 * handler so the loop is testable without HTTP, and so the same loop could be
 * driven by hand from a script during an incident.
 *
 * **Never throws.** A row that cannot be composed is marked failed with a
 * reason and the batch continues; a claim that errors returns an empty summary.
 * There is nobody to report an exception to — the caller is a fire-and-forget
 * `net.http_post` whose response lands in `net._http_response` and is read by
 * nobody unless an operator goes looking.
 *
 * **The secret is the access control, not the role.** The client handed in here
 * is built from the publishable key and is therefore `anon`; every call below
 * passes `p_secret`, which the definer functions verify against a Vault entry.
 * See 20260913120000_add_email_outbox.sql for why that is the gate.
 */

/**
 * Only the surface this module uses, named the way `./record` names its own.
 * `SupabaseClient<Database>` is what both the route handler's sessionless
 * client and a test double satisfy.
 */
export type OutboxDrainClient = SupabaseClient<Database>;

export type DrainSummary = {
  /** Rows handed out by `claim_pending_emails` — `sent + failed`. */
  claimed: number;
  sent: number;
  failed: number;
};

const EMPTY: DrainSummary = { claimed: 0, sent: 0, failed: 0 };

/**
 * Matches `claim_pending_emails`' own `least(greatest(…), 200)` clamp. Stated
 * here as well so the route handler's Zod bound and the function's ceiling
 * cannot silently disagree.
 */
const DEFAULT_LIMIT = 50;

/**
 * The one value that can land in `email_sends.reason` without being a
 * `SendFailure`. That column's comment (20260912140000_add_email_sends.sql:50)
 * enumerates the six provider outcomes; this is a seventh thing entirely — the
 * message was never offered to a provider at all, because it could not be
 * written. Distinct on purpose: "Resend refused it" and "we could not render
 * it" want different fixes.
 */
const UNRENDERABLE = "unrenderable";

type MarkOutcome =
  { status: "sent"; providerId: string } | { status: "failed"; reason: string };

/**
 * Report one row's outcome, mapping it the way `recordSend` maps a
 * `SendResult`: `p_provider_id` **or** `p_reason`, never both. Both are
 * `default null` in the function, so an omitted argument is the way to say
 * "not applicable" — and the union above makes the wrong pairing unexpressible.
 *
 * `mark_email_sent` writes the `email_sends` ledger row itself, definer calling
 * definer. The TS `recordSend` sidecar is deliberately **not** on this path:
 * `record_email_send` is granted to `authenticated` only and must stay revoked
 * from `anon` (20260912140000_add_email_sends.sql:81-85), and the drain has no
 * session at all.
 */
const markOutcome = async (
  supabase: OutboxDrainClient,
  secret: string,
  id: string,
  outcome: MarkOutcome,
): Promise<void> => {
  await supabase.rpc("mark_email_sent", {
    p_secret: secret,
    p_id: id,
    p_status: outcome.status,
    ...(outcome.status === "sent"
      ? { p_provider_id: outcome.providerId }
      : { p_reason: outcome.reason }),
  });
};

export async function drainOutbox(
  supabase: OutboxDrainClient,
  options: { limit?: number } = {},
): Promise<DrainSummary> {
  // Read lazily, never at module scope: `next build` imports every module and
  // CI has no secret. The same discipline `RESEND_API_KEY` and
  // `OPENROUTER_API_KEY` are held to, for the same reason.
  const secret = process.env.EMAIL_DRAIN_SECRET;

  // An unconfigured environment drains nothing rather than calling with an
  // empty secret, which the definer functions would refuse anyway. The symptom
  // is outbox rows staying pending — which is exactly what the operator's
  // "pending for more than fifteen minutes" query exists to surface.
  if (!secret) return EMPTY;

  const limit = options.limit ?? DEFAULT_LIMIT;

  const { data, error } = await supabase.rpc("claim_pending_emails", {
    p_secret: secret,
    p_limit: limit,
  });

  if (error || !data || data.length === 0) return EMPTY;

  let sent = 0;
  let failed = 0;

  // Sequential, not `Promise.all`. Resend's free tier allows 10 requests a
  // second and a single auction with many losing bidders is one batch; going
  // wide would trade a bounded walk for a burst of `rate_limited` failures.
  // It also keeps `send.ts`'s 8s-per-send budget interpretable against the
  // function's own ceiling.
  for (const row of data) {
    try {
      const message = composeCloseEmail(row.kind, row.payload);

      if (!message) {
        await markOutcome(supabase, secret, row.id, {
          status: "failed",
          reason: UNRENDERABLE,
        });
        failed += 1;
        continue;
      }

      const result = await sendEmail({ to: row.recipient_email, ...message });

      await markOutcome(
        supabase,
        secret,
        row.id,
        result.ok
          ? { status: "sent", providerId: result.id }
          : { status: "failed", reason: result.reason },
      );

      if (result.ok) sent += 1;
      else failed += 1;
    } catch {
      // `sendEmail` never throws and the RPC returns errors rather than
      // throwing, so reaching here means something outside the request path
      // broke. Count it and keep going: the row stays `pending` and is bounded
      // by the attempt ceiling, and the rest of the batch still goes out.
      failed += 1;
    }
  }

  return { claimed: data.length, sent, failed };
}
