import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

// Hoisted: `vi.mock` factories run before module-level consts exist.
const { requireUser, tableResults, calls, createClient } = vi.hoisted(() => {
  const tableResults: Record<string, { data: unknown; error: unknown }> = {};
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  /**
   * A PostgREST builder stand-in: every filter returns the builder, and
   * awaiting it yields whatever result the test registered for that table.
   */
  const makeBuilder = (table: string) => {
    const result = (): Result =>
      tableResults[table] ?? { data: [], error: null };

    const builder: Record<string, unknown> = {
      then: (resolve: (value: Result) => unknown) => resolve(result()),
    };

    for (const method of [
      "select",
      "overlaps",
      "neq",
      "eq",
      "in",
      "not",
      "order",
      "limit",
    ]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }

    return builder;
  };

  return {
    requireUser: vi.fn(),
    tableResults,
    calls,
    createClient: vi.fn(async () => ({ from: makeBuilder })),
  };
});

vi.mock("@/lib/auth/dal", () => ({ requireUser }));
vi.mock("@/utils/supabase/server", () => ({ createClient }));

import { getStarterDeck } from "@/lib/artworks/queries";

const TERMS = ["abstract", "geometric"];

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
  requireUser.mockResolvedValue({ id: "user-1", email: null });
});

describe("getStarterDeck", () => {
  it("returns an empty array without querying when no terms were chosen", async () => {
    expect(await getStarterDeck([])).toEqual([]);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns an empty array without throwing when nothing matches the terms", async () => {
    tableResults.interactions = { data: [], error: null };
    tableResults.artworks = { data: [], error: null };

    expect(await getStarterDeck(TERMS)).toEqual([]);
  });

  it("matches on tag overlap and excludes the caller's own artworks", async () => {
    tableResults.interactions = { data: [], error: null };
    tableResults.artworks = { data: [], error: null };

    await getStarterDeck(TERMS);

    expect(calls).toContainEqual({
      table: "artworks",
      method: "overlaps",
      args: ["tags", TERMS],
    });
    expect(calls).toContainEqual({
      table: "artworks",
      method: "neq",
      args: ["artist_id", "user-1"],
    });
  });

  it("excludes artworks the collector has already rated", async () => {
    tableResults.interactions = {
      data: [{ artwork_id: "art-1" }, { artwork_id: "art-2" }],
      error: null,
    };
    tableResults.artworks = { data: [], error: null };

    await getStarterDeck(TERMS);

    expect(calls).toContainEqual({
      table: "artworks",
      method: "not",
      args: ["id", "in", '("art-1","art-2")'],
    });
  });

  it("skips the exclusion filter entirely when nothing has been rated", async () => {
    tableResults.interactions = { data: [], error: null };
    tableResults.artworks = { data: [], error: null };

    await getStarterDeck(TERMS);

    expect(calls.some((call) => call.method === "not")).toBe(false);
  });

  it("attaches artists to the rows it finds", async () => {
    tableResults.interactions = { data: [], error: null };
    tableResults.artworks = {
      data: [{ id: "art-1", artist_id: "artist-1", tags: ["abstract"] }],
      error: null,
    };
    tableResults.profiles = {
      data: [{ id: "artist-1", display_name: "Ada" }],
      error: null,
    };

    const deck = await getStarterDeck(TERMS);

    expect(deck).toHaveLength(1);
    expect(deck[0].artist).toEqual({ id: "artist-1", displayName: "Ada" });
  });

  it("throws when the artwork query errors", async () => {
    tableResults.interactions = { data: [], error: null };
    tableResults.artworks = { data: null, error: { message: "boom" } };

    await expect(getStarterDeck(TERMS)).rejects.toThrow("boom");
  });
});
