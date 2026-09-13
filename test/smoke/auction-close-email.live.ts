/**
 * Live smoke check for the close-outcome messages — Phase 2 manual
 * verification step 2.11.
 *
 * Deliberately named `.live.ts`, not `.test.ts`: the default include pattern is
 * `test/**\/*.test.ts`, so this file is invisible to `npm run test` and to CI.
 *
 * Run it:
 *
 *   npm run test:smoke -- auction-close-email
 *
 * The filter matters. Unfiltered, `npm run test:smoke` also runs
 * `enrich.live.ts`, which makes real OpenRouter calls.
 *
 * Sends two of the four real messages, composed by the real templates and sent
 * by the real `sendEmail`: an `auction_won`, which must name a counterparty's
 * address, and an `auction_lost`, which must name none. Nothing here touches
 * Postgres — `test/integration/email-outbox.int.ts` owns the enqueue and the
 * drain's two operations, and this owns the one question neither can answer:
 * what the message actually looks like when it lands in a person's inbox.
 *
 * §Access Control's boundary is asserted below as well as read by eye, because
 * a real send is the last chance to catch a body that names someone it should
 * not. Both messages are written to test/smoke/.last-close-emails.json
 * (gitignored) so the exact text is readable afterwards — Vitest swallows
 * stdout for passing tests.
 *
 * With RESEND_API_KEY absent both sends report `unconfigured` and no request is
 * made; the composed bodies are still written out and still asserted, which is
 * most of this check's value.
 */

import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sendEmail } from "@/lib/email/send";
import { composeCloseEmail } from "@/lib/email/templates";

/**
 * Throw rather than skip, following `test/smoke/email.live.ts` — a skipped
 * suite reports green, and a green suite that ran nothing is worse than a red
 * one.
 */
const requireRecipient = (): string => {
  const to = process.env.SMOKE_EMAIL_TO;

  if (!to) {
    throw new Error(
      "This check needs SMOKE_EMAIL_TO — the address the emails should " +
        "arrive at. With the default sender (onboarding@resend.dev, Resend's " +
        "shared domain) that must be the Resend account owner's own address; " +
        "any other recipient comes back `not_permitted`. Put it in .env.local " +
        "alongside RESEND_API_KEY.",
    );
  }

  return to;
};

const ARTWORK_TITLE = "Smoke check — Harbour at Dusk";
const AMOUNT_CENTS = 42_000;
const COUNTERPARTY = "smoke-counterparty@example.test";

const compose = (kind: string, payload: unknown) => {
  const message = composeCloseEmail(kind, payload);
  if (!message) throw new Error(`${kind} did not compose`);
  return message;
};

it(
  "sends a real auction_won and a real auction_lost",
  { timeout: 60_000 },
  async () => {
    const to = requireRecipient();
    const hasKey = Boolean(process.env.RESEND_API_KEY);

    console.log(
      `\nRESEND_API_KEY: ${hasKey ? "set" : "absent"}` +
        `\nEMAIL_FROM: ${process.env.EMAIL_FROM ?? "(default — onboarding@resend.dev)"}` +
        `\nto: ${to}\n`,
    );

    const won = compose("auction_won", {
      artwork_title: ARTWORK_TITLE,
      amount_cents: AMOUNT_CENTS,
      counterparty_email: COUNTERPARTY,
    });

    const lost = compose("auction_lost", { artwork_title: ARTWORK_TITLE });

    // The disclosure boundary, asserted one last time against the exact bytes
    // that are about to leave the building.
    expect(won.text).toContain(COUNTERPARTY);
    expect(`${lost.subject}\n${lost.text}`).not.toContain("@");
    expect(`${lost.subject}\n${lost.text}`).not.toContain("$");

    const startedAt = Date.now();
    const wonResult = await sendEmail({ to, ...won });
    const lostResult = await sendEmail({ to, ...lost });
    const elapsedMs = Date.now() - startedAt;

    const outPath =
      process.env.SMOKE_OUT ?? "test/smoke/.last-close-emails.json";
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          elapsedMs,
          to,
          won: { ...won, result: wonResult },
          lost: { ...lost, result: lostResult },
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`${elapsedMs}ms → ${outPath}`);

    if (!hasKey) {
      expect(wonResult).toEqual({ ok: false, reason: "unconfigured" });
      expect(lostResult).toEqual({ ok: false, reason: "unconfigured" });
      return;
    }

    expect(wonResult.ok).toBe(true);
    expect(lostResult.ok).toBe(true);
  },
);
