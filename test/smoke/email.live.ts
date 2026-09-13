/**
 * Live smoke check for the send path — Phase 1 manual verification steps 1.6,
 * 1.7 and 1.8.
 *
 * Deliberately named `.live.ts`, not `.test.ts`: the default include pattern is
 * `test/**\/*.test.ts`, so this file is invisible to `npm run test` and to CI.
 * The automated suite stays deterministic and fully mocked; this is the opt-in
 * escape hatch for confirming a real message actually arrives.
 *
 * Run it:
 *
 *   npm run test:smoke -- email
 *
 * The `-- email` filter matters. Unfiltered, `npm run test:smoke` also runs
 * `enrich.live.ts`, which makes real OpenRouter calls.
 *
 * With RESEND_API_KEY set in .env.local it sends a real email (1.6). With the
 * key empty it should report `unconfigured` and make no request (1.7). Point
 * SMOKE_EMAIL_TO at any address other than the Resend account owner's and the
 * shared domain refuses it with `not_permitted` (1.8) — which is the whole
 * point of classifying the 403 apart from the 422.
 *
 * The result is written to test/smoke/.last-email.json (gitignored), because
 * Vitest swallows stdout for passing tests.
 */

import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sendEmail } from "@/lib/email/send";

/**
 * Throw rather than skip, following `test/integration/setup.ts` — a skipped
 * suite reports green, and a green suite that ran nothing is worse than a red
 * one. There is no sensible default recipient: the shared sending domain
 * delivers only to the Resend account owner's own address.
 */
const requireRecipient = (): string => {
  const to = process.env.SMOKE_EMAIL_TO;

  if (!to) {
    throw new Error(
      "This check needs SMOKE_EMAIL_TO — the address the email should arrive " +
        "at. With the default sender (onboarding@resend.dev, Resend's shared " +
        "domain) that must be the Resend account owner's own address; any " +
        "other recipient comes back `not_permitted`. Put it in .env.local " +
        "alongside RESEND_API_KEY.",
    );
  }

  return to;
};

it("sends a real email through Resend", { timeout: 30_000 }, async () => {
  const to = requireRecipient();
  const hasKey = Boolean(process.env.RESEND_API_KEY);

  console.log(
    `\nRESEND_API_KEY: ${hasKey ? "set" : "absent"}` +
      `\nEMAIL_FROM: ${process.env.EMAIL_FROM ?? "(default — onboarding@resend.dev)"}` +
      `\nto: ${to}\n`,
  );

  const startedAt = Date.now();
  const result = await sendEmail({
    to,
    subject: `ArtSwipe smoke check ${new Date().toISOString()}`,
    text:
      "This is the F-02 live smoke check. If you are reading it in an inbox, " +
      "the send path works end to end.",
  });
  const elapsedMs = Date.now() - startedAt;

  // Vitest swallows stdout for passing tests, so write the result somewhere
  // readable. SMOKE_OUT overrides the default path.
  const outPath = process.env.SMOKE_OUT ?? "test/smoke/.last-email.json";
  writeFileSync(
    outPath,
    JSON.stringify({ elapsedMs, to, result }, null, 2) + "\n",
  );
  console.log(`${elapsedMs}ms → ${outPath}`);

  if (!hasKey) {
    // Step 1.7: an absent key short-circuits before any network call.
    expect(result).toEqual({ ok: false, reason: "unconfigured" });
    return;
  }

  // Step 1.6: a real call is accepted and hands back a provider message id.
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.id.length).toBeGreaterThan(0);
  }
});
