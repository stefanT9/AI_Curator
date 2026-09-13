import "server-only";

import { Resend } from "resend";
import type { ErrorResponse } from "resend";

/**
 * The one place in the app that talks to a mail provider.
 *
 * Never throws. A failure is data — `{ ok: false, reason }` over a closed
 * union — so every caller decides for itself whether to surface it, retry it
 * later, or merely record it. Mirrors `src/lib/ai/enrich.ts`.
 *
 * Deliberately database-free. Being free of any Supabase client is what lets
 * the same function be called from the smoke lane (which has no session), from
 * a Server Action, and later from a webhook drain, without any of them holding
 * a credential that outranks RLS. The ledger write lives next door in
 * `./record`.
 */

/**
 * Sender identity. `onboarding@resend.dev` is Resend's shared domain: it needs
 * no DNS and no domain verification, but it delivers **only to the Resend
 * account owner's own address** — every other recipient comes back 403. That is
 * sufficient while the project has one real user, and it defers the sending
 * domain to a change of `EMAIL_FROM` rather than a change of code.
 */
const DEFAULT_FROM = "ArtSwipe <onboarding@resend.dev>";

/**
 * The budget is set by the platform, not the provider: a Resend call normally
 * completes well inside a second, but Vercel Hobby clamps a function to 10s and
 * a send will often run inside `after()`, where it still spends the same
 * invocation. Eight seconds leaves headroom and fails fast instead of eating
 * the ceiling. There is no fallback chain here, so unlike `enrich.ts` this is
 * one call's budget rather than a chain's.
 */
const TIMEOUT_MS = 8_000;

/**
 * The budget is enforced by racing a timer rather than by an `AbortSignal`,
 * because the Resend SDK exposes no signal option — and even if one is smuggled
 * through, its internal `fetch` catches the abort and reports it as
 * `application_error` with a null `statusCode`, which is indistinguishable from
 * a dropped connection. Racing keeps `timeout` a distinct, reportable reason.
 */
const TIMED_OUT = Symbol("timed-out");

export type SendFailure =
  | "unconfigured" // no RESEND_API_KEY, or the provider rejected it (401)
  | "not_permitted" // 403 — shared sending domain, recipient is not the account owner
  | "invalid_recipient" // 422 — the address or a required field was rejected
  | "rate_limited" // 429
  | "unavailable" // 5xx, network failure, anything unclassified
  | "timeout"; // the abort budget expired

export type EmailMessage = { to: string; subject: string; text: string };

export type SendResult =
  { ok: true; id: string } | { ok: false; reason: SendFailure };

/**
 * Map a provider error onto a failure reason.
 *
 * Branch on the **status code before the error name**, always. Resend returns
 * the shared-domain refusal as 403 with name `validation_error`, and an
 * ordinary field-validation failure as 422 with that same name. Classifying on
 * the name would silently collapse "you must verify a domain" into "bad
 * recipient" — and the shared-domain 403 is the very first failure anyone hits
 * when they point this at an address other than the account owner's.
 */
const classify = (error: ErrorResponse): SendFailure => {
  switch (error.statusCode) {
    case 401:
      return "unconfigured";
    case 403:
      return "not_permitted";
    case 400:
    case 422:
      return "invalid_recipient";
    case 429:
      return "rate_limited";
  }

  // Only reached when the body carried no status — the SDK reports its own
  // fetch failures that way. The name is the last thing left to read.
  switch (error.name) {
    case "missing_api_key":
    case "invalid_api_key":
    case "restricted_api_key":
      return "unconfigured";
    case "rate_limit_exceeded":
    case "daily_quota_exceeded":
    case "monthly_quota_exceeded":
      return "rate_limited";
    default:
      return "unavailable";
  }
};

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  // Read lazily, never at module scope: `next build` imports this file and CI
  // has no key. An unset key must degrade at call time, not break the build.
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, reason: "unconfigured" };

  const from = process.env.EMAIL_FROM || DEFAULT_FROM;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const resend = new Resend(apiKey);

    const outcome = await Promise.race([
      resend.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), TIMEOUT_MS);
      }),
    ]);

    if (outcome === TIMED_OUT) return { ok: false, reason: "timeout" };
    if (outcome.error) return { ok: false, reason: classify(outcome.error) };
    if (!outcome.data?.id) return { ok: false, reason: "unavailable" };

    return { ok: true, id: outcome.data.id };
  } catch {
    // The SDK returns errors rather than throwing, so reaching here means
    // something outside the request path broke. Never let it escape.
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
