/**
 * S-02: proves the sealed half of the auction for real, under real RLS, before
 * any UI rests on the assumption that it holds.
 *
 * `npm run test` mocks Supabase entirely, so it can assert that `placeBid`
 * *calls* `rpc("place_bid", ...)` and maps BID00-BID04 to the right form state,
 * but not that the database refuses what the design says it refuses. Two
 * guardrails are only checkable here and neither can be retrofitted:
 *
 *   - **Sealed means sealed.** A cross-user read of `bids` returns zero rows,
 *     and so does the *seller's* read of bids on their own auction. That is a
 *     property of the one select policy, not of any query — which is why it is
 *     asserted against a real policy and not a mock that could be written to
 *     agree with the caller.
 *   - **Bidding is correct under concurrency.** Two simultaneous raises leave
 *     exactly one row holding the higher amount. That is a property of
 *     `place_bid`'s row lock and the `(auction_id, bidder_id)` unique
 *     constraint; a mocked Supabase has no locks to test.
 *
 * It also pins the closed mutation surface `auctions` established and `bids`
 * inherits — a direct PostgREST insert, update, or delete against `bids` gets
 * nowhere — and exercises FR-002's lock for the first time: `cancel_auction`
 * returns false once a bid exists.
 *
 * Three users, one file (`sign_in_sign_ups` is rate-limited to 30 per 5
 * minutes per IP): `seller` is the artist behind every fixture auction,
 * `bidder` is the collector who bids, `foil` is the second collector whose
 * whole job is to see nothing.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  createTestCollector,
  TINY_PNG,
  type TestArtist,
  type TestCollector,
} from "./helpers";

type FixtureKey =
  | "atFloor"
  | "belowFloor"
  | "sellerBids"
  | "raise"
  | "lowerResubmission"
  | "cancelledAuction"
  | "insertRefusal"
  | "updateRefusal"
  | "deleteRefusal"
  | "sealedRead"
  | "sellerRead"
  | "cancelLock"
  | "raceSameBidder"
  | "raceTwoBidders";

const FIXTURE_KEYS: FixtureKey[] = [
  "atFloor",
  "belowFloor",
  "sellerBids",
  "raise",
  "lowerResubmission",
  "cancelledAuction",
  "insertRefusal",
  "updateRefusal",
  "deleteRefusal",
  "sealedRead",
  "sellerRead",
  "cancelLock",
  "raceSameBidder",
  "raceTwoBidders",
];

let seller: TestArtist;
let bidder: TestCollector;
let foil: TestCollector;

/** Fixture artwork id by key — every one owned by `seller`. */
const artworkIds = new Map<FixtureKey, string>();

/** Auction id by key, created lazily by `openAuction`. */
const auctionIds = new Map<FixtureKey, string>();

/**
 * Open an auction on the fixture artwork for `key` and remember its id.
 *
 * One live auction per artwork is all `create_auction` permits (AUC04), and
 * each key has its own artwork, so a key maps to exactly one auction for the
 * life of the run.
 */
const openAuction = async (
  key: FixtureKey,
  startingPriceCents: number,
): Promise<string> => {
  const artworkId = artworkIds.get(key);
  if (!artworkId) throw new Error(`Fixture artwork ${key} was not created`);

  const { data, error } = await seller.client.rpc("create_auction", {
    p_artwork_id: artworkId,
    p_duration_hours: 24,
    p_starting_price_cents: startingPriceCents,
  });

  if (error || !data) {
    throw new Error(`Could not open the ${key} auction: ${error?.message}`);
  }

  auctionIds.set(key, data);
  return data;
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();

  [seller, bidder, foil] = await Promise.all([
    createTestArtist(stack),
    createTestCollector(stack),
    createTestCollector(stack),
  ]);

  // One object, reused by every fixture row — this spec asserts bid rules and
  // RLS behaviour, not rendering, so a shared image is fine (the same shortcut
  // `auctions.int.ts` and `swipe-deck.int.ts` take).
  const imagePath = await seller.upload(TINY_PNG);

  const { data: rows, error } = await seller.client
    .from("artworks")
    .insert(
      FIXTURE_KEYS.map((key) => ({
        artist_id: seller.userId,
        title: `S-02 bids ${key}`,
        image_path: imagePath,
      })),
    )
    .select("id, title");

  if (error || !rows) {
    throw new Error(`Could not insert fixture artworks: ${error?.message}`);
  }

  for (const row of rows) {
    artworkIds.set(row.title.replace("S-02 bids ", "") as FixtureKey, row.id);
  }
});

afterAll(async () => {
  // `bids` has no delete policy of its own — that is the point of this file —
  // so nothing here deletes a bid directly. Deleting the fixture artworks
  // clears the auctions via `on delete cascade`, and those clear their bids
  // the same way.
  await Promise.all([seller?.cleanup(), bidder?.cleanup(), foil?.cleanup()]);
});

describe("place_bid", () => {
  it("accepts a bid at exactly the starting price", async () => {
    const auctionId = await openAuction("atFloor", 2_500);

    const { error } = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 2_500,
    });
    expect(error).toBeNull();

    const { data: row, error: selectError } = await bidder.client
      .from("bids")
      .select("*")
      .eq("auction_id", auctionId)
      .single();

    expect(selectError).toBeNull();
    expect(row?.bidder_id).toBe(bidder.userId);
    expect(row?.amount_cents).toBe(2_500);
  });

  it("refuses a bid one cent below the starting price (BID03)", async () => {
    const auctionId = await openAuction("belowFloor", 2_500);

    const { error } = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 2_499,
    });
    expect(error?.code).toBe("BID03");

    const { data: rows } = await bidder.client
      .from("bids")
      .select("id")
      .eq("auction_id", auctionId);
    expect(rows).toHaveLength(0);
  });

  it("refuses the seller bidding on their own auction (BID02)", async () => {
    const auctionId = await openAuction("sellerBids", 1_000);

    const { error } = await seller.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 5_000,
    });
    expect(error?.code).toBe("BID02");
  });

  it("refuses a bid on a cancelled auction (BID01)", async () => {
    const auctionId = await openAuction("cancelledAuction", 1_000);

    const cancelled = await seller.client.rpc("cancel_auction", {
      p_auction_id: auctionId,
    });
    expect(cancelled.data).toBe(true);

    const { error } = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 5_000,
    });
    expect(error?.code).toBe("BID01");

    // A missing auction is the same refusal, deliberately: the function tells
    // a non-participant nothing about someone else's auction.
    const missing = await bidder.client.rpc("place_bid", {
      p_auction_id: crypto.randomUUID(),
      p_amount_cents: 5_000,
    });
    expect(missing.error?.code).toBe("BID01");
  });
});

describe("raising a bid", () => {
  it("updates the same row rather than adding one, and moves updated_at forward", async () => {
    const auctionId = await openAuction("raise", 1_000);

    const first = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 1_500,
    });
    expect(first.error).toBeNull();

    const { data: before } = await bidder.client
      .from("bids")
      .select("id, amount_cents, created_at, updated_at")
      .eq("auction_id", auctionId)
      .single();
    expect(before?.amount_cents).toBe(1_500);

    const second = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 4_000,
    });
    expect(second.error).toBeNull();

    const { data: after } = await bidder.client
      .from("bids")
      .select("id, amount_cents, created_at, updated_at")
      .eq("auction_id", auctionId);

    // One row, the same row, holding the raised amount.
    expect(after).toHaveLength(1);
    expect(after?.[0].id).toBe(before?.id);
    expect(after?.[0].amount_cents).toBe(4_000);
    expect(after?.[0].created_at).toBe(before?.created_at);

    // `updated_at` is what FR-008's tie-break will compare, so it has to move
    // when the standing amount does — that is the `bids_set_updated_at`
    // trigger firing on the `on conflict do update` path.
    expect(new Date(after![0].updated_at).getTime()).toBeGreaterThan(
      new Date(before!.updated_at).getTime(),
    );
  });

  it("refuses a lower or equal resubmission (BID04) and leaves the amount alone", async () => {
    const auctionId = await openAuction("lowerResubmission", 1_000);

    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 3_000,
    });
    expect(placed.error).toBeNull();

    const lower = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 2_000,
    });
    expect(lower.error?.code).toBe("BID04");

    const equal = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 3_000,
    });
    expect(equal.error?.code).toBe("BID04");

    const { data: rows } = await bidder.client
      .from("bids")
      .select("amount_cents")
      .eq("auction_id", auctionId);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].amount_cents).toBe(3_000);
  });
});

describe("the closed mutation surface", () => {
  it("refuses a direct PostgREST insert into bids", async () => {
    const auctionId = await openAuction("insertRefusal", 1_000);

    const { error } = await bidder.client
      .from("bids")
      .insert({
        auction_id: auctionId,
        bidder_id: bidder.userId,
        amount_cents: 9_999,
      })
      .select();

    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");

    const { data: rows } = await bidder.client
      .from("bids")
      .select("id")
      .eq("auction_id", auctionId);
    expect(rows).toHaveLength(0);
  });

  it("refuses a direct update of the caller's own bid row (raising goes through the RPC)", async () => {
    const auctionId = await openAuction("updateRefusal", 1_000);

    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 2_000,
    });
    expect(placed.error).toBeNull();

    // RLS is enabled with no UPDATE policy on this table. Unlike INSERT (where
    // the new row must pass a WITH CHECK or the statement errors), Postgres's
    // UPDATE path with no matching policy simply admits no rows to the USING
    // filter — the same silent-no-op shape `auctions.int.ts` records. What
    // matters for FR-007 is observable either way: the stored amount does not
    // move, so there is no path that lowers a bid.
    await bidder.client
      .from("bids")
      .update({ amount_cents: 1 })
      .eq("auction_id", auctionId);

    const { data: rows } = await bidder.client
      .from("bids")
      .select("amount_cents")
      .eq("auction_id", auctionId);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].amount_cents).toBe(2_000);
  });

  it("refuses a direct delete of the caller's own bid row (nothing withdraws a bid)", async () => {
    const auctionId = await openAuction("deleteRefusal", 1_000);

    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 2_000,
    });
    expect(placed.error).toBeNull();

    await bidder.client.from("bids").delete().eq("auction_id", auctionId);

    const { data: rows } = await bidder.client
      .from("bids")
      .select("id")
      .eq("auction_id", auctionId);
    expect(rows).toHaveLength(1);
  });
});

describe("sealed means sealed", () => {
  it("shows another collector zero rows and a count of zero, not an error", async () => {
    const auctionId = await openAuction("sealedRead", 1_000);

    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 7_500,
    });
    expect(placed.error).toBeNull();

    const { data: rows, error } = await foil.client
      .from("bids")
      .select("*")
      .eq("auction_id", auctionId);

    // Zero rows rather than a refusal: a caller that forgets to filter by
    // bidder leaks nothing, and learns nothing from the failure mode either.
    expect(error).toBeNull();
    expect(rows).toHaveLength(0);

    // A count is the read that would leak "someone has bid" without leaking an
    // amount. It must be 0, not 1.
    const { count, error: countError } = await foil.client
      .from("bids")
      .select("*", { count: "exact", head: true })
      .eq("auction_id", auctionId);

    expect(countError).toBeNull();
    expect(count).toBe(0);
  });

  it("shows the seller zero rows on their own auction", async () => {
    const auctionId = await openAuction("sellerRead", 1_000);

    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 6_000,
    });
    expect(placed.error).toBeNull();

    const { data: rows, error } = await seller.client
      .from("bids")
      .select("*")
      .eq("auction_id", auctionId);

    // The seller's exclusion from the select policy is deliberate, not an
    // omission: §Guardrails exposes no bid count to *anyone* before close.
    expect(error).toBeNull();
    expect(rows).toHaveLength(0);

    const { count } = await seller.client
      .from("bids")
      .select("*", { count: "exact", head: true })
      .eq("auction_id", auctionId);
    expect(count).toBe(0);
  });
});

describe("FR-002's lock", () => {
  it("refuses to cancel an auction once a bid exists, leaving it open", async () => {
    const auctionId = await openAuction("cancelLock", 1_000);

    // Cancellable right up until the first bid: S-01 already proved the
    // untouched case, so what is new here is the transition.
    const placed = await bidder.client.rpc("place_bid", {
      p_auction_id: auctionId,
      p_amount_cents: 1_000,
    });
    expect(placed.error).toBeNull();

    const cancelled = await seller.client.rpc("cancel_auction", {
      p_auction_id: auctionId,
    });
    expect(cancelled.error).toBeNull();
    expect(cancelled.data).toBe(false);

    const { data: row } = await seller.client
      .from("auctions")
      .select("cancelled_at, ends_at")
      .eq("id", auctionId)
      .single();

    expect(row?.cancelled_at).toBeNull();
    expect(new Date(row!.ends_at).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("concurrency", () => {
  it("resolves two simultaneous raises from one bidder to a single row at the higher amount", async () => {
    const auctionId = await openAuction("raceSameBidder", 1_000);

    // Issued together, deliberately without awaiting the first: the point is
    // that `place_bid`'s `for update` on the auction row serialises them.
    // Whichever lands first, the conflict path's `where` refuses the lower of
    // the two, so the surviving amount is the higher one either way.
    const [low, high] = await Promise.all([
      bidder.client.rpc("place_bid", {
        p_auction_id: auctionId,
        p_amount_cents: 2_000,
      }),
      bidder.client.rpc("place_bid", {
        p_auction_id: auctionId,
        p_amount_cents: 5_000,
      }),
    ]);

    // At most one refusal, and only ever BID04 on the lower amount — never a
    // unique-violation (23505) from two inserts colliding on
    // `bids_one_per_bidder`, which is what the upsert exists to prevent.
    for (const result of [low, high]) {
      if (result.error) expect(result.error.code).toBe("BID04");
    }
    expect(high.error).toBeNull();

    const { data: rows } = await bidder.client
      .from("bids")
      .select("amount_cents")
      .eq("auction_id", auctionId);

    expect(rows).toHaveLength(1);
    expect(rows?.[0].amount_cents).toBe(5_000);
  });

  it("lets two different bidders bid simultaneously, one row each", async () => {
    const auctionId = await openAuction("raceTwoBidders", 1_000);

    const [first, second] = await Promise.all([
      bidder.client.rpc("place_bid", {
        p_auction_id: auctionId,
        p_amount_cents: 3_000,
      }),
      foil.client.rpc("place_bid", {
        p_auction_id: auctionId,
        p_amount_cents: 4_000,
      }),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    // Each sees exactly their own row — the select policy holding under
    // concurrency as well as at rest.
    const mine = await bidder.client
      .from("bids")
      .select("bidder_id, amount_cents")
      .eq("auction_id", auctionId);
    expect(mine.data).toHaveLength(1);
    expect(mine.data?.[0].bidder_id).toBe(bidder.userId);
    expect(mine.data?.[0].amount_cents).toBe(3_000);

    const theirs = await foil.client
      .from("bids")
      .select("bidder_id, amount_cents")
      .eq("auction_id", auctionId);
    expect(theirs.data).toHaveLength(1);
    expect(theirs.data?.[0].bidder_id).toBe(foil.userId);
    expect(theirs.data?.[0].amount_cents).toBe(4_000);
  });
});
