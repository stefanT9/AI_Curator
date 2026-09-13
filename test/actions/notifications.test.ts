import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, createSupabaseClient } = vi.hoisted(() => {
  const rpc = vi.fn();
  return {
    rpc,
    createSupabaseClient: vi.fn(() => ({ rpc })),
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: createSupabaseClient,
}));

import { setAuctionEmailsFromLink } from "@/app/actions/notifications";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe";

/**
 * The unauthenticated mutation, and the two things that have to be true of it:
 * nothing happens without a token that verifies, and the user it writes for is
 * the one the token names — never one the caller supplied.
 *
 * This action is a public endpoint by construction: every export of a
 * `"use server"` module is. The HMAC is the whole of its access control, so the
 * refusals below are the security, not the ergonomics.
 */

const SECRET = "test-unsubscribe-signing-secret";
const RPC_SECRET = "test-unsubscribe-rpc-secret";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UNSUBSCRIBE_TOKEN_SECRET = SECRET;
  process.env.UNSUBSCRIBE_RPC_SECRET = RPC_SECRET;
  rpc.mockResolvedValue({ error: null });
});

afterEach(() => {
  delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  delete process.env.UNSUBSCRIBE_RPC_SECRET;
});

describe("setAuctionEmailsFromLink", () => {
  it("turns notifications off for the user the token names", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result).toEqual({ status: "done", enabled: false });
    expect(rpc).toHaveBeenCalledWith("set_auction_emails_enabled", {
      p_user_id: USER_ID,
      p_enabled: false,
      p_secret: RPC_SECRET,
    });
  });

  it("turns them back on over the same token", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "true" }),
    );

    expect(result).toEqual({ status: "done", enabled: true });
    expect(rpc).toHaveBeenCalledWith(
      "set_auction_emails_enabled",
      expect.objectContaining({ p_enabled: true }),
    );
  });

  /**
   * The reason there is no user-id parameter anywhere in this path. A caller
   * who could name the subject would only need any valid token — including
   * their own — to mute anybody.
   */
  it("ignores a user id smuggled in the form body", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    await setAuctionEmailsFromLink(
      undefined,
      form({
        token,
        enabled: "false",
        userId: OTHER_USER_ID,
        p_user_id: OTHER_USER_ID,
        user_id: OTHER_USER_ID,
      }),
    );

    expect(rpc).toHaveBeenCalledWith(
      "set_auction_emails_enabled",
      expect.objectContaining({ p_user_id: USER_ID }),
    );
  });

  it.each([
    ["a tampered token", "AAAA.BBBB"],
    ["an empty token", ""],
  ])("writes nothing for %s", async (_label, token) => {
    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result).toEqual({ status: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("writes nothing when the token is missing entirely", async () => {
    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ enabled: "false" }),
    );

    expect(result).toEqual({ status: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("writes nothing when the desired state is not a boolean", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "maybe" }),
    );

    expect(result).toEqual({ status: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  /**
   * Every token failure reports the same `invalid`. Telling a caller that a
   * token was well-formed but unknown, or that the environment has no secret,
   * would let them probe whether a token names a real user.
   */
  it("reports a signing-secret outage as an ordinary invalid link", async () => {
    const token = createUnsubscribeToken(USER_ID)!;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result).toEqual({ status: "invalid" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not attempt the write when the RPC secret is unset", async () => {
    const token = createUnsubscribeToken(USER_ID)!;
    delete process.env.UNSUBSCRIBE_RPC_SECRET;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result?.status).toBe("error");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("surfaces a refused RPC instead of claiming success", async () => {
    rpc.mockResolvedValue({ error: { message: "invalid unsubscribe secret" } });
    const token = createUnsubscribeToken(USER_ID)!;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result?.status).toBe("error");
    // The Postgres error text never reaches the page: it would tell an
    // anonymous caller which half of the gate they failed.
    expect(result?.message).not.toContain("secret");
  });
});
