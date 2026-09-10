/**
 * First-run orientation for the swipe surface: the three ways to register a
 * verdict, shown once and then gone.
 *
 * Presentational only — whether it should appear, and the `localStorage` flag
 * behind that, are `SwipeDeck`'s, because the same flag is set by the first
 * verdict as well as by the dismiss button.
 */
export function FirstRunHint({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2.5 text-xs dark:border-white/15 dark:bg-white/[0.06]">
      <p className="flex-1 opacity-80">
        <span className="font-medium opacity-100">Three ways to decide:</span>{" "}
        drag the card left or right, tap Skip or Like, or press{" "}
        <kbd className="rounded border border-black/20 px-1 dark:border-white/25">
          &larr;
        </kbd>{" "}
        and{" "}
        <kbd className="rounded border border-black/20 px-1 dark:border-white/25">
          &rarr;
        </kbd>
        .
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-opacity hover:opacity-70"
      >
        Got it
      </button>
    </div>
  );
}
