/**
 * The tunable numbers behind the first-run flow, named once so they are not
 * scattered as literals across a query, a picker and a rating loop.
 *
 * Deliberately free of "server-only": `StyleTermPicker` is a Client Component
 * and imports the min/max to drive its own submit-enabled rule, so the same
 * bounds the server validates against are the ones the UI enforces.
 */

/**
 * Which taxonomy facet the collector picks from. Style is the facet a person
 * can answer without seeing any art — medium and palette are properties of a
 * piece, not of a taste.
 */
export const ONBOARDING_FACET = "style" as const;

/** Fewer than two terms barely narrows the pool; more than four stops narrowing it. */
export const ONBOARDING_TERM_MIN = 2;
export const ONBOARDING_TERM_MAX = 4;

/**
 * Likes that end the flow. This is the number that replaces the "how many
 * likes switch ranking on?" threshold — every collector now arrives with at
 * least this much signal, unless the starter pool ran out first.
 */
export const ONBOARDING_LIKE_TARGET = 5;

/** Upper bound on the starter pool. Fewer rows — including zero — is valid. */
export const ONBOARDING_POOL_SIZE = 24;
