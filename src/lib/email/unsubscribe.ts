import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The off switch a recipient can use from their inbox, with no session.
 *
 * A token proves "the holder of this link is the user it names" and nothing
 * else. It is stateless on purpose: no row to create at send time, nothing to
 * expire, and nothing to clean up when an auction is deleted. The secret never
 * travels — only the signature over it does.
 *
 * **This module is imported, never re-exported from a `"use server"` module.**
 * Every export of one is a public endpoint, and an exported minter would hand
 * any caller a valid unsubscribe link for any user id they cared to name.
 *
 * It is also deliberately absent from `./index`. The barrel pulls in `send.ts`
 * and therefore the Resend SDK; the unsubscribe page needs neither, and a page
 * that renders a confirm button should not be dragging a mail provider in
 * behind it. Import this file directly.
 *
 * **The signing secret never reaches SQL.** The definer function that performs
 * the write is gated by a separate value (`UNSUBSCRIBE_RPC_SECRET`), because
 * this one can mint a token for any user, forever — so it stays inside this
 * process, where the only thing that can use it is code that has already
 * decided the caller is entitled.
 */

/**
 * Mixed into the signed input rather than kept alongside it, so a signature
 * minted for some future purpose cannot be replayed as an unsubscribe. The
 * version suffix is what lets the meaning change later without every
 * outstanding link silently keeping its old one — bump it and old tokens stop
 * verifying, which is the correct failure.
 */
const PURPOSE = "auction-emails-unsubscribe:v1";

/**
 * The id is echoed back to the caller after verification and handed to an RPC
 * typed `uuid`, so its shape is checked here rather than at that boundary. A
 * token can only carry a well-formed id.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const digestFor = (userId: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(`${PURPOSE}:${userId}`).digest();

/**
 * Mint a link token for one user.
 *
 * Returns null when the secret is unset — read here and never at module scope,
 * because `next build` imports every module and CI has no key. A caller that
 * gets null has no link to embed, which is the right outcome: a mail carrying
 * an unsubscribe link that cannot work is worse than one that is not sent.
 */
export const createUnsubscribeToken = (userId: string): string | null => {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret) return null;

  const payload = Buffer.from(userId, "utf8").toString("base64url");
  const digest = digestFor(userId, secret).toString("base64url");

  return `${payload}.${digest}`;
};

/**
 * Verify a token back to the user id it names, or null.
 *
 * Fails closed on every path: unset secret, missing token, wrong shape, an id
 * that is not a UUID, a digest of the wrong length, or a digest that does not
 * match. Null is the only failure signal — the caller cannot tell a tampered
 * token from an unconfigured environment, and does not need to.
 */
export const verifyUnsubscribeToken = (
  token: string | null | undefined,
): string | null => {
  const secret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!secret || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedDigest] = parts;
  if (!encodedPayload || !encodedDigest) return null;

  const userId = Buffer.from(encodedPayload, "base64url").toString("utf8");
  if (!UUID_PATTERN.test(userId)) return null;

  const offered = Buffer.from(encodedDigest, "base64url");
  const expected = digestFor(userId, secret);

  // `timingSafeEqual` throws on differing lengths, and letting that throw
  // escape would turn a malformed token into a 500. Checking first also keeps
  // the comparison itself constant-time over everything that reaches it.
  if (offered.length !== expected.length) return null;
  if (!timingSafeEqual(offered, expected)) return null;

  return userId;
};

/**
 * The absolute base every link in an email is built from.
 *
 * Mail has no origin to be relative to, so this cannot be derived from a
 * request the way an in-app link can. Returns null when unset rather than
 * guessing a host — a link to the wrong origin is worse than no link.
 */
export const siteUrl = (): string | null => {
  const raw = process.env.SITE_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
};

/** The full link that goes in a mail body. Null if either half is missing. */
export const unsubscribeUrl = (userId: string): string | null => {
  const base = siteUrl();
  const token = createUnsubscribeToken(userId);
  if (!base || !token) return null;

  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
};
