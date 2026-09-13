import "server-only";

import type { OutboxLinks } from "./templates";
import { siteUrl, unsubscribeUrl } from "./unsubscribe";

/**
 * Where the templates' links actually come from.
 *
 * `./templates` is pure and takes its URLs as an argument; this is the one
 * implementation of that argument the app uses. The split exists so that the
 * disclosure assertions in the default lane hold without a secret in scope —
 * see `OutboxLinks`.
 *
 * **Deliberately absent from `./index`, exactly like `./unsubscribe`.**
 * `unsubscribe` here *mints* a token, and a minter reachable from the barrel is
 * a minter one import away from a `"use server"` module, every export of which
 * is a public endpoint. Import this file directly, from code that has already
 * decided who the recipient is.
 *
 * Both halves return null rather than guessing. A link to the wrong origin is
 * worse than no link, and a message that cannot carry a working off switch is
 * not sent at all (`auctionOpenedMessage`).
 */
export const outboxLinks: OutboxLinks = {
  auction: (auctionId: string): string | null => {
    const base = siteUrl();
    return base ? `${base}/auctions/${auctionId}` : null;
  },
  unsubscribe: unsubscribeUrl,
};
