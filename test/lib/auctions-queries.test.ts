import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data: unknown; error: unknown };

// Hoisted: `vi.mock` factories run before module-level consts exist.
const { tableResults, calls, fromCalls, createClient } = vi.hoisted(() => {
  const tableResults: Record<string, Result> = {};
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const fromCalls: string[] = [];

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

    for (const method of ["select", "eq", "in", "is", "gt", "order"]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }

    return builder;
  };

  return {
    tableResults,
    calls,
    fromCalls,
    createClient: vi.fn(async () => ({
      from: (table: string) => {
        fromCalls.push(table);
        return makeBuilder(table);
      },
    })),
  };
});

vi.mock("@/utils/supabase/server", () => ({ createClient }));

import {
  getLiveAuctionsByArtwork,
  getOpenAuctions,
} from "@/lib/auctions/queries";

const AUCTION_ROW = {
  id: "auction-1",
  artwork_id: "art-1",
  seller_id: "artist-1",
  starting_price_cents: 1000,
  ends_at: "2026-01-01T00:00:00.000Z",
  cancelled_at: null,
  created_at: "2025-12-25T00:00:00.000Z",
  updated_at: "2025-12-25T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  fromCalls.length = 0;
  for (const key of Object.keys(tableResults)) delete tableResults[key];
});

describe("getOpenAuctions", () => {
  it("applies both halves of the openness predicate", async () => {
    tableResults.auctions = { data: [], error: null };

    await getOpenAuctions();

    expect(calls).toContainEqual({
      table: "auctions",
      method: "is",
      args: ["cancelled_at", null],
    });
    expect(
      calls.some(
        (call) =>
          call.table === "auctions" &&
          call.method === "gt" &&
          call.args[0] === "ends_at",
      ),
    ).toBe(true);
  });

  it("orders by ends_at ascending, so the soonest-closing auction is first", async () => {
    tableResults.auctions = { data: [], error: null };

    await getOpenAuctions();

    expect(calls).toContainEqual({
      table: "auctions",
      method: "order",
      args: ["ends_at", { ascending: true }],
    });
  });

  it("resolves artwork and artist attribution for each auction", async () => {
    tableResults.auctions = { data: [AUCTION_ROW], error: null };
    tableResults.artworks = {
      data: [{ id: "art-1", artist_id: "artist-1", title: "Piece" }],
      error: null,
    };
    tableResults.profiles = {
      data: [{ id: "artist-1", display_name: "Ada" }],
      error: null,
    };

    const auctions = await getOpenAuctions();

    expect(auctions).toHaveLength(1);
    expect(auctions[0].artwork.artist).toEqual({
      id: "artist-1",
      displayName: "Ada",
    });
  });

  it("returns an empty array without querying artworks when nothing is open", async () => {
    tableResults.auctions = { data: [], error: null };

    const auctions = await getOpenAuctions();

    expect(auctions).toEqual([]);
    expect(fromCalls).not.toContain("artworks");
  });

  it("throws when the auction query errors", async () => {
    tableResults.auctions = { data: null, error: { message: "boom" } };

    await expect(getOpenAuctions()).rejects.toThrow("boom");
  });
});

describe("getLiveAuctionsByArtwork", () => {
  it("issues one query for many ids", async () => {
    tableResults.auctions = { data: [], error: null };

    await getLiveAuctionsByArtwork(["art-1", "art-2", "art-3"]);

    expect(fromCalls.filter((table) => table === "auctions")).toHaveLength(1);
    expect(calls).toContainEqual({
      table: "auctions",
      method: "in",
      args: ["artwork_id", ["art-1", "art-2", "art-3"]],
    });
  });

  it("returns a map keyed by artwork id", async () => {
    tableResults.auctions = { data: [AUCTION_ROW], error: null };

    const result = await getLiveAuctionsByArtwork(["art-1"]);

    expect(result.get("art-1")).toEqual(AUCTION_ROW);
  });

  it("returns an empty map without querying for an empty id list", async () => {
    const result = await getLiveAuctionsByArtwork([]);

    expect(result.size).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
  });
});
