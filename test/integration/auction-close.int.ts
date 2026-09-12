/**
 * S-03: proves the timed close for real, against a real Postgres, before any
 * UI rests on the outcome it records.
 *
 * `npm run test` mocks Supabase entirely, so nothing in the default suite can
 * answer a single question this slice turns on. Winner selection, the
 * earliest-wins tie-break, idempotency, and the sealed boundary holding *after*
 * close are all properties of one SQL function and one RLS policy — a mocked
 * client would simply agree with whatever the caller asserted.
 *
 * Two things about this file are unlike its siblings, and both follow from the
 * migration's design rather than from convenience:
 *
 *   - **It opens a direct postgres connection.** `close_due_auctions` is
 *     granted to nobody — `20260912120000_add_auction_close.sql` revokes it
 *     from `public`, `anon`, `authenticated` and `service_role` and never
 *     grants it back, because a future `p_now` in a signed-in user's hands
 *     would close live auctions early. That omission is the access control, so
 *     the only callers left are the cron job and a superuser connection.
 *     `requireLocalDatabaseUrl` applies the same loopback guard the anon rail
 *     does.
 *   - **The close is driven by `p_now`, not by the clock.** `create_auction`
 *     accepts only 24/72/168 hours and this lane has no service-role key with
 *     which to backdate a row, so nothing here can wait for an auction to
 *     expire. `p_now` governs due-ness only; `closed_at` is always the real
 *     `now()`, which is why every auction below is closed while its `ends_at`
 *     is still hours in the future. That is not an artefact of testing — it is
 *     the exact state Phase 1 added `closed_at is null` to `place_bid` and
 *     `cancel_auction` to make safe, and the two refusal cases here are the
 *     only place that guard is observable.
 *
 * Every fixture auction is staged in `beforeAll` and closed by **one** sweep,
 * because that is how the sweep really runs: one statement over every due
 * auction at once, not one call per auction. Each test then reads back the row
 * its case owns.
 *
 * Four users, one file (`sign_in_sign_ups` is rate-limited to 30 per 5 minutes
 * per IP): `seller` is the artist behind every fixture, and three collectors —
 * `alice`, `bob`, `carol` — because the highest-wins case needs three distinct
 * bidders and one bid per bidder per auction is all `bids_one_per_bidder`
 * permits.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireLocalDatabaseUrl, requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  createTestCollector,
  TINY_PNG,
  type TestArtist,
  type TestCollector,
} from "./helpers";

type FixtureKey =
  | "highestWins"
  | "earliestTie"
  | "raiseLosesQueue"
  | "noBids"
  | "idempotent"
  | "cancelledPastEnd"
  | "refusedAfterClose"
  | "sealedAfterClose"
  | "loserLearnsNothing";

const FIXTURE_KEYS: FixtureKey[] = [
  "highestWins",
  "earliestTie",
  "raiseLosesQueue",
  "noBids",
  "idempotent",
  "cancelledPastEnd",
  "refusedAfterClose",
  "sealedAfterClose",
  "loserLearnsNothing",
];

/**
 * The clock the sweep is driven by: past every fixture's `ends_at`, which
 * `create_auction` puts 24 hours out.
 */
const P_NOW = new Date(Date.now() + 48 * 60 * 60 * 1000);

let seller: TestArtist;
let alice: TestCollector;
let bob: TestCollector;
let carol: TestCollector;

let pool: Pool;

/** What the one real sweep returned, asserted by the idempotency case. */
let firstSweepCount: number;

/** `closed_at` of the `idempotent` auction, read straight after that sweep. */
let idempotentClosedAt: string | null;

const artworkIds = new Map<FixtureKey, string>();
const auctionIds = new Map<FixtureKey, string>();

const auctionId = (key: FixtureKey): string => {
  const value = auctionIds.get(key);
  if (!value) throw new Error(`Fixture auction ${key} was not created`);
  return value;
};

/** Every fixture auction opens the ordinary way, at the same floor. */
const STARTING_PRICE_CENTS = 1_000;

const openAuction = async (key: FixtureKey): Promise<string> => {
  const artworkId = artworkIds.get(key);
  if (!artworkId) throw new Error(`Fixture artwork ${key} was not created`);

  const { data, error } = await seller.client.rpc("create_auction", {
    p_artwork_id: artworkId,
    p_duration_hours: 24,
    p_starting_price_cents: STARTING_PRICE_CENTS,
  });

  if (error || !data) {
    throw new Error(`Could not open the ${key} auction: ${error?.message}`);
  }

  auctionIds.set(key, data);
  return data;
};

/**
 * Place a bid and insist it succeeded.
 *
 * Fixture bids are `await`ed one at a time and never batched: `updated_at` is
 * the tie-break comparator, so the order two bids of equal amount were placed
 * in *is* the thing under test.
 */
const bid = async (
  who: TestCollector,
  key: FixtureKey,
  amountCents: number,
): Promise<void> => {
  const { error } = await who.client.rpc("place_bid", {
    p_auction_id: auctionId(key),
    p_amount_cents: amountCents,
  });

  if (error) {
    throw new Error(
      `Could not place the ${amountCents}c fixture bid on ${key}: ${error.message}`,
    );
  }
};

/** Run the sweep over the direct connection, since no client may call it. */
const closeDueAuctions = async (now: Date): Promise<number> => {
  const { rows } = await pool.query<{ closed: number }>(
    "select public.close_due_auctions($1::timestamptz) as closed",
    [now.toISOString()],
  );
  return rows[0].closed;
};

/** The outcome columns, read as the given user through ordinary PostgREST. */
const readOutcome = async (
  who: TestArtist | TestCollector,
  key: FixtureKey,
) => {
  const { data, error } = await who.client
    .from("auctions")
    .select("closed_at, winning_bid_id, winning_amount_cents, cancelled_at")
    .eq("id", auctionId(key))
    .single();

  if (error || !data) {
    throw new Error(`Could not read the ${key} auction: ${error?.message}`);
  }

  return data;
};

/** The caller's own bid on `key`, or null — the only bid row RLS shows them. */
const readOwnBid = async (who: TestCollector, key: FixtureKey) => {
  const { data, error } = await who.client
    .from("bids")
    .select("id, amount_cents, bidder_id")
    .eq("auction_id", auctionId(key))
    .maybeSingle();

  if (error) {
    throw new Error(`Could not read own bid on ${key}: ${error.message}`);
  }

  return data;
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 });

  [seller, alice, bob, carol] = await Promise.all([
    createTestArtist(stack),
    createTestCollector(stack),
    createTestCollector(stack),
    createTestCollector(stack),
  ]);

  // One object, reused by every fixture row — this spec asserts close
  // behaviour, not rendering, so a shared image is fine (the same shortcut
  // `bids.int.ts` and `auctions.int.ts` take).
  const imagePath = await seller.upload(TINY_PNG);

  const { data: rows, error } = await seller.client
    .from("artworks")
    .insert(
      FIXTURE_KEYS.map((key) => ({
        artist_id: seller.userId,
        title: `S-03 close ${key}`,
        image_path: imagePath,
      })),
    )
    .select("id, title");

  if (error || !rows) {
    throw new Error(`Could not insert fixture artworks: ${error?.message}`);
  }

  for (const row of rows) {
    artworkIds.set(row.title.replace("S-03 close ", "") as FixtureKey, row.id);
  }

  for (const key of FIXTURE_KEYS) {
    await openAuction(key);
  }

  // Three distinct amounts, deliberately out of order, so a sweep that
  // returned the last bid or the first would both be caught.
  await bid(alice, "highestWins", 2_000);
  await bid(bob, "highestWins", 5_000);
  await bid(carol, "highestWins", 3_000);

  // Equal amounts, placed in sequence: alice's `updated_at` is earlier.
  await bid(alice, "earliestTie", 4_000);
  await bid(bob, "earliestTie", 4_000);

  // Alice is first to 3_000, bob overtakes at 4_000, then alice matches him.
  // The upsert moves her `updated_at` forward, so matching him is not enough.
  await bid(alice, "raiseLosesQueue", 3_000);
  await bid(bob, "raiseLosesQueue", 4_000);
  await bid(alice, "raiseLosesQueue", 4_000);

  await bid(alice, "idempotent", 2_500);
  await bid(alice, "sealedAfterClose", 7_000);

  await bid(alice, "loserLearnsNothing", 2_000);
  await bid(bob, "loserLearnsNothing", 6_000);

  // `cancelledPastEnd` and `refusedAfterClose` stay bidless on purpose:
  // `cancel_auction` refuses an auction that already has a bid, so a bidless
  // one is the only fixture where `closed_at` is unambiguously the blocker.
  const cancelled = await seller.client.rpc("cancel_auction", {
    p_auction_id: auctionId("cancelledPastEnd"),
  });
  if (cancelled.error || cancelled.data !== true) {
    throw new Error(
      `Could not cancel the cancelledPastEnd fixture: ${cancelled.error?.message}`,
    );
  }

  // One sweep, over everything — the shape the cron job actually runs.
  firstSweepCount = await closeDueAuctions(P_NOW);
  idempotentClosedAt = (await readOutcome(seller, "idempotent")).closed_at;
});

afterAll(async () => {
  // Deleting the fixture artworks clears the auctions via `on delete cascade`,
  // and those clear their bids the same way — `bids` has no delete policy of
  // its own and `auctions` has none either.
  await Promise.all([
    seller?.cleanup(),
    alice?.cleanup(),
    bob?.cleanup(),
    carol?.cleanup(),
  ]);
  await pool?.end();
});

describe("winner selection", () => {
  it("records the highest bid as the winner, with its amount frozen on the auction", async () => {
    const outcome = await readOutcome(seller, "highestWins");
    const winning = await readOwnBid(bob, "highestWins");

    expect(outcome.closed_at).not.toBeNull();
    expect(outcome.winning_bid_id).toBe(winning?.id);
    expect(outcome.winning_amount_cents).toBe(5_000);
  });

  it("gives a tie to the earlier bid, not the later one", async () => {
    const outcome = await readOutcome(seller, "earliestTie");
    const early = await readOwnBid(alice, "earliestTie");
    const late = await readOwnBid(bob, "earliestTie");

    expect(early?.amount_cents).toBe(4_000);
    expect(late?.amount_cents).toBe(4_000);

    // FR-008's comparator, and the reason `bids_set_updated_at` is called
    // load-bearing rather than bookkeeping.
    expect(outcome.winning_bid_id).toBe(early?.id);
    expect(outcome.winning_amount_cents).toBe(4_000);
  });

  it("puts a bidder who raises to match behind the bidder they matched", async () => {
    const outcome = await readOutcome(seller, "raiseLosesQueue");
    const raiser = await readOwnBid(alice, "raiseLosesQueue");
    const held = await readOwnBid(bob, "raiseLosesQueue");

    expect(raiser?.amount_cents).toBe(4_000);
    expect(held?.amount_cents).toBe(4_000);

    // The upsert moved alice's `updated_at` to the moment 4_000 became her
    // standing bid, which is later than bob's. Raising correctly forfeits an
    // earlier queue position — the behaviour the raise-as-upsert produces.
    expect(outcome.winning_bid_id).toBe(held?.id);
  });

  it("closes an auction nobody bid on, with no winner recorded", async () => {
    const outcome = await readOutcome(seller, "noBids");

    expect(outcome.closed_at).not.toBeNull();
    expect(outcome.winning_bid_id).toBeNull();
    expect(outcome.winning_amount_cents).toBeNull();
  });
});

describe("the sweep itself", () => {
  it("closed every fixture auction that was due", async () => {
    // Nine fixtures, one of them cancelled and therefore never due.
    expect(firstSweepCount).toBeGreaterThanOrEqual(FIXTURE_KEYS.length - 1);
  });

  it("changes nothing on a second pass, and reports zero", async () => {
    const before = await readOutcome(seller, "idempotent");
    expect(before.closed_at).toBe(idempotentClosedAt);

    const closed = await closeDueAuctions(P_NOW);
    expect(closed).toBe(0);

    // `closed_at` included: a re-close would move it, and S-04 will trigger on
    // that timestamp being written exactly once.
    const after = await readOutcome(seller, "idempotent");
    expect(after.closed_at).toBe(idempotentClosedAt);
    expect(after.winning_bid_id).toBe(before.winning_bid_id);
    expect(after.winning_amount_cents).toBe(before.winning_amount_cents);
  });

  it("leaves a cancelled auction alone even though it is past its end time", async () => {
    const outcome = await readOutcome(seller, "cancelledPastEnd");

    // "The seller withdrew it" and "it ran and nobody bid" are situations
    // FR-010 treats differently, so the two terminal states stay disjoint.
    expect(outcome.cancelled_at).not.toBeNull();
    expect(outcome.closed_at).toBeNull();
    expect(outcome.winning_bid_id).toBeNull();
  });
});

describe("a closed auction is over", () => {
  it("refuses a bid on it (BID01) even though its ends_at is still in the future", async () => {
    const outcome = await readOutcome(seller, "refusedAfterClose");
    expect(outcome.closed_at).not.toBeNull();

    const { data: row } = await seller.client
      .from("auctions")
      .select("ends_at")
      .eq("id", auctionId("refusedAfterClose"))
      .single();
    // The whole point of this case: the two timestamps disagree, so only
    // `closed_at` can be refusing the bid.
    expect(new Date(row!.ends_at).getTime()).toBeGreaterThan(Date.now());

    const { error } = await alice.client.rpc("place_bid", {
      p_auction_id: auctionId("refusedAfterClose"),
      p_amount_cents: 9_000,
    });
    expect(error?.code).toBe("BID01");

    expect(await readOwnBid(alice, "refusedAfterClose")).toBeNull();
  });

  it("refuses the seller cancelling it, and leaves cancelled_at null", async () => {
    // Bidless, seller-owned, `ends_at` still ahead: every other term of
    // `cancel_auction`'s predicate holds, so `closed_at` is the only thing
    // that can return false here.
    const cancelled = await seller.client.rpc("cancel_auction", {
      p_auction_id: auctionId("refusedAfterClose"),
    });

    expect(cancelled.error).toBeNull();
    expect(cancelled.data).toBe(false);
    expect(
      (await readOutcome(seller, "refusedAfterClose")).cancelled_at,
    ).toBeNull();
  });
});

describe("sealed survives the close", () => {
  it("still shows the seller zero bid rows, while handing them the amount", async () => {
    const { data: rows, error } = await seller.client
      .from("bids")
      .select("*")
      .eq("auction_id", auctionId("sealedAfterClose"));

    // The one assertion that proves denormalising the amount onto `auctions`
    // did not quietly widen the select policy on `bids`.
    expect(error).toBeNull();
    expect(rows).toHaveLength(0);

    const { count } = await seller.client
      .from("bids")
      .select("*", { count: "exact", head: true })
      .eq("auction_id", auctionId("sealedAfterClose"));
    expect(count).toBe(0);

    // And yet the seller learns what their work sold for — which is the whole
    // reason `winning_amount_cents` exists as a column.
    const outcome = await readOutcome(seller, "sealedAfterClose");
    expect(outcome.winning_amount_cents).toBe(7_000);
  });

  it("tells a losing bidder that they lost, and nothing else", async () => {
    const mine = await readOwnBid(alice, "loserLearnsNothing");
    expect(mine?.bidder_id).toBe(alice.userId);
    expect(mine?.amount_cents).toBe(2_000);

    // Only her own row, even unfiltered: the winner's bid stays invisible, so
    // comparing ids against `winning_bid_id` is the entire mechanism by which
    // a bidder finds out they lost — no read of anyone else's bid is involved.
    const { data: allRows } = await alice.client
      .from("bids")
      .select("id")
      .eq("auction_id", auctionId("loserLearnsNothing"));
    expect(allRows).toHaveLength(1);

    const outcome = await readOutcome(alice, "loserLearnsNothing");
    expect(outcome.closed_at).not.toBeNull();
    expect(outcome.winning_bid_id).not.toBe(mine?.id);

    // `auctions` has a blanket select policy, so `winning_amount_cents` is
    // readable here — withholding it from a loser is Phase 3's job in the
    // page, not the database's. Asserted rather than assumed so nobody later
    // mistakes this lane for the thing enforcing it.
    expect(outcome.winning_amount_cents).toBe(6_000);
  });
});
