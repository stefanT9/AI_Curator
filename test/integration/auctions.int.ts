/**
 * S-01: proves the closed mutation surface on `public.auctions` for real,
 * under real RLS, before any UI rests on the assumption that it holds.
 *
 * `npm run test` mocks Supabase entirely, so it can assert that a Server
 * Action *calls* `rpc("create_auction", ...)` but not that the database
 * actually refuses what the design says it refuses. Only this lane can prove
 * that: `create_auction` / `cancel_auction` raise the right errors for the
 * right callers, the CHECK constraint holds even when a function bypasses the
 * Zod boundary, and — the two cases that matter most — a direct PostgREST
 * `insert` or `update` against `auctions` is refused outright. That last pair
 * is the only evidence that "no INSERT/UPDATE/DELETE policy" is real rather
 * than intended; every later auction slice (S-02's bids, S-03's close, S-04's
 * contact exchange) inherits this surface.
 *
 * Three users, one file (`sign_in_sign_ups` is rate-limited to 30 per 5
 * minutes per IP): `artist1` is the seller for every case, `artist2` is the
 * "not the owner" and "not the seller" foil, `collector` is the non-artist
 * foil and the cross-user browse reader.
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
  | "happyPath"
  | "duplicateGuard"
  | "otherArtistTarget"
  | "priceCheck"
  | "cancelOwn"
  | "cancelOther"
  | "insertRefusal"
  | "updateRefusal"
  | "browsable";

const FIXTURE_KEYS: FixtureKey[] = [
  "happyPath",
  "duplicateGuard",
  "otherArtistTarget",
  "priceCheck",
  "cancelOwn",
  "cancelOther",
  "insertRefusal",
  "updateRefusal",
  "browsable",
];

let artist1: TestArtist;
let artist2: TestArtist;
let collector: TestCollector;

/** Fixture artwork id by key — all owned by `artist1` unless a test says otherwise. */
const ids = new Map<FixtureKey, string>();
const id = (key: FixtureKey) => {
  const value = ids.get(key);
  if (!value) throw new Error(`Fixture artwork ${key} was not created`);
  return value;
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();

  [artist1, artist2, collector] = await Promise.all([
    createTestArtist(stack),
    createTestArtist(stack),
    createTestCollector(stack),
  ]);

  // One object, reused by every fixture row — this spec asserts auction
  // mutation and RLS behaviour, not rendering, so a shared image is fine (the
  // same shortcut `swipe-deck.int.ts` takes).
  const imagePath = await artist1.upload(TINY_PNG);

  const { data: rows, error } = await artist1.client
    .from("artworks")
    .insert(
      FIXTURE_KEYS.map((key) => ({
        artist_id: artist1.userId,
        title: `S-01 auctions ${key}`,
        image_path: imagePath,
      })),
    )
    .select("id, title");

  if (error || !rows) {
    throw new Error(`Could not insert fixture artworks: ${error?.message}`);
  }

  for (const row of rows) {
    const key = row.title.replace("S-01 auctions ", "") as FixtureKey;
    ids.set(key, row.id);
  }
});

afterAll(async () => {
  // Auctions have no delete policy of their own; deleting the fixture
  // artworks clears them via `on delete cascade`, per the plan's teardown
  // note.
  await Promise.all([
    artist1?.cleanup(),
    artist2?.cleanup(),
    collector?.cleanup(),
  ]);
});

describe("create_auction", () => {
  it("lets an artist create an auction on their own artwork, readable back from a select", async () => {
    const { data: auctionId, error } = await artist1.client.rpc(
      "create_auction",
      {
        p_artwork_id: id("happyPath"),
        p_duration_hours: 24,
        p_starting_price_cents: 2_500,
      },
    );

    expect(error).toBeNull();
    expect(auctionId).toEqual(expect.any(String));

    const { data: row, error: selectError } = await artist1.client
      .from("auctions")
      .select("*")
      .eq("id", auctionId as string)
      .single();

    expect(selectError).toBeNull();
    expect(row?.artwork_id).toBe(id("happyPath"));
    expect(row?.seller_id).toBe(artist1.userId);
    expect(row?.starting_price_cents).toBe(2_500);
    expect(row?.cancelled_at).toBeNull();
    expect(new Date(row!.ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a second live auction on the same artwork (AUC04)", async () => {
    const { data: firstId, error: firstError } = await artist1.client.rpc(
      "create_auction",
      {
        p_artwork_id: id("duplicateGuard"),
        p_duration_hours: 24,
        p_starting_price_cents: 1_000,
      },
    );
    expect(firstError).toBeNull();
    expect(firstId).toEqual(expect.any(String));

    const { data: secondId, error: secondError } = await artist1.client.rpc(
      "create_auction",
      {
        p_artwork_id: id("duplicateGuard"),
        p_duration_hours: 72,
        p_starting_price_cents: 2_000,
      },
    );

    expect(secondId).toBeNull();
    expect(secondError?.code).toBe("AUC04");

    const { data: rows } = await artist1.client
      .from("auctions")
      .select("id")
      .eq("artwork_id", id("duplicateGuard"));
    expect(rows).toHaveLength(1);
  });

  it("refuses an artist creating an auction on another artist's artwork (AUC03)", async () => {
    const { data, error } = await artist2.client.rpc("create_auction", {
      p_artwork_id: id("otherArtistTarget"),
      p_duration_hours: 24,
      p_starting_price_cents: 1_000,
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("AUC03");

    const { data: rows } = await artist1.client
      .from("auctions")
      .select("id")
      .eq("artwork_id", id("otherArtistTarget"));
    expect(rows).toHaveLength(0);
  });

  it("refuses a collector (non-artist) from creating an auction at all (AUC01)", async () => {
    const { data, error } = await collector.client.rpc("create_auction", {
      p_artwork_id: id("otherArtistTarget"),
      p_duration_hours: 24,
      p_starting_price_cents: 1_000,
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("AUC01");
  });

  it("refuses a duration outside the preset set at the database, not only at Zod (AUC02)", async () => {
    // The duration check runs before the artwork lookup, so a nonexistent
    // artwork id is enough to isolate this specific guard.
    const { data, error } = await artist1.client.rpc("create_auction", {
      p_artwork_id: crypto.randomUUID(),
      p_duration_hours: 48,
      p_starting_price_cents: 1_000,
    });

    expect(data).toBeNull();
    expect(error?.code).toBe("AUC02");
  });

  it("refuses a zero or negative starting price via the CHECK constraint", async () => {
    const zero = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("priceCheck"),
      p_duration_hours: 24,
      p_starting_price_cents: 0,
    });
    expect(zero.data).toBeNull();
    expect(zero.error?.code).toBe("23514");
    expect(zero.error?.message).toContain("auctions_starting_price_positive");

    const negative = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("priceCheck"),
      p_duration_hours: 24,
      p_starting_price_cents: -500,
    });
    expect(negative.data).toBeNull();
    expect(negative.error?.code).toBe("23514");

    const { data: rows } = await artist1.client
      .from("auctions")
      .select("id")
      .eq("artwork_id", id("priceCheck"));
    expect(rows).toHaveLength(0);
  });
});

describe("cancel_auction", () => {
  it("lets the seller cancel their own untouched auction; a second call returns false", async () => {
    const { data: auctionId } = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("cancelOwn"),
      p_duration_hours: 24,
      p_starting_price_cents: 1_500,
    });
    expect(auctionId).toEqual(expect.any(String));

    const first = await artist1.client.rpc("cancel_auction", {
      p_auction_id: auctionId as string,
    });
    expect(first.error).toBeNull();
    expect(first.data).toBe(true);

    const { data: row } = await artist1.client
      .from("auctions")
      .select("cancelled_at")
      .eq("id", auctionId as string)
      .single();
    expect(row?.cancelled_at).not.toBeNull();

    const second = await artist1.client.rpc("cancel_auction", {
      p_auction_id: auctionId as string,
    });
    expect(second.error).toBeNull();
    expect(second.data).toBe(false);
  });

  it("returns false and leaves the row unchanged when a different user cancels it", async () => {
    const { data: auctionId } = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("cancelOther"),
      p_duration_hours: 24,
      p_starting_price_cents: 1_500,
    });
    expect(auctionId).toEqual(expect.any(String));

    const attempt = await artist2.client.rpc("cancel_auction", {
      p_auction_id: auctionId as string,
    });
    expect(attempt.error).toBeNull();
    expect(attempt.data).toBe(false);

    const { data: row } = await artist1.client
      .from("auctions")
      .select("cancelled_at")
      .eq("id", auctionId as string)
      .single();
    expect(row?.cancelled_at).toBeNull();
  });
});

describe("the closed mutation surface", () => {
  it("refuses a direct PostgREST insert into auctions", async () => {
    const { error } = await artist1.client
      .from("auctions")
      .insert({
        artwork_id: id("insertRefusal"),
        seller_id: artist1.userId,
        starting_price_cents: 1_000,
        ends_at: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .select();

    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");

    const { data: rows } = await artist1.client
      .from("auctions")
      .select("id")
      .eq("artwork_id", id("insertRefusal"));
    expect(rows).toHaveLength(0);
  });

  it("refuses a direct PostgREST update on an auction (FR-002 has no edit path)", async () => {
    const { data: auctionId } = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("updateRefusal"),
      p_duration_hours: 24,
      p_starting_price_cents: 1_000,
    });
    expect(auctionId).toEqual(expect.any(String));

    // RLS is enabled with no UPDATE policy on this table. Unlike INSERT
    // (where the new row must pass a WITH CHECK or the statement errors),
    // Postgres's UPDATE/DELETE path with no matching policy simply admits no
    // rows to the USING filter — the same silent-no-op shape
    // `storage-boundary.int.ts` records for a DELETE with no matching row.
    // What matters for FR-002 is observable either way: recorded here as the
    // row staying unchanged, whether or not an error came back.
    await artist1.client
      .from("auctions")
      .update({ starting_price_cents: 999_999 })
      .eq("id", auctionId as string);

    const { data: row } = await artist1.client
      .from("auctions")
      .select("starting_price_cents")
      .eq("id", auctionId as string)
      .single();
    expect(row?.starting_price_cents).toBe(1_000);
  });

  it("lets any authenticated user select an auction created by someone else", async () => {
    const { data: auctionId } = await artist1.client.rpc("create_auction", {
      p_artwork_id: id("browsable"),
      p_duration_hours: 24,
      p_starting_price_cents: 3_000,
    });
    expect(auctionId).toEqual(expect.any(String));

    const { data: row, error } = await collector.client
      .from("auctions")
      .select("*")
      .eq("id", auctionId as string)
      .single();

    expect(error).toBeNull();
    expect(row?.id).toBe(auctionId);
    expect(row?.seller_id).toBe(artist1.userId);
  });
});
