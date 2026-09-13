/**
 * Auction duration presets and price bounds, stated once.
 *
 * These mirror `create_auction`'s duration check and the
 * `auctions_starting_price_positive` constraint. The database is the real
 * gate -- these exist so the listing form and its Zod schema promise exactly
 * what the RPC will accept, rather than discovering the mismatch at write
 * time.
 *
 * Deliberately free of "server-only": the listing form and the countdown are
 * client components that read these directly.
 */

/** Matches the `p_duration_hours not in (24, 72, 168)` check in `create_auction`. */
export const AUCTION_DURATIONS = [
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

/** The preset hour values, in the same order, for the Zod enum. */
export const AUCTION_DURATION_HOURS: readonly (typeof AUCTION_DURATIONS)[number]["hours"][] =
  AUCTION_DURATIONS.map((duration) => duration.hours);

/** Matches `auctions_starting_price_positive`. */
export const MIN_STARTING_PRICE_CENTS = 1;
export const MAX_STARTING_PRICE_CENTS = 100_000_000_000;
