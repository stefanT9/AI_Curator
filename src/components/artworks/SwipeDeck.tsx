"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { recordInteraction } from "@/app/actions/interactions";
import { ArtCard } from "@/components/artworks/ArtCard";
import type {
  Artwork,
  ArtworkWithArtist,
  InteractionAction,
} from "@/types/domain";

/** How far a card must travel before the drag counts as a verdict. */
const COMMIT_THRESHOLD_PX = 100;

export function SwipeDeck({ deck }: { deck: ArtworkWithArtist[] }) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Only ever touched inside pointer handlers, never during render.
  const pointerStartX = useRef<number | null>(null);
  const current = deck[index];

  const decide = useCallback(
    (artwork: Artwork, action: InteractionAction) => {
      setError(null);
      setDragX(0);

      // Advance first — waiting on the round trip would make every swipe feel
      // like a page load. The card comes back if the write fails.
      setIndex((previous) => previous + 1);

      startTransition(async () => {
        const result = await recordInteraction(artwork.id, action);

        if (!result.ok) {
          setIndex((previous) => Math.max(0, previous - 1));
          setError(result.message);
        }
      });
    },
    [],
  );

  // Arrow keys are the keyboard equivalent of the drag; the buttons below are
  // the pointer-free path for everyone else.
  useEffect(() => {
    if (!current) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        decide(current, "skip");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        decide(current, "like");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, decide]);

  if (!current) {
    return <EmptyDeck />;
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerStartX.current = event.clientX;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerStartX.current === null) return;
    setDragX(event.clientX - pointerStartX.current);
  };

  const onPointerEnd = () => {
    if (pointerStartX.current === null) return;
    pointerStartX.current = null;
    setIsDragging(false);

    if (Math.abs(dragX) >= COMMIT_THRESHOLD_PX) {
      decide(current, dragX > 0 ? "like" : "skip");
    } else {
      setDragX(0);
    }
  };

  const verdict =
    Math.abs(dragX) >= COMMIT_THRESHOLD_PX
      ? dragX > 0
        ? "like"
        : "skip"
      : null;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={{
          transform: `translateX(${dragX}px) rotate(${dragX / 25}deg)`,
          // Snap back under animation, but follow the finger without lag.
          transition: isDragging ? undefined : "transform 150ms ease-out",
        }}
        className="relative touch-pan-y select-none"
      >
        {/* No artist link on the top card: a drag that ends on the anchor
            would navigate instead of registering a verdict. */}
        <ArtCard artwork={current} priority linkArtist={false} />

        {verdict ? (
          <span
            aria-hidden
            className={`absolute top-4 rounded-lg border-2 px-3 py-1 text-sm font-semibold uppercase ${
              verdict === "like"
                ? "left-4 rotate-[-8deg] border-emerald-500 text-emerald-500"
                : "right-4 rotate-[8deg] border-red-500 text-red-500"
            }`}
          >
            {verdict}
          </span>
        ) : null}
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => decide(current, "skip")}
          className="flex-1 rounded-lg border border-black/15 px-3 py-2.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
        >
          Skip
        </button>
        <button
          type="button"
          onClick={() => decide(current, "like")}
          className="flex-1 rounded-lg bg-foreground px-3 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Like
        </button>
      </div>

      <div className="flex items-center justify-between text-xs opacity-60">
        <Link href={`/artwork/${current.id}`} className="underline">
          View details
        </Link>
        <span aria-live="polite">
          {isPending ? "Saving…" : `${deck.length - index} left`}
        </span>
      </div>

      <p className="text-center text-xs opacity-50">
        Drag the card, use the buttons, or press ← and →.
      </p>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EmptyDeck() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-dashed border-black/15 p-8 text-center dark:border-white/20">
      <h2 className="font-semibold tracking-tight">Nothing left to rate</h2>
      <p className="text-sm opacity-70">
        You&rsquo;ve seen everything in the catalog for now. Check back as
        artists upload new work.
      </p>
      <Link href="/liked" className="text-sm underline">
        Browse what you liked
      </Link>
    </div>
  );
}
