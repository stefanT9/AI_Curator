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

    for (const method of [
      "select",
      "eq",
      "in",
      "is",
      "gt",
      "gte",
      "or",
      "order",
      "limit",
    ]) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }

    // Terminal, unlike the filters above: it resolves rather than chaining, so
    // a `maybeSingle` read registers its result directly (a row, not an array).
    builder.maybeSingle = (...args: unknown[]) => {
      calls.push({ table, method: "maybeSingle", args });
      return Promise.resolve(result());
    };

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
  CLOSED_AUCTIONS_LIMIT,
  getAuction,
  getLiveAuctionsByArtwork,
  getMyClosedAuctions,
  getOpenAuctions,
  getOwnBid,
  getOwnBidAuctionIds,
} from "@/lib/auctions/queries";

const AUCTION_ROW = {
  id: "auction-1",
  artwork_id: "art-1",
  seller_id: "artist-1",
  starting_price_cents: 1000,
  ends_at: "2026-01-01T00:00:00.000Z",
  cancelled_at: null,
  closed_at: null,
  winning_bid_id: null,
  winning_amount_cents: null,
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
  it("applies every term of the openness predicate", async () => {
    tableResults.auctions = { data: [], error: null };

    await getOpenAuctions();

    expect(calls).toContainEqual({
      table: "auctions",
      method: "is",
      args: ["cancelled_at", null],
    });
    expect(calls).toContainEqual({
      table: "auctions",
      method: "is",
      args: ["closed_at", null],
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

// `getAuction` and `getOwnBid` are wrapped in React's `cache`, so each case
// uses a distinct id rather than relying on the memo being cold.
describe("getAuction", () => {
  it("reads by id without the openness predicate, so an ended auction still resolves", async () => {
    tableResults.auctions = {
      data: { ...AUCTION_ROW, id: "auction-by-id" },
      error: null,
    };
    tableResults.artworks = {
      data: [{ id: "art-1", artist_id: "artist-1", title: "Piece" }],
      error: null,
    };
    tableResults.profiles = {
      data: [{ id: "artist-1", display_name: "Ada" }],
      error: null,
    };

    const auction = await getAuction("auction-by-id");

    expect(auction?.id).toBe("auction-by-id");
    expect(auction?.artwork.artist).toEqual({
      id: "artist-1",
      displayName: "Ada",
    });
    expect(calls).toContainEqual({
      table: "auctions",
      method: "eq",
      args: ["id", "auction-by-id"],
    });
    expect(
      calls.some(
        (call) =>
          call.table === "auctions" &&
          (call.method === "is" || call.method === "gt"),
      ),
    ).toBe(false);
  });

  it("returns null for an unknown id without resolving artworks", async () => {
    tableResults.auctions = { data: null, error: null };

    const auction = await getAuction("auction-missing");

    expect(auction).toBeNull();
    expect(fromCalls).not.toContain("artworks");
  });
});

describe("getOwnBid", () => {
  const BID_ROW = {
    id: "bid-1",
    auction_id: "auction-own-bid",
    bidder_id: "collector-1",
    amount_cents: 15000,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };

  it("filters by auction only — the select policy is what scopes it to the caller", async () => {
    tableResults.bids = { data: BID_ROW, error: null };

    const bid = await getOwnBid("auction-own-bid");

    expect(bid).toEqual(BID_ROW);
    expect(calls).toContainEqual({
      table: "bids",
      method: "eq",
      args: ["auction_id", "auction-own-bid"],
    });
    expect(
      calls.some(
        (call) => call.table === "bids" && call.args[0] === "bidder_id",
      ),
    ).toBe(false);
  });

  it("returns null when the caller has not bid", async () => {
    tableResults.bids = { data: null, error: null };

    expect(await getOwnBid("auction-no-bid")).toBeNull();
  });
});

describe("getMyClosedAuctions", () => {
  const viewerId = "collector-1";

  const orArg = () =>
    calls.find((call) => call.table === "auctions" && call.method === "or")
      ?.args[0];

  it("asks for the viewer's bids without a bidder_id filter — the policy scopes it", async () => {
    tableResults.bids = { data: [{ auction_id: "auction-1" }], error: null };
    tableResults.auctions = { data: [], error: null };

    await getMyClosedAuctions(viewerId);

    expect(fromCalls.filter((table) => table === "bids")).toHaveLength(1);
    expect(
      calls.some(
        (call) => call.table === "bids" && call.args[0] === "bidder_id",
      ),
    ).toBe(false);
  });

  it("matches auctions the viewer sold or bid on, in one disjunction", async () => {
    tableResults.bids = {
      data: [{ auction_id: "auction-1" }, { auction_id: "auction-1" }],
      error: null,
    };
    tableResults.auctions = { data: [], error: null };

    await getMyClosedAuctions(viewerId);

    // Deduplicated: two bid rows on one auction contribute one id.
    expect(orArg()).toBe(`seller_id.eq.${viewerId},id.in.(auction-1)`);
  });

  it("asks the narrower seller-only question when the viewer has never bid", async () => {
    tableResults.bids = { data: [], error: null };
    tableResults.auctions = { data: [], error: null };

    await getMyClosedAuctions(viewerId);

    // `id.in.()` is not valid PostgREST, so there must be no disjunction here.
    expect(orArg()).toBeUndefined();
    expect(calls).toContainEqual({
      table: "auctions",
      method: "eq",
      args: ["seller_id", viewerId],
    });
  });

  it("bounds the result to a recent window, newest close first", async () => {
    tableResults.bids = { data: [], error: null };
    tableResults.auctions = { data: [], error: null };

    await getMyClosedAuctions(viewerId);

    // `gte` on `closed_at` is also what excludes auctions that never closed:
    // a null never satisfies it.
    expect(
      calls.some(
        (call) =>
          call.table === "auctions" &&
          call.method === "gte" &&
          call.args[0] === "closed_at",
      ),
    ).toBe(true);
    expect(calls).toContainEqual({
      table: "auctions",
      method: "order",
      args: ["closed_at", { ascending: false }],
    });
    expect(calls).toContainEqual({
      table: "auctions",
      method: "limit",
      args: [CLOSED_AUCTIONS_LIMIT],
    });
  });

  it("resolves artwork attribution for each closed auction", async () => {
    tableResults.bids = { data: [], error: null };
    tableResults.auctions = {
      data: [{ ...AUCTION_ROW, closed_at: "2026-01-02T00:00:00.000Z" }],
      error: null,
    };
    tableResults.artworks = {
      data: [{ id: "art-1", artist_id: "artist-1", title: "Piece" }],
      error: null,
    };
    tableResults.profiles = {
      data: [{ id: "artist-1", display_name: "Ada" }],
      error: null,
    };

    const closed = await getMyClosedAuctions(viewerId);

    expect(closed).toHaveLength(1);
    expect(closed[0].artwork.artist).toEqual({
      id: "artist-1",
      displayName: "Ada",
    });
  });

  it("throws when the bids query errors", async () => {
    tableResults.bids = { data: null, error: { message: "boom" } };

    await expect(getMyClosedAuctions(viewerId)).rejects.toThrow("boom");
  });

  it("throws when the auctions query errors", async () => {
    tableResults.bids = { data: [], error: null };
    tableResults.auctions = { data: null, error: { message: "boom" } };

    await expect(getMyClosedAuctions(viewerId)).rejects.toThrow("boom");
  });
});

describe("getOwnBidAuctionIds", () => {
  it("issues one query for a whole page of auction ids", async () => {
    tableResults.bids = {
      data: [{ auction_id: "auction-1" }, { auction_id: "auction-3" }],
      error: null,
    };

    const ids = await getOwnBidAuctionIds(["auction-1", "auction-2"]);

    expect(fromCalls.filter((table) => table === "bids")).toHaveLength(1);
    expect(calls).toContainEqual({
      table: "bids",
      method: "in",
      args: ["auction_id", ["auction-1", "auction-2"]],
    });
    expect(ids).toEqual(new Set(["auction-1", "auction-3"]));
  });

  it("selects no amount — the badge says that you bid, never how much", async () => {
    tableResults.bids = { data: [], error: null };

    await getOwnBidAuctionIds(["auction-1"]);

    expect(calls).toContainEqual({
      table: "bids",
      method: "select",
      args: ["auction_id"],
    });
  });

  it("returns an empty set without querying for an empty id list", async () => {
    const ids = await getOwnBidAuctionIds([]);

    expect(ids.size).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("throws when the bids query errors", async () => {
    tableResults.bids = { data: null, error: { message: "boom" } };

    await expect(getOwnBidAuctionIds(["auction-1"])).rejects.toThrow("boom");
  });
});
