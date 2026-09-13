import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

const { rpc, createSupabaseClient } = vi.hoisted(() => {
  const rpc = vi.fn();
  return { rpc, createSupabaseClient: vi.fn(() => ({ rpc })) };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: createSupabaseClient,
}));

const serverClient = vi.hoisted(() => vi.fn());
vi.mock("@/utils/supabase/server", () => ({ createClient: serverClient }));

import UnsubscribePage from "@/app/unsubscribe/page";
import { createUnsubscribeToken } from "@/lib/email/unsubscribe";

/**
 * The prefetch defence, asserted rather than assumed.
 *
 * Gmail, Outlook and corporate security gateways issue a GET against every URL
 * in a message. If rendering this page mutated anything, those scanners would
 * unsubscribe people who never clicked — and the symptom is indistinguishable
 * from the feature working correctly, so no amount of manual testing would find
 * it. This file pins the property that makes that impossible: rendering builds
 * no client, opens no connection and calls no RPC, whatever token it is given.
 */

const SECRET = "test-unsubscribe-signing-secret";
const USER_ID = "11111111-2222-4333-8444-555555555555";

const render = (token?: string): Promise<ReactElement> =>
  UnsubscribePage({
    searchParams: Promise.resolve(token === undefined ? {} : { token }),
  } as Parameters<typeof UnsubscribePage>[0]) as Promise<ReactElement>;

/** Collect every string in a rendered element tree, however deeply nested. */
const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (typeof node === "object" && "props" in (node as ReactElement)) {
    const el = node as ReactElement<{ children?: unknown }>;
    const name =
      typeof el.type === "function" ? (el.type.name ?? "") : String(el.type);
    return `<${name}> ${textOf(el.props?.children)}`;
  }
  return "";
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UNSUBSCRIBE_TOKEN_SECRET = SECRET;
  process.env.UNSUBSCRIBE_RPC_SECRET = "test-unsubscribe-rpc-secret";
});

afterEach(() => {
  delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  delete process.env.UNSUBSCRIBE_RPC_SECRET;
});

describe("the unsubscribe page's GET", () => {
  it("renders the confirm form for a valid token", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    expect(textOf(await render(token))).toContain("UnsubscribeForm");
  });

  it("mutates nothing while rendering a valid token", async () => {
    const token = createUnsubscribeToken(USER_ID)!;

    await render(token);

    expect(rpc).not.toHaveBeenCalled();
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(serverClient).not.toHaveBeenCalled();
  });

  it.each([
    ["a tampered token", "AAAA.BBBB"],
    ["an empty token", ""],
  ])(
    "mutates nothing and shows the neutral failure for %s",
    async (_l, token) => {
      const text = textOf(await render(token));

      expect(text).toContain("didn");
      expect(text).not.toContain("UnsubscribeForm");
      expect(rpc).not.toHaveBeenCalled();
      expect(createSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("mutates nothing and shows the neutral failure with no token at all", async () => {
    const text = textOf(await render());

    expect(text).not.toContain("UnsubscribeForm");
    expect(rpc).not.toHaveBeenCalled();
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  /**
   * The page never looks the user up, and must not start: a token that verifies
   * renders the confirm form whether or not it names an account that still
   * exists. Rendering differently would turn this route into an account
   * oracle — anyone holding a signed token could learn whether its user is
   * still registered, without ever pressing the button.
   *
   * The write is where a non-existent user is actually resolved, and it fails
   * there on the foreign key, seen by nobody.
   */
  it("does not reveal whether a verified token names an existing account", async () => {
    const signedForNobody = textOf(
      await render(
        createUnsubscribeToken("00000000-0000-4000-8000-000000000000")!,
      ),
    );

    expect(signedForNobody).toContain("UnsubscribeForm");
    expect(rpc).not.toHaveBeenCalled();
  });
});
