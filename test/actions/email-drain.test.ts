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

const SECRET = "drain-secret-for-tests";

const SUMMARY = { claimed: 4, sent: 3, failed: 1 };

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
    headers: { authorization: `Bearer ${SECRET}`, ...(init.headers ?? {}) },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("EMAIL_DRAIN_SECRET", SECRET);
  createSupabaseClient.mockReturnValue({ rpc: vi.fn() });
  drainOutbox.mockResolvedValue(SUMMARY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/email/drain", () => {
  it("answers 503 when the secret is unset, and drains nothing", async () => {
    vi.stubEnv("EMAIL_DRAIN_SECRET", "");

    const response = await authorized();

    // Unset must not mean open. 503 rather than 401 so an operator reading
    // `net._http_response` can tell "never configured" from "drifted apart".
    expect(response.status).toBe(503);
    expect(drainOutbox).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header at all", {}],
    ["a bare token with no scheme", { authorization: SECRET }],
    ["the wrong scheme", { authorization: `Basic ${SECRET}` }],
    ["an empty bearer token", { authorization: "Bearer " }],
    ["the wrong secret", { authorization: "Bearer not-the-secret" }],
    [
      "a prefix of the real secret",
      { authorization: `Bearer ${SECRET.slice(0, 8)}` },
    ],
    ["the real secret with padding", { authorization: `Bearer ${SECRET}xxxx` }],
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
    // absence is the whole of the method check.
    expect(Object.keys(route)).toEqual(["POST"]);
  });
});
