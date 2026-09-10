/**
 * Whether the collector has already been shown the swipe affordances.
 *
 * This is a per-viewer convenience, not durable state. It lives in
 * `localStorage` rather than on `profiles` deliberately: `onboarded_at` answers
 * "may this account enter the app", and overloading it with a UI dismissal
 * would make a mandatory gate depend on whether someone clicked "Got it".
 * Losing the flag (a new browser, cleared site data, a private window) costs a
 * collector one extra hint — an acceptable failure.
 *
 * Every access is wrapped: some browsers throw on the *accessor* itself when
 * site data is blocked, so `typeof window` alone is not enough of a guard.
 *
 * Deliberately free of "server-only": `SwipeDeck` (a Client Component) imports
 * this, and it is the pure sibling of the rendering it drives.
 */

const STORAGE_KEY = "artswipe:swipe-hint-seen";

/**
 * `localStorage` fires no event for writes from the same tab, so the store
 * publishes its own. Without this the hint would stay on screen after being
 * dismissed until something else re-rendered.
 */
const listeners = new Set<() => void>();

/**
 * Backstop for the case where the write throws: without it the snapshot would
 * still read "not seen" and the hint would reappear the instant it was
 * dismissed. This lasts the session only, which is the right lifetime — nothing
 * was persisted, so nothing should survive a reload.
 */
let dismissedThisSession = false;

export function subscribeToFirstRunHint(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * The snapshot to use where there is no storage to read: during the server
 * render and the hydration pass that must match it. "Seen" keeps the hint out
 * of the server-rendered markup, so it can only ever appear after the client
 * has actually consulted storage — never as a flash of the wrong state.
 */
export function firstRunHintServerSnapshot(): boolean {
  return true;
}

/**
 * True only when the flag was read back successfully. Anything else — no
 * storage, a throwing accessor, a missing key — reports "not yet seen", so the
 * hint shows again rather than being silently suppressed.
 */
export function hasSeenFirstRunHint(): boolean {
  if (dismissedThisSession) return true;

  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Best-effort. A failed write means the hint returns next visit, nothing more. */
export function markFirstRunHintSeen(): void {
  dismissedThisSession = true;

  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, "1");
  } catch {
    // Ignored: see the note above on blocked site data. Subscribers are still
    // notified — the hint closes for this session even where nothing persists.
  }

  for (const listener of listeners) listener();
}
