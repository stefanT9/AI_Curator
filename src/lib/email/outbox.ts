import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { sendEmail, type SendFailure } from "./send";
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
  /** Rows handed out by `claim_pending_emails` — `sent + failed + deferred`. */
  claimed: number;
  sent: number;
  /** Retired: the provider's verdict will not change. */
  failed: number;
  /** Left `pending` for the next tick, bounded by the attempt ceiling. */
  deferred: number;
  /**
   * The SQLSTATE the claim raised, when it raised one — `EML00` for a missing
   * vault entry, `EML01` for a wrong secret. Absent on a healthy run.
   *
   * Here because the three ways a drain can do nothing are not the same thing
   * and the database already tells them apart: `verify_drain_secret` raises
   * rather than returning false precisely so an operator can distinguish "never
   * configured" from "drifted apart" (20260913120000). Collapsing both into the
   * same `{0,0,0}` as an empty queue threw that away, and the only symptom of
   * vault drift would be outbox rows quietly piling up.
   *
   * A code, never a message: the response is stored in `net._http_response`,
   * which has none of `email_outbox`'s policy-free protection, so nothing here
   * may name a recipient or quote provider text.
   */
  claimError?: string;
};

const EMPTY: DrainSummary = { claimed: 0, sent: 0, failed: 0, deferred: 0 };

/**
 * Sized to finish inside one invocation, not to the 200 `claim_pending_emails`
 * would allow: `./send` gives each send an 8s ceiling and the loop below is
 * sequential, so five is ~40s of worst-case sends against the route's
 * `maxDuration` of 60. Fifty would be ~400s, and the platform would kill the
 * run partway — spending an attempt, claimed for the whole batch up front, on
 * every row it never reached.
 *
 * The cost is throughput: an auction with thirty losing bidders takes six ticks
 * to drain rather than one. The cron runs every minute and none of this mail is
 * urgent to the second, so that is the cheaper side of the trade.
 *
 * A caller may still ask for more (the route's Zod bound and the function's own
 * `least(…, 200)` clamp both allow it) — that is for draining a backlog by hand,
 * where there is no function ceiling to respect.
 */
const DEFAULT_LIMIT = 5;

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
  | { status: "sent"; providerId: string }
  | { status: "failed"; reason: string }
  | { status: "deferred"; reason: string };

/**
 * The two `SendFailure` variants that are verdicts about this recipient rather
 * than about this moment: 403 on the shared sending domain, and 422 on the
 * address itself. Both will say the same thing next minute, so the row is
 * retired and the ledger keeps the reason.
 *
 * Everything else defers. `rate_limited`, `unavailable` and `timeout` are about
 * the moment; `unconfigured` is returned by `sendEmail` before a request is
 * made at all (`./send`), so treating it as a verdict would let a missing
 * `RESEND_API_KEY` retire the entire queue on one tick. See
 * 20260913120400_defer_transient_send_failures.sql.
 *
 * Listed here rather than in SQL deliberately: this is the file that owns the
 * union, so a seventh variant is a type error here instead of a silent
 * misclassification in a migration nobody re-reads.
 */
const TERMINAL_FAILURES: ReadonlySet<SendFailure> = new Set([
  "not_permitted",
  "invalid_recipient",
]);

const outcomeFor = (reason: SendFailure): MarkOutcome =>
  TERMINAL_FAILURES.has(reason)
    ? { status: "failed", reason }
    : { status: "deferred", reason };

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

  // A raise inside the definer function arrives as an error rather than a
  // throw. Report the code so the failure is visible in `net._http_response`
  // instead of looking like a minute with no mail in it.
  if (error) return { ...EMPTY, claimError: error.code ?? "unknown" };

  if (!data || data.length === 0) return EMPTY;

  let sent = 0;
  let failed = 0;
  let deferred = 0;

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

      const outcome: MarkOutcome = result.ok
        ? { status: "sent", providerId: result.id }
        : outcomeFor(result.reason);

      await markOutcome(supabase, secret, row.id, outcome);

      if (outcome.status === "sent") sent += 1;
      else if (outcome.status === "failed") failed += 1;
      else deferred += 1;

      // `unconfigured` means there is no API key in this environment, so every
      // remaining row in the batch would take the same path and burn the same
      // attempt for the same reason. Stop after the first: one deferred row is
      // the signal, fifty is fifty wasted attempts against the ceiling.
      if (!result.ok && result.reason === "unconfigured") break;
    } catch {
      // `sendEmail` never throws and the RPC returns errors rather than
      // throwing, so reaching here means something outside the request path
      // broke. The row is left `pending` and bounded by the attempt ceiling,
      // which is precisely `deferred` — counting it as `failed` would claim a
      // verdict nothing reached, and would not add up against the row's state.
      deferred += 1;
    }
  }

  return { claimed: data.length, sent, failed, deferred };
}
