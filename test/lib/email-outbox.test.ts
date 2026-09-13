import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factory can see it — module-level consts cannot.
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return { ...actual, sendEmail };
});

import { drainOutbox } from "@/lib/email/outbox";
import type { OutboxDrainClient } from "@/lib/email/outbox";
import type { SendFailure } from "@/lib/email/send";

/**
 * The claim → compose → send → mark loop, with both boundaries faked.
 *
 * Supabase is never real in this lane, so nothing here says anything about the
 * grants or the secret — `test/integration/email-outbox.int.ts` owns those. What
 * this file owns is the mapping: that every `SendResult` reaches
 * `mark_email_sent` as the right pair of arguments, that a row which cannot be
 * composed is marked rather than thrown over, and that one bad row does not
 * take the batch down with it.
 */

const SECRET = "drain-secret-for-tests";

type RpcCall = [string, Record<string, unknown>];

const rpc = vi.fn();

const client = { rpc } as unknown as OutboxDrainClient;

const row = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "auction_lost",
  recipient_email: "bidder@example.test",
  payload: { artwork_title: "Harbour at Dusk" },
  ...overrides,
});

const wonRow = row({
  id: "22222222-2222-4222-8222-222222222222",
  kind: "auction_won",
  recipient_email: "winner@example.test",
  payload: {
    artwork_title: "Harbour at Dusk",
    amount_cents: 42_000,
    counterparty_email: "seller@example.test",
  },
});

/** Claim returns these rows; every `mark_email_sent` succeeds. */
const claimReturns = (rows: unknown[]) => {
  rpc.mockImplementation(async (name: string) =>
    name === "claim_pending_emails"
      ? { data: rows, error: null }
      : { data: null, error: null },
  );
};

const calls = (name: string): RpcCall[1][] =>
  rpc.mock.calls.filter((call) => call[0] === name).map((call) => call[1]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_DRAIN_SECRET", SECRET);
  sendEmail.mockResolvedValue({ ok: true, id: "re_abc123" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drainOutbox", () => {
  it("does nothing at all when the secret is unset", async () => {
    vi.stubEnv("EMAIL_DRAIN_SECRET", "");
    claimReturns([row()]);

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
    });

    // Not even a claim: an unconfigured environment must be inert, not noisy.
    expect(rpc).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("claims with the secret and the default batch size", async () => {
    claimReturns([]);

    await drainOutbox(client);

    expect(calls("claim_pending_emails")).toEqual([
      { p_secret: SECRET, p_limit: 5 },
    ]);
  });

  it("passes a caller's limit through", async () => {
    claimReturns([]);

    await drainOutbox(client, { limit: 5 });

    expect(calls("claim_pending_emails")[0].p_limit).toBe(5);
  });

  it("reports zeroes and sends nothing on an empty outbox", async () => {
    claimReturns([]);

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("names the code when the claim itself is refused", async () => {
    // A wrong or unconfigured secret raises inside the definer function, which
    // PostgREST reports as an error rather than a throw. The code travels back
    // so vault drift is distinguishable from a minute with no mail in it —
    // `verify_drain_secret` raises `EML00`/`EML01` for exactly that reason.
    rpc.mockResolvedValue({ data: null, error: { code: "EML01" } });

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      claimError: "EML01",
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("falls back to a placeholder when the error carries no code", async () => {
    rpc.mockResolvedValue({ data: null, error: {} });

    const summary = await drainOutbox(client);

    expect(summary.claimError).toBe("unknown");
  });

  it("reports a plain empty summary on an empty queue, with no error", async () => {
    // The distinction the code above exists to preserve: nothing to do is not
    // the same as could not ask.
    claimReturns([]);

    expect(await drainOutbox(client)).not.toHaveProperty("claimError");
  });

  it("sends a claimed row to the address the row names, with the composed message", async () => {
    claimReturns([wonRow]);

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 1,
      sent: 1,
      failed: 0,
      deferred: 0,
    });

    const message = sendEmail.mock.calls[0][0];
    // The address comes off the row — resolved from `auth.users` at enqueue
    // time — and never from anything the drain looked up itself.
    expect(message.to).toBe("winner@example.test");
    expect(message.subject).toContain("Harbour at Dusk");
    expect(message.text).toContain("seller@example.test");
  });

  it("marks a delivered row with the provider id and no reason", async () => {
    claimReturns([wonRow]);

    await drainOutbox(client);

    // `p_provider_id` **or** `p_reason`, never both — the same mapping
    // `recordSend` makes, and the reason both are `default null`.
    expect(calls("mark_email_sent")).toEqual([
      {
        p_secret: SECRET,
        p_id: wonRow.id,
        p_status: "sent",
        p_provider_id: "re_abc123",
      },
    ]);
  });

  // The whole `SendFailure` union, split by whether the provider reached a
  // verdict about this recipient or merely about this moment. Terminal rows are
  // retired; the rest go back to `pending` for the attempt ceiling to bound.
  // 20260913120400_defer_transient_send_failures.sql carries the reasoning.
  it.each<SendFailure>(["not_permitted", "invalid_recipient"])(
    "retires a `%s` failure, because that verdict will not change",
    async (reason) => {
      claimReturns([wonRow]);
      sendEmail.mockResolvedValue({ ok: false, reason });

      await expect(drainOutbox(client)).resolves.toEqual({
        claimed: 1,
        sent: 0,
        failed: 1,
        deferred: 0,
      });

      expect(calls("mark_email_sent")).toEqual([
        {
          p_secret: SECRET,
          p_id: wonRow.id,
          p_status: "failed",
          p_reason: reason,
        },
      ]);
    },
  );

  it.each<SendFailure>(["rate_limited", "unavailable", "timeout"])(
    "defers a `%s` failure, so the next tick tries again",
    async (reason) => {
      claimReturns([wonRow]);
      sendEmail.mockResolvedValue({ ok: false, reason });

      await expect(drainOutbox(client)).resolves.toEqual({
        claimed: 1,
        sent: 0,
        failed: 0,
        deferred: 1,
      });

      // `deferred` leaves the outbox row `pending` and still writes the ledger
      // row: the attempt happened, and is a fact whether or not it stuck.
      expect(calls("mark_email_sent")).toEqual([
        {
          p_secret: SECRET,
          p_id: wonRow.id,
          p_status: "deferred",
          p_reason: reason,
        },
      ]);
    },
  );

  it("stops the whole batch on `unconfigured` rather than burning every attempt", async () => {
    claimReturns([
      wonRow,
      row({ id: "aaaaaaaa-0000-4000-8000-000000000003" }),
      row({ id: "aaaaaaaa-0000-4000-8000-000000000004" }),
    ]);
    sendEmail.mockResolvedValue({ ok: false, reason: "unconfigured" });

    // `sendEmail` returns this before making a request at all, so every
    // remaining row would take the identical path for the identical reason.
    // Without the break, one missing `RESEND_API_KEY` spends the entire
    // backlog's attempt budget in three ticks.
    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 3,
      sent: 0,
      failed: 0,
      deferred: 1,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(calls("mark_email_sent")).toEqual([
      {
        p_secret: SECRET,
        p_id: wonRow.id,
        p_status: "deferred",
        p_reason: "unconfigured",
      },
    ]);
  });

  it("marks a row it cannot compose without offering it to the provider", async () => {
    claimReturns([row({ kind: "auction_invented_later" })]);

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 1,
      sent: 0,
      failed: 1,
      deferred: 0,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    // A seventh reason, distinct from the six `SendFailure` variants on
    // purpose: "we could not render it" and "Resend refused it" want different
    // fixes, and the ledger is where an operator tells them apart.
    expect(calls("mark_email_sent")[0].p_reason).toBe("unrenderable");
  });

  it("keeps going after an unrenderable row, so one bad payload cannot hold up a win", async () => {
    claimReturns([
      row({ id: "aaaaaaaa-0000-4000-8000-000000000001", kind: "nonsense" }),
      wonRow,
      row({ id: "aaaaaaaa-0000-4000-8000-000000000002" }),
    ]);

    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 3,
      sent: 2,
      failed: 1,
      deferred: 0,
    });

    expect(calls("mark_email_sent")).toHaveLength(3);
  });

  it("sends one at a time, in the order the claim handed them over", async () => {
    // Sequential on purpose: Resend's free tier is 10 requests a second and an
    // auction with many losing bidders is a single batch.
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    sendEmail.mockImplementation(async (message: { to: string }) => {
      started.push(message.to);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, id: "re_abc123" };
    });

    claimReturns([
      row({
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        recipient_email: "a@example.test",
      }),
      row({
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        recipient_email: "b@example.test",
      }),
      row({
        id: "bbbbbbbb-0000-4000-8000-000000000003",
        recipient_email: "c@example.test",
      }),
    ]);

    await drainOutbox(client);

    expect(started).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("never throws, even when the write-back itself blows up", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "claim_pending_emails") {
        return { data: [wonRow, row()], error: null };
      }
      throw new Error("connection reset");
    });

    // The row stays `pending` and is bounded by the attempt ceiling. The caller
    // is a fire-and-forget `net.http_post`; there is nobody to throw at.
    await expect(drainOutbox(client)).resolves.toEqual({
      claimed: 2,
      sent: 0,
      failed: 0,
      deferred: 2,
    });
  });
});
