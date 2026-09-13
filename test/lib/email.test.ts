import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factory below can see it — module-level consts are
// not visible inside hoisted factories.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));

// Fully faked, unlike `test/lib/ai.test.ts`'s partial mock: Resend reports
// failures as plain `{ message, statusCode, name }` objects rather than error
// classes, so there is nothing real left to preserve via `importOriginal`.
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

import { sendEmail } from "@/lib/email/send";
import type { SendFailure } from "@/lib/email/send";

const MESSAGE = {
  to: "owner@example.com",
  subject: "Your auction closed",
  text: "Sold for £420.",
};

const failure = (statusCode: number | null, name: string) => ({
  data: null,
  error: { message: `status ${statusCode}`, statusCode, name },
});

const accepted = { data: { id: "re_abc123" }, error: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("sendEmail", () => {
  it("returns `unconfigured` without calling the provider when no key is set", async () => {
    vi.stubEnv("RESEND_API_KEY", "");

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "unconfigured" });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns the provider message id on success", async () => {
    send.mockResolvedValue(accepted);

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: true, id: "re_abc123" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends from the shared domain with the caller's message", async () => {
    send.mockResolvedValue(accepted);

    await sendEmail(MESSAGE);

    expect(send.mock.calls[0][0]).toEqual({
      from: "ArtSwipe <onboarding@resend.dev>",
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      text: MESSAGE.text,
    });
  });

  it("honours EMAIL_FROM when a sending domain exists", async () => {
    vi.stubEnv("EMAIL_FROM", "ArtSwipe <notifications@artswipe.example>");
    send.mockResolvedValue(accepted);

    await sendEmail(MESSAGE);

    expect(send.mock.calls[0][0].from).toBe(
      "ArtSwipe <notifications@artswipe.example>",
    );
  });

  // The 403 and the 422 below both carry name `validation_error`. They are two
  // separate cases on purpose: a single case cannot catch the collision, and
  // collapsing them would report "verify a domain" as "bad recipient".
  it("classifies the shared-domain refusal as `not_permitted`", async () => {
    send.mockResolvedValue(failure(403, "validation_error"));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("classifies a field-validation failure as `invalid_recipient`", async () => {
    send.mockResolvedValue(failure(422, "validation_error"));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "invalid_recipient" });
  });

  it.each<[number, string, SendFailure]>([
    [401, "invalid_api_key", "unconfigured"],
    [429, "rate_limit_exceeded", "rate_limited"],
    [500, "internal_server_error", "unavailable"],
  ])("maps a %i onto `%s` → %s", async (status, name, reason) => {
    send.mockResolvedValue(failure(status, name));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason });
  });

  // The SDK reports its own fetch failures — DNS, a dropped connection — as
  // `application_error` with no status at all.
  it("reports `unavailable` when the request never reached the provider", async () => {
    send.mockResolvedValue(failure(null, "application_error"));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports `unconfigured` for a key error carrying no status", async () => {
    send.mockResolvedValue(failure(null, "restricted_api_key"));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("reports `unavailable` when the provider accepts but returns no id", async () => {
    send.mockResolvedValue({ data: {}, error: null });

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("reports `timeout` when the provider outlives the budget", async () => {
    vi.useFakeTimers();
    send.mockReturnValue(new Promise(() => {}));

    const pending = sendEmail(MESSAGE);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  // The never-throws guarantee: a thrown error must come back as a typed
  // result, not as a rejected promise.
  it("returns a typed result rather than rejecting when the SDK throws", async () => {
    send.mockRejectedValue(new Error("boom"));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });
});
