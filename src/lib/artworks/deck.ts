/**
 * Which card is "current" in a swipe deck, and how many remain.
 *
 * Deliberately free of "server-only": `SwipeDeck` (a Client Component) imports
 * this directly. `src/lib/artworks/queries.ts`, which *is* `server-only`, is
 * where `getSwipeDeck` lives — this is the pure sibling.
 *
 * `deck` is a prop that can be replaced wholesale between renders (a Server
 * Action mutation re-renders `/discover`, which re-runs `getSwipeDeck()`).
 * Position must therefore be keyed to artwork id, not array index — an
 * ordinal position silently reads the wrong card once the array underneath
 * it has moved. See `context/changes/swipe-deck-card-selection/repro.md` for
 * the observed failure mode this replaces.
 */

import type { ArtworkWithArtist } from "@/types/domain";

export type DeckSelection = {
  current: ArtworkWithArtist | null;
  remaining: number;
};

/**
 * The first artwork in `deck` whose id is not in `decidedIds`, plus how many
 * such entries remain. Both are derived from the same scan so the rendered
 * card and the counter can never disagree.
 *
 * `remaining` is deliberately not `deck.length - decidedIds.size`: ids in
 * `decidedIds` but absent from `deck` (e.g. a liked piece the server has
 * already dropped from a refetched deck) must not be subtracted, or the
 * count undercounts and can go negative.
 */
export function selectNextCard(
  deck: readonly ArtworkWithArtist[],
  decidedIds: ReadonlySet<string>,
): DeckSelection {
  let current: ArtworkWithArtist | null = null;
  let remaining = 0;

  for (const artwork of deck) {
    if (decidedIds.has(artwork.id)) continue;
    remaining += 1;
    if (current === null) current = artwork;
  }

  return { current, remaining };
}
