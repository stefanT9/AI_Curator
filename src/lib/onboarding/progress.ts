/**
 * The rule that ends the first-run flow, kept apart from the component that
 * renders it.
 *
 * It lives here because it is the one piece of onboarding whose behaviour has
 * to be provable: getting it wrong in the exhaustion direction strands a
 * collector in a mandatory flow with no way out. `StarterDeck` is a Client
 * Component, so a test can only reach this logic if it is separable from the
 * render — the same reasoning that put `selectNextCard` in
 * `src/lib/artworks/deck.ts`.
 *
 * Deliberately free of "server-only": `StarterDeck` imports it.
 */

import { ONBOARDING_LIKE_TARGET } from "@/lib/onboarding/config";

export type OnboardingProgress = {
  /** Likes recorded so far, counting only writes that have not rolled back. */
  likeCount: number;
  /** False once the starter pool is exhausted. */
  hasNextCard: boolean;
  /** True while a verdict is in flight. */
  isSaving: boolean;
};

/**
 * Two exit conditions, both normal completions:
 *
 * 1. the like target is reached, or
 * 2. the starter pool is exhausted — including a collector who skipped every
 *    piece, or whose terms matched nothing. They leave with zero likes and land
 *    on the newest-first deck, which is the proven-safe fallback. Treating this
 *    as an error, or re-serving skipped pieces, reintroduces the lockout.
 *
 * Neither fires while a write is in flight. A like is counted optimistically
 * and rolled back if the write fails, so completing mid-flight could end the
 * flow on a like that never landed.
 */
export function isOnboardingComplete({
  likeCount,
  hasNextCard,
  isSaving,
}: OnboardingProgress): boolean {
  if (isSaving) {
    return false;
  }

  return likeCount >= ONBOARDING_LIKE_TARGET || !hasNextCard;
}
