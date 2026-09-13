/**
 * Live smoke check for the real outbox messages — S-04 Phase 2 manual
 * verification step 2.11, extended by S-05 Phase 3 with `auction_opened`.
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
 * Sends three real messages, composed by the real templates and sent by the
 * real `sendEmail`: an `auction_won`, which must name a counterparty's address;
 * an `auction_lost`, which must name none; and an `auction_opened`, the FR-003
 * notification, whose links are built from the same `.env.local` the app uses —
 * so a wrong `SITE_URL` or a missing `UNSUBSCRIBE_TOKEN_SECRET` shows up here as
 * a message that refuses to compose rather than as a dead link in an inbox.
 *
 * Nothing here touches Postgres — `test/integration/email-outbox.int.ts` owns
 * the enqueue and the drain's two operations, and this owns the one question
 * neither can answer: what the message actually looks like when it lands in a
 * person's inbox.
 *
 * §Access Control's boundary is asserted below as well as read by eye, because
 * a real send is the last chance to catch a body that names someone it should
 * not. All three are written to test/smoke/.last-close-emails.json
 * (gitignored) so the exact text is readable afterwards — Vitest swallows
 * stdout for passing tests.
 *
 * With RESEND_API_KEY absent every send reports `unconfigured` and no request
 * is made; the composed bodies are still written out and still asserted, which
 * is most of this check's value.
 */

import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { outboxLinks } from "@/lib/email/links";
import { sendEmail } from "@/lib/email/send";
import { composeOutboxEmail } from "@/lib/email/templates";

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
const STARTING_PRICE_CENTS = 12_500;
const COUNTERPARTY = "smoke-counterparty@example.test";
const AUCTION_ID = "33333333-3333-4333-8333-333333333333";
const RECIPIENT_ID = "44444444-4444-4444-8444-444444444444";

/**
 * The real link builders, reading the real `.env.local`. `auction_opened`
 * refuses to compose without both, so the throw below is the check: an
 * unconfigured environment fails loudly here instead of mailing a link that
 * goes nowhere.
 */
const compose = (kind: string, payload: unknown) => {
  const message = composeOutboxEmail(kind, payload, outboxLinks);
  if (!message) {
    throw new Error(
      `${kind} did not compose — for auction_opened, check SITE_URL and ` +
        "UNSUBSCRIBE_TOKEN_SECRET in .env.local",
    );
  }
  return message;
};

it(
  "sends a real auction_won, auction_lost and auction_opened",
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

    const opened = compose("auction_opened", {
      artwork_title: ARTWORK_TITLE,
      starting_price_cents: STARTING_PRICE_CENTS,
      ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      auction_id: AUCTION_ID,
      recipient_id: RECIPIENT_ID,
    });

    // The disclosure boundary, asserted one last time against the exact bytes
    // that are about to leave the building.
    expect(won.text).toContain(COUNTERPARTY);
    expect(`${lost.subject}\n${lost.text}`).not.toContain("@");
    expect(`${lost.subject}\n${lost.text}`).not.toContain("$");

    // The notification reaches someone who has not bid. It carries the seller's
    // asking price and nothing else with a currency sign, no address at all,
    // and a working way out.
    const openedWhole = `${opened.subject}\n${opened.text}`;
    expect(openedWhole).not.toContain("@");
    expect(openedWhole.match(/\$[\d,]+\.\d{2}/g)).toEqual(["$125.00"]);
    expect(opened.text).toContain("/unsubscribe?token=");

    const startedAt = Date.now();
    const wonResult = await sendEmail({ to, ...won });
    const lostResult = await sendEmail({ to, ...lost });
    const openedResult = await sendEmail({ to, ...opened });
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
          opened: { ...opened, result: openedResult },
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`${elapsedMs}ms → ${outPath}`);

    if (!hasKey) {
      expect(wonResult).toEqual({ ok: false, reason: "unconfigured" });
      expect(lostResult).toEqual({ ok: false, reason: "unconfigured" });
      expect(openedResult).toEqual({ ok: false, reason: "unconfigured" });
      return;
    }

    expect(wonResult.ok).toBe(true);
    expect(lostResult.ok).toBe(true);
    expect(openedResult.ok).toBe(true);
  },
);
