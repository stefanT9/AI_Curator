import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUnsubscribeToken,
  siteUrl,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "@/lib/email/unsubscribe";

/**
 * The credential that stands in for a session when someone clicks a link in
 * their inbox.
 *
 * Everything here is a claim about what the token refuses, because the token is
 * the only thing between an unauthenticated POST and somebody else's
 * notification setting. The happy path is one test; the rest are the ways it
 * must fail closed.
 *
 * The secret is set and cleared per test rather than in the vitest config, so
 * the unset case is reachable — "no secret means verification fails" cannot be
 * asserted in a process where the secret is always present.
 */

const SECRET = "test-unsubscribe-signing-secret";
const USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555";

beforeEach(() => {
  process.env.UNSUBSCRIBE_TOKEN_SECRET = SECRET;
  process.env.SITE_URL = "https://artswipe.example";
});

afterEach(() => {
  delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  delete process.env.SITE_URL;
});

/** Mint a token the way the module does, but over a caller-chosen purpose. */
const forge = (userId: string, purpose: string, secret = SECRET) => {
  const payload = Buffer.from(userId, "utf8").toString("base64url");
  const digest = createHmac("sha256", secret)
    .update(`${purpose}:${userId}`)
    .digest()
    .toString("base64url");
  return `${payload}.${digest}`;
};

describe("unsubscribe tokens", () => {
  it("round-trips a user id", () => {
    const token = createUnsubscribeToken(USER_ID);

    expect(token).toEqual(expect.any(String));
    expect(verifyUnsubscribeToken(token)).toBe(USER_ID);
  });

  it("does not put the user id in the clear", () => {
    const token = createUnsubscribeToken(USER_ID);

    expect(token).not.toContain(USER_ID);
  });

  it("produces a URL-safe token", () => {
    const token = createUnsubscribeToken(USER_ID);

    // base64url plus the separator, and nothing that needs escaping in a query
    // string — a token mangled by a mail client's URL rewriting is a link that
    // silently fails for the one person who tried to use it.
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token!)).toBe(token);
  });

  it("rejects a token whose payload was swapped for another user", () => {
    const token = createUnsubscribeToken(USER_ID)!;
    const [, digest] = token.split(".");
    const swapped = `${Buffer.from(OTHER_USER_ID, "utf8").toString(
      "base64url",
    )}.${digest}`;

    expect(verifyUnsubscribeToken(swapped)).toBeNull();
  });

  it("rejects a tampered digest", () => {
    const token = createUnsubscribeToken(USER_ID)!;
    const [payload, digest] = token.split(".");
    const flipped =
      digest[0] === "A" ? `B${digest.slice(1)}` : `A${digest.slice(1)}`;

    expect(verifyUnsubscribeToken(`${payload}.${flipped}`)).toBeNull();
  });

  it("rejects a truncated digest", () => {
    const token = createUnsubscribeToken(USER_ID)!;
    const [payload, digest] = token.split(".");

    expect(
      verifyUnsubscribeToken(`${payload}.${digest.slice(0, 8)}`),
    ).toBeNull();
  });

  /**
   * The purpose string is mixed into the signed input, so a signature minted
   * for some other use of the same key cannot be replayed as an unsubscribe.
   */
  it("rejects a well-formed signature made for a different purpose", () => {
    const wrongPurpose = forge(USER_ID, "password-reset:v1");

    expect(wrongPurpose).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribeToken(wrongPurpose)).toBeNull();
  });

  it("rejects a signature made with a different secret", () => {
    const wrongKey = forge(USER_ID, "auction-emails-unsubscribe:v1", "not-it");

    expect(verifyUnsubscribeToken(wrongKey)).toBeNull();
  });

  it("rejects a payload that is not a UUID", () => {
    const notAUuid = forge("bobby-tables", "auction-emails-unsubscribe:v1");

    expect(verifyUnsubscribeToken(notAUuid)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no separator", "justonepart"],
    ["too many parts", "a.b.c"],
    ["empty digest", "abc."],
    ["empty payload", ".abc"],
  ])("rejects a malformed token (%s)", (_label, token) => {
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects a missing token (%s)", (_label, token) => {
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  /**
   * Fail closed, both ways. An environment with no signing secret must not
   * accept anything — least of all a token minted while it was configured.
   */
  describe("with no signing secret", () => {
    it("mints nothing", () => {
      const token = createUnsubscribeToken(USER_ID)!;
      delete process.env.UNSUBSCRIBE_TOKEN_SECRET;

      expect(createUnsubscribeToken(USER_ID)).toBeNull();
      expect(token).toEqual(expect.any(String));
    });

    it("verifies nothing, including a previously valid token", () => {
      const token = createUnsubscribeToken(USER_ID)!;
      delete process.env.UNSUBSCRIBE_TOKEN_SECRET;

      expect(verifyUnsubscribeToken(token)).toBeNull();
    });
  });
});

describe("link building", () => {
  it("strips a trailing slash from the site URL", () => {
    process.env.SITE_URL = "https://artswipe.example/";

    expect(siteUrl()).toBe("https://artswipe.example");
  });

  it("builds an absolute link carrying the token", () => {
    const url = unsubscribeUrl(USER_ID)!;

    expect(url.startsWith("https://artswipe.example/unsubscribe?token=")).toBe(
      true,
    );

    const token = new URL(url).searchParams.get("token");
    expect(verifyUnsubscribeToken(token)).toBe(USER_ID);
  });

  /**
   * Mail has no origin to be relative to. A link to the wrong host is worse
   * than no link, so an unset base yields nothing rather than a guess.
   */
  it("builds no link when the site URL is unset", () => {
    delete process.env.SITE_URL;

    expect(siteUrl()).toBeNull();
    expect(unsubscribeUrl(USER_ID)).toBeNull();
  });

  it("builds no link when the signing secret is unset", () => {
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET;

    expect(unsubscribeUrl(USER_ID)).toBeNull();
  });
});
