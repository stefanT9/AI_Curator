import {
  MAX_STARTING_PRICE_CENTS,
  MIN_STARTING_PRICE_CENTS,
} from "@/lib/auctions/config";

/**
 * Converts between the minor units `starting_price_cents` stores and the
 * decimal string a person types, in one place, so the listing form and every
 * display site cannot disagree.
 */
export function parsePriceToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const cents = Math.round(Number(trimmed) * 100);
  if (cents < MIN_STARTING_PRICE_CENTS || cents > MAX_STARTING_PRICE_CENTS) {
    return null;
  }

  return cents;
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
