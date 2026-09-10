import { describe, expect, it } from "vitest";
import { selectNextCard } from "@/lib/artworks/deck";
import type { ArtworkWithArtist } from "@/types/domain";

/** Minimal fixture — only `id` and `title` matter to the selection rule. */
const artwork = (id: string, title = id): ArtworkWithArtist => ({
  id,
  title,
  artist_id: "artist-1",
  description: null,
  image_path: `artist-1/${id}.jpg`,
  tags: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  artist: { id: "artist-1", displayName: "Some Artist" },
});

const ids = (...values: string[]) => new Set(values);

describe("selectNextCard", () => {
  describe("core", () => {
    it("returns null current and zero remaining for an empty deck", () => {
      expect(selectNextCard([], ids())).toEqual({
        current: null,
        remaining: 0,
      });
    });

    it("returns the first entry as current when nothing is decided", () => {
      const deck = [artwork("a"), artwork("b"), artwork("c")];

      const result = selectNextCard(deck, ids());

      expect(result.current).toEqual(deck[0]);
      expect(result.remaining).toBe(deck.length);
    });

    it("returns null current and zero remaining once everything is decided", () => {
      const deck = [artwork("a"), artwork("b")];

      const result = selectNextCard(deck, ids("a", "b"));

      expect(result).toEqual({ current: null, remaining: 0 });
    });

    it("skips leading decided entries to find the first undecided one", () => {
      const deck = [artwork("a"), artwork("b"), artwork("c")];

      const result = selectNextCard(deck, ids("a"));

      expect(result.current).toEqual(deck[1]);
      expect(result.remaining).toBe(2);
    });
  });

  describe("churn regressions", () => {
    it("stays on an undecided piece when the deck is re-ordered between renders", () => {
      // Same three ids, same decided set, but the array identity and order
      // changed underneath — exactly what a refetch does. This is the
      // defect: an ordinal index would now read a decided card.
      const before = [artwork("a"), artwork("b"), artwork("c")];
      const after = [artwork("c"), artwork("a"), artwork("b")];
      const decided = ids("a");

      const beforeResult = selectNextCard(before, decided);
      const afterResult = selectNextCard(after, decided);

      expect(decided.has(beforeResult.current!.id)).toBe(false);
      expect(decided.has(afterResult.current!.id)).toBe(false);
    });

    it("skips over a decided piece that reappears lower in the deck (demotion tier)", () => {
      // S-01's demotion tier keeps a skipped piece in `deck`, just lower.
      const deck = [artwork("b"), artwork("c"), artwork("a")];
      const decided = ids("a");

      const result = selectNextCard(deck, decided);

      expect(result.current).toEqual(deck[0]);
      expect(result.current!.id).not.toBe("a");
    });

    it("does not subtract decided ids that are absent from the deck", () => {
      const deck = [artwork("a"), artwork("b")];
      // "liked-and-gone" and "also-gone" are decided but no longer in the
      // refetched deck (e.g. the server already dropped a liked piece).
      const decided = ids("liked-and-gone", "also-gone");

      const result = selectNextCard(deck, decided);

      expect(result.remaining).toBe(2);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it("restores a card as current after a rollback removes its id", () => {
      const deck = [artwork("a"), artwork("b")];
      const decidedAfterOptimisticAdd = ids("a");
      const decidedAfterRollback = ids(); // "a" deleted, deck unchanged

      const optimistic = selectNextCard(deck, decidedAfterOptimisticAdd);
      const rolledBack = selectNextCard(deck, decidedAfterRollback);

      expect(optimistic.current!.id).toBe("b");
      expect(rolledBack.current!.id).toBe("a");
    });
  });
});
