import type { Auction } from "@/types/domain";

/**
 * Openness and time remaining, as pure functions of a row and an explicit
 * clock.
 *
 * The explicit `now` parameter (rather than an internal `Date.now()`) is
 * what makes the expiry behaviour unit-testable: the integration lane runs
 * under real RLS with no service-role key, so it cannot fabricate a row
 * whose `ends_at` has already passed.
 *
 * `isOpen` is the TypeScript mirror of the predicate `getOpenAuctions`
 * applies in SQL (`cancelled_at is null and closed_at is null and ends_at >
 * now()`) -- a comment at that call site names this pairing so the two are
 * changed together, and `place_bid` / `cancel_auction` state the same three
 * terms in SQL.
 *
 * `closed_at` is not redundant with `ends_at`. `close_due_auctions(p_now)`
 * can stamp an auction closed while its `ends_at` is still in the future --
 * which is exactly what the integration lane does -- so the two timestamps
 * cannot be assumed to agree.
 */
export function isOpen(
  auction: Pick<Auction, "cancelled_at" | "closed_at" | "ends_at">,
  now: Date,
): boolean {
  return (
    auction.cancelled_at === null &&
    auction.closed_at === null &&
    new Date(auction.ends_at).getTime() > now.getTime()
  );
}

/**
 * Whether this viewer may place a bid on this auction right now.
 *
 * Stated once here rather than re-derived in the detail page and the bid form,
 * so the two cannot drift apart. It is a display predicate only: `place_bid`
 * re-checks both halves under a row lock, and that check -- not this one -- is
 * what actually refuses a bid.
 *
 * Same explicit-clock reasoning as `isOpen` above.
 */
export function canBid(
  auction: Pick<
    Auction,
    "cancelled_at" | "closed_at" | "ends_at" | "seller_id"
  >,
  viewerId: string,
  now: Date,
): boolean {
  return isOpen(auction, now) && auction.seller_id !== viewerId;
}

export function msRemaining(
  auction: Pick<Auction, "ends_at">,
  now: Date,
): number {
  return Math.max(0, new Date(auction.ends_at).getTime() - now.getTime());
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "Ended";

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return "Less than a minute left";
}
