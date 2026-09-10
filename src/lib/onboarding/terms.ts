/**
 * The validation gate between the picker's URL params and the starter query.
 *
 * `StyleTermPicker` submits as a plain GET form, so the chosen terms arrive as
 * untrusted query string — anyone can type `?term=<anything>` by hand. This is
 * the boundary where that becomes a known-good list, before it reaches
 * `getStarterDeck` and turns into a tag-overlap filter.
 *
 * Deliberately free of "server-only": it is pure data validation with no
 * client-hostile imports, and keeping it importable from either side means the
 * bounds the server enforces are the same constants the picker renders.
 */

import * as z from "zod";
import { TAXONOMY_BY_FACET } from "@/lib/ai/taxonomy";
import {
  ONBOARDING_FACET,
  ONBOARDING_TERM_MAX,
  ONBOARDING_TERM_MIN,
} from "@/lib/onboarding/config";

/**
 * A single `?term=` reaches the page as a string, several as an array — Next
 * collapses repeated params that way. Both shapes normalise to a deduplicated
 * array before the count is checked, so `?term=abstract&term=abstract` is one
 * selection and fails the minimum rather than sneaking past it.
 */
export const StarterTermsSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((raw) => Array.from(new Set(Array.isArray(raw) ? raw : [raw])))
  .pipe(
    z
      .array(z.enum(TAXONOMY_BY_FACET[ONBOARDING_FACET]))
      .min(ONBOARDING_TERM_MIN)
      .max(ONBOARDING_TERM_MAX),
  );

/**
 * `null` for anything that is not a valid selection — absent, malformed, out of
 * range, or off-vocabulary. The caller treats all of those the same way: show
 * the picker. There is no error to report, because the only route to an invalid
 * selection is a hand-edited URL.
 */
export function parseStarterTerms(
  raw: string | string[] | undefined,
): string[] | null {
  const result = StarterTermsSchema.safeParse(raw);

  return result.success ? result.data : null;
}
