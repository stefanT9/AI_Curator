import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The module carries a session-scoped flag, so each test gets a fresh copy —
 * a dismissal in one must not leak into the next.
 */
async function loadModule() {
  vi.resetModules();
  return import("@/lib/artworks/first-run-hint");
}

/**
 * The Node lane has no `localStorage`, which is the point: the helper has to
 * behave on a viewer whose browser blocks site data just as it does on the
 * server render, and neither may throw.
 */
function installStorage(storage: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function throwingStorage() {
  const blocked = () => {
    throw new Error("site data blocked");
  };
  return { getItem: blocked, setItem: blocked };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("first-run hint storage", () => {
  it("renders nothing on the server, whatever the client later reads", async () => {
    const { firstRunHintServerSnapshot } = await loadModule();

    // "Seen" is what keeps the hint out of the server-rendered markup.
    expect(firstRunHintServerSnapshot()).toBe(true);
  });

  it("reports not-seen with no storage at all, and writing is a no-op", async () => {
    const { hasSeenFirstRunHint, markFirstRunHintSeen } = await loadModule();

    expect(hasSeenFirstRunHint()).toBe(false);
    expect(() => markFirstRunHintSeen()).not.toThrow();
  });

  it("round-trips the flag", async () => {
    installStorage(memoryStorage());
    const { hasSeenFirstRunHint, markFirstRunHintSeen } = await loadModule();

    expect(hasSeenFirstRunHint()).toBe(false);
    markFirstRunHintSeen();
    expect(hasSeenFirstRunHint()).toBe(true);
  });

  it("stays dismissed for the session even when the write throws", async () => {
    installStorage(throwingStorage());
    const { hasSeenFirstRunHint, markFirstRunHintSeen } = await loadModule();

    // Erring toward "not seen" on a cold read shows one extra hint; erring the
    // other way would suppress it for a viewer who never saw it.
    expect(hasSeenFirstRunHint()).toBe(false);

    expect(() => markFirstRunHintSeen()).not.toThrow();
    // Without the session backstop the hint would reappear the instant it was
    // dismissed, because the storage read still reports nothing.
    expect(hasSeenFirstRunHint()).toBe(true);
  });

  it("notifies subscribers on dismissal and stops after unsubscribe", async () => {
    installStorage(memoryStorage());
    const { markFirstRunHintSeen, subscribeToFirstRunHint } =
      await loadModule();

    const listener = vi.fn();
    const unsubscribe = subscribeToFirstRunHint(listener);

    // Same-tab writes fire no storage event, so this notification is the only
    // thing that re-renders the deck.
    markFirstRunHintSeen();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    markFirstRunHintSeen();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
