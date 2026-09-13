import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factories below can see them.
const { drainOutbox, createSupabaseClient } = vi.hoisted(() => ({
  drainOutbox: vi.fn(),
  createSupabaseClient: vi.fn(),
}));

vi.mock("@/lib/email/outbox", () => ({ drainOutbox }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: createSupabaseClient,
}));

import * as route from "@/app/api/email/drain/route";

/**
 * The door, not the drain. `test/lib/email-outbox.test.ts` owns the loop; this
 * file owns who is allowed to start it and what comes back.
 *
 * The bearer check asserted here is belt-and-braces rather than the security —
 * the real gate is the `p_secret` argument inside the definer functions,
 * because the Supabase client this route builds holds the publishable key,
 * which is public by design. It is still worth pinning: an unset secret must
 * not read as "open", and the response must never name a recipient, because
 * `pg_net` files every response in `net._http_response`.
 */

/**
 * The header token, which is deliberately NOT `EMAIL_DRAIN_SECRET`: it rides in
 * a header and so lands in `net.http_request_queue`, which `PUBLIC` can read.
 * The secret that gates an address never reaches this route at all —
 * `drainOutbox` reads it itself. See 20260913120300.
 */
const TRIGGER_TOKEN = "drain-trigger-token-for-tests";

const SUMMARY = { claimed: 4, sent: 3, failed: 1, deferred: 0 };

const post = (init: RequestInit = {}) =>
  route.POST(
    new Request("https://artswipe.test/api/email/drain", {
      method: "POST",
      ...init,
    }),
  );

const authorized = (init: RequestInit = {}) =>
  post({
    ...init,
    headers: {
      authorization: `Bearer ${TRIGGER_TOKEN}`,
      ...(init.headers ?? {}),
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_DRAIN_TRIGGER_TOKEN", TRIGGER_TOKEN);
  // Stubbed rather than inherited: the handler now checks these instead of
  // asserting them with `!`, so a machine without a .env.local would otherwise
  // see every case in this file answer 503.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://stub.supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_stub");
  createSupabaseClient.mockReturnValue({ rpc: vi.fn() });
  drainOutbox.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/email/drain", () => {
  it("answers 503 when the trigger token is unset, and drains nothing", async () => {
    vi.stubEnv("EMAIL_DRAIN_TRIGGER_TOKEN", "");

    const response = await authorized();

    // Unset must not mean open. 503 rather than 401 so an operator reading
    // `net._http_response` can tell "never configured" from "drifted apart".
    expect(response.status).toBe(503);
    expect(drainOutbox).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header at all", {}],
    ["a bare token with no scheme", { authorization: TRIGGER_TOKEN }],
    ["the wrong scheme", { authorization: `Basic ${TRIGGER_TOKEN}` }],
    ["an empty bearer token", { authorization: "Bearer " }],
    ["the wrong secret", { authorization: "Bearer not-the-secret" }],
    [
      "a prefix of the real secret",
      { authorization: `Bearer ${TRIGGER_TOKEN.slice(0, 8)}` },
    ],
    [
      "the real token with padding",
      { authorization: `Bearer ${TRIGGER_TOKEN}xxxx` },
    ],
  ])("answers 401 to %s", async (_case, headers) => {
    const response = await post({ headers: headers as HeadersInit });

    expect(response.status).toBe(401);
    expect(drainOutbox).not.toHaveBeenCalled();
  });

  it("accepts the right secret and returns the summary", async () => {
    const response = await authorized();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUMMARY);
    expect(drainOutbox).toHaveBeenCalledTimes(1);
  });

  it("drains with no limit when the body is empty, as the cron job sends it", async () => {
    // `net.http_post` posts `'{}'::jsonb`, and a body-less POST is just as
    // valid a way to ask for a drain.
    await authorized();

    expect(drainOutbox.mock.calls[0][1]).toEqual({ limit: undefined });
  });

  it("passes a limit through when one is asked for", async () => {
    const response = await authorized({
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 5 }),
    });

    expect(response.status).toBe(200);
    expect(drainOutbox.mock.calls[0][1]).toEqual({ limit: 5 });
  });

  it.each([
    ["a limit that is not a number", { limit: "5" }],
    ["a zero limit", { limit: 0 }],
    ["a negative limit", { limit: -1 }],
    ["a fractional limit", { limit: 1.5 }],
    ["a limit past the function's own clamp", { limit: 201 }],
  ])("answers 400 to %s", async (_case, body) => {
    const response = await authorized({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(drainOutbox).not.toHaveBeenCalled();
  });

  it("never names a recipient or an address in the response", async () => {
    const response = await authorized();
    const text = await response.text();

    // `pg_net` stores every response in `net._http_response`, a table with none
    // of `email_outbox`'s policy-free protection. Counts only.
    expect(text).not.toContain("@");
    expect(JSON.parse(text)).toEqual(SUMMARY);
  });

  it("builds a sessionless client rather than the cookie-aware one", async () => {
    await authorized();

    expect(createSupabaseClient.mock.calls[0][2]).toEqual({
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("exposes no verb but POST", async () => {
    // Next answers 405 for any method a route file does not export, so the
    // absence is the whole of the method check. Asserted against the verb list
    // rather than against every export, because route segment config
    // (`maxDuration`) lives in the same namespace and is not a verb.
    const VERBS = ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    expect(Object.keys(route).filter((key) => VERBS.includes(key))).toEqual([]);
    expect(route.POST).toBeTypeOf("function");
  });

  it.each(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"])(
    "answers 503 rather than throwing when %s is missing",
    async (name) => {
      vi.stubEnv(name, "");

      const response = await authorized();

      // The only two values in the handler that could throw out of it. An
      // uncontrolled 500 is the one response shape here that tells an operator
      // reading `net._http_response` nothing at all.
      expect(response.status).toBe(503);
      expect(drainOutbox).not.toHaveBeenCalled();
    },
  );

  it("answers 502 when the claim was refused, so the failure is not a quiet minute", async () => {
    // `verify_drain_secret` raises `EML00`/`EML01` rather than returning false
    // so an operator can tell "never configured" from "drifted apart".
    // `net._http_response` keeps the status code, so answering 200 here would
    // discard that distinction at the last hop.
    drainOutbox.mockResolvedValue({
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      claimError: "EML01",
    });

    const response = await authorized();

    expect(response.status).toBe(502);
    // A code, never a message: this body is stored in `net._http_response`.
    await expect(response.json()).resolves.toMatchObject({
      claimError: "EML01",
    });
  });

  it("declares a maxDuration the batch size can finish inside", async () => {
    // `DEFAULT_LIMIT` of 5 against `send.ts`'s 8s ceiling is ~40s of worst-case
    // sequential sends. Pinned because raising either number alone is the
    // mistake: `attempts` is spent for the whole batch at claim time, so a run
    // the platform kills partway retires rows it never tried.
    expect(route.maxDuration).toBe(60);
  });
});
