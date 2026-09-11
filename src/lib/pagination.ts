/**
 * Parses a `?page=` search param into a safe page number: an integer >= 1,
 * clamped to `maxPage` so a pathological value (e.g. "1e21") can never turn
 * into a huge offset against a `.range()` query.
 */
export function parsePage(
  value: string | string[] | undefined,
  maxPage = 100_000,
): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 1;
  }

  return Math.min(parsed, maxPage);
}
