"use client";

import { useCallback, useState, useTransition } from "react";
import { recordInteraction } from "@/app/actions/interactions";
import { ArtCard } from "@/components/artworks/ArtCard";
import { OnboardingHandoff } from "@/components/onboarding/OnboardingHandoff";
import { selectNextCard } from "@/lib/artworks/deck";
import { ONBOARDING_LIKE_TARGET } from "@/lib/onboarding/config";
import { isOnboardingComplete } from "@/lib/onboarding/progress";
import type {
  Artwork,
  ArtworkWithArtist,
  InteractionAction,
} from "@/types/domain";

/**
 * The second screen of the flow: rate the starter pool one piece at a time
 * until the like target is reached or the pool runs out.
 *
 * Verdicts go through `recordInteraction`, unchanged — these are ordinary
 * `interactions` rows, which is what lets the ranking function consume the
 * output of onboarding without knowing onboarding exists. It also means the
 * upsert's anti-join keeps starter pieces out of the collector's first real
 * deck for free.
 *
 * Position is keyed to artwork id via `selectNextCard`, matching `SwipeDeck`
 * for the reason recorded in `src/lib/artworks/deck.ts`. Drag is deliberately
 * left out: this screen teaches nothing about swiping, and the first-run hint
 * on the real deck is where that is introduced.
 */
export function StarterDeck({ pool }: { pool: ArtworkWithArtist[] }) {
  // Ids, not a counter. A failed write has to roll back exactly the piece it
  // belonged to, and a counter cannot tell which one that was.
  const [decidedIds, setDecidedIds] = useState<Set<string>>(() => new Set());
  const [likedIds, setLikedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const { current } = selectNextCard(pool, decidedIds);
  const likeCount = likedIds.size;

  const decide = useCallback((artwork: Artwork, action: InteractionAction) => {
    setError(null);

    // Advance optimistically, as `SwipeDeck` does — but the rollback matters
    // more here, because a like that silently failed would count toward the
    // target and end the flow with less signal than the collector gave.
    setDecidedIds((previous) => new Set(previous).add(artwork.id));

    if (action === "like") {
      setLikedIds((previous) => new Set(previous).add(artwork.id));
    }

    startTransition(async () => {
      const result = await recordInteraction(artwork.id, action);

      if (!result.ok) {
        const drop = (previous: Set<string>) => {
          const next = new Set(previous);
          next.delete(artwork.id);
          return next;
        };

        setDecidedIds(drop);
        setLikedIds(drop);
        setError(result.message);
      }
    });
  }, []);

  // Both exit conditions live in `isOnboardingComplete` — see the note there on
  // why the rule is separable from this component.
  if (
    isOnboardingComplete({
      likeCount,
      hasNextCard: current !== null,
      isSaving: isPending,
    })
  ) {
    return <OnboardingHandoff />;
  }

  // Unreachable while `isComplete` is false — `current` is null only when the
  // pool is exhausted, which is the second exit condition above.
  if (!current) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      <ArtCard artwork={current} priority linkArtist={false} />

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => decide(current, "skip")}
          className="flex-1 rounded-lg border border-black/15 px-3 py-2.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Not for me
        </button>
        <button
          type="button"
          onClick={() => decide(current, "like")}
          className="flex-1 rounded-lg bg-foreground px-3 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Like
        </button>
      </div>

      {/* Progress toward the target, so the flow reads as finite. Skips are not
          counted: only likes end it, and implying otherwise would mislead. */}
      <p className="text-center text-xs opacity-60" aria-live="polite">
        {isPending
          ? "Saving…"
          : `${likeCount} of ${ONBOARDING_LIKE_TARGET} liked — like a few more to finish.`}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
