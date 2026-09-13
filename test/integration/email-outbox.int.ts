/**
 * S-04's database half, proven where it is provable: against real Postgres,
 * under real RLS, driven by a real close.
 *
 * Nothing in the default lane can answer a question this file asks. `npm run
 * test` mocks Supabase entirely, and `src/types/database.ts` reflects the
 * *catalog* rather than the grants — `close_due_auctions` is `rpc()`-callable at
 * the type level despite being granted to nobody. This slice leans on that
 * distinction harder than anything before it: the enqueue is a trigger nobody
 * calls, `email_outbox`'s access control is the absence of four policies, and
 * the drain's is the presence of exactly two grants to `anon`. A mock agrees
 * with whatever the caller asserts about all three.
 *
 * The one assertion here that is about the product rather than the plumbing is
 * that an `auction_lost` payload carries no counterparty address and no amount.
 * §Access Control permits exactly one new disclosure — the winner and the seller
 * learn each other's address — and a losing bidder is not part of it. That
 * boundary lives in the payload, not in the templates: a field that was never
 * stored cannot be rendered by a template written later.
 *
 * The split follows `auction-close.int.ts` and `email-sends.int.ts`: ordinary
 * RLS-bound clients for everything a user can attempt, and one direct postgres
 * connection for what is deliberately ungranted — here, driving the sweep and
 * reading the outbox at all. `requireLocalDatabaseUrl` applies the same loopback
 * guard the anon rail does.
 *
 * Four users, one file (`sign_in_sign_ups` is rate-limited to 30 per five
 * minutes per IP): `seller` is the artist behind every fixture, `winner` takes
 * the sold auction, and `loserOne` / `loserTwo` are the two people who bid and
 * did not — two rather than one, because "every other bidder" has to be shown to
 * mean more than "the runner-up".
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { requireLocalDatabaseUrl, requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  createTestCollector,
  TINY_PNG,
  type TestArtist,
  type TestClient,
  type TestCollector,
} from "./helpers";

type FixtureKey = "sold" | "noBids" | "cancelled";

const FIXTURE_KEYS: FixtureKey[] = ["sold", "noBids", "cancelled"];

/** The clock the sweep is driven by: past every fixture's `ends_at`. */
const P_NOW = new Date(Date.now() + 48 * 60 * 60 * 1000);

const STARTING_PRICE_CENTS = 1_000;
const WINNING_AMOUNT_CENTS = 5_000;

/** The vault entry both drain functions read. Fixed by the migration. */
const DRAIN_SECRET_NAME = "email_drain_secret";

type OutboxRow = {
  id: string;
  recipient_email: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
};

let seller: TestArtist;
let winner: TestCollector;
let loserOne: TestCollector;
let loserTwo: TestCollector;

let pool: Pool;

/** A sessionless client — the role the drain actually calls as. */
let anonymous: TestClient;

/** Whatever secret this local stack holds, created here if it had none. */
let drainSecret: string;

/** `closed_at` of the sold auction, read straight after the one real sweep. */
let soldClosedAt: string | null;

const artworkIds = new Map<FixtureKey, string>();
const auctionIds = new Map<FixtureKey, string>();

const auctionId = (key: FixtureKey): string => {
  const value = auctionIds.get(key);
  if (!value) throw new Error(`Fixture auction ${key} was not created`);
  return value;
};

const openAuction = async (key: FixtureKey): Promise<void> => {
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
};

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

/**
 * The only way to read the outbox: RLS is on and there is no select policy for
 * any client to use.
 */
const readOutbox = async (key: FixtureKey): Promise<OutboxRow[]> => {
  const { rows } = await pool.query<OutboxRow>(
    `select id, recipient_email, kind, payload, status, attempts,
            last_error, sent_at
       from public.email_outbox
      where auction_id = $1
      order by kind, recipient_email`,
    [auctionId(key)],
  );

  return rows;
};

const readClosedAt = async (key: FixtureKey): Promise<string | null> => {
  const { data, error } = await seller.client
    .from("auctions")
    .select("closed_at")
    .eq("id", auctionId(key))
    .single();

  if (error || !data) {
    throw new Error(`Could not read the ${key} auction: ${error?.message}`);
  }

  return data.closed_at;
};

const readLedgerFor = async (recipient: string) => {
  const { rows } = await pool.query<{
    actor_id: string | null;
    kind: string;
    status: string;
    reason: string | null;
    provider_id: string | null;
  }>(
    `select actor_id, kind, status, reason, provider_id
       from public.email_sends
      where recipient = $1
      order by created_at desc`,
    [recipient],
  );

  return rows;
};

/**
 * Use the secret this stack already holds, or plant one.
 *
 * Never overwrite an existing entry: on a developer's local stack the same name
 * is what Phase 2's cron job authenticates with, and a spec that rotated it out
 * from under them would break their drain and say nothing about why.
 */
const ensureDrainSecret = async (): Promise<string> => {
  const { rows } = await pool.query<{ decrypted_secret: string | null }>(
    "select decrypted_secret from vault.decrypted_secrets where name = $1",
    [DRAIN_SECRET_NAME],
  );

  const existing = rows[0]?.decrypted_secret;
  if (existing) return existing;

  const secret = `int-drain-${crypto.randomUUID()}`;
  await pool.query("select vault.create_secret($1, $2, $3)", [
    secret,
    DRAIN_SECRET_NAME,
    "Planted by test/integration/email-outbox.int.ts on a local stack.",
  ]);

  return secret;
};

const claim = async (secret: string, limit: number) =>
  anonymous.rpc("claim_pending_emails", {
    p_secret: secret,
    p_limit: limit,
  });

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 });
  anonymous = createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  drainSecret = await ensureDrainSecret();

  [seller, winner, loserOne, loserTwo] = await Promise.all([
    createTestArtist(stack),
    createTestCollector(stack),
    createTestCollector(stack),
    createTestCollector(stack),
  ]);

  // One object, reused by every fixture row — this spec asserts enqueue
  // behaviour, not rendering.
  const imagePath = await seller.upload(TINY_PNG);

  const { data: rows, error } = await seller.client
    .from("artworks")
    .insert(
      FIXTURE_KEYS.map((key) => ({
        artist_id: seller.userId,
        title: `S-04 outbox ${key}`,
        image_path: imagePath,
      })),
    )
    .select("id, title");

  if (error || !rows) {
    throw new Error(`Could not insert fixture artworks: ${error?.message}`);
  }

  for (const row of rows) {
    artworkIds.set(row.title.replace("S-04 outbox ", "") as FixtureKey, row.id);
  }

  for (const key of FIXTURE_KEYS) {
    await openAuction(key);
  }

  // Placed one at a time and out of order, so a trigger that mistook the last
  // or the first bidder for the winner would be caught.
  await bid(loserOne, "sold", 3_000);
  await bid(winner, "sold", WINNING_AMOUNT_CENTS);
  await bid(loserTwo, "sold", 2_000);

  // `cancel_auction` refuses an auction that already has a bid, so the
  // cancelled fixture stays bidless.
  const cancelled = await seller.client.rpc("cancel_auction", {
    p_auction_id: auctionId("cancelled"),
  });
  if (cancelled.error || cancelled.data !== true) {
    throw new Error(
      `Could not cancel the cancelled fixture: ${cancelled.error?.message}`,
    );
  }

  // One sweep, over everything — the shape the cron job actually runs. Nothing
  // in this file ever inserts an outbox row; every one of them is a side effect
  // of this single call, which is the whole point.
  await closeDueAuctions(P_NOW);
  soldClosedAt = await readClosedAt("sold");
});

afterAll(async () => {
  // Deleting the fixture artworks clears the auctions via `on delete cascade`,
  // and those clear both their bids and their outbox rows the same way. The
  // `email_sends` rows this file writes are deliberately left: the ledger is
  // append-only, and reaching over the superuser connection to erase its own
  // history would model a capability the schema exists to deny.
  await Promise.all([
    seller?.cleanup(),
    winner?.cleanup(),
    loserOne?.cleanup(),
    loserTwo?.cleanup(),
  ]);
  await pool?.end();
});

describe("the close fills the outbox", () => {
  it("writes one row per person the outcome concerns, and no more", async () => {
    const rows = await readOutbox("sold");

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.kind).sort()).toEqual([
      "auction_lost",
      "auction_lost",
      "auction_sold",
      "auction_won",
    ]);

    const byRecipient = new Map(rows.map((row) => [row.recipient_email, row]));
    expect(byRecipient.get(seller.email)?.kind).toBe("auction_sold");
    expect(byRecipient.get(winner.email)?.kind).toBe("auction_won");
    expect(byRecipient.get(loserOne.email)?.kind).toBe("auction_lost");
    expect(byRecipient.get(loserTwo.email)?.kind).toBe("auction_lost");

    // Every row starts unclaimed. `attempts` is the drain's business and
    // nothing else touches it.
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.attempts === 0)).toBe(true);
    expect(rows.every((row) => row.sent_at === null)).toBe(true);
  });

  it("gives the seller the winner's address and the winner the seller's", async () => {
    const rows = await readOutbox("sold");
    const sold = rows.find((row) => row.kind === "auction_sold");
    const won = rows.find((row) => row.kind === "auction_won");

    // FR-009, and the one new disclosure §Access Control permits: each of the
    // two people with a sale to complete gets the other's address, resolved
    // from `auth.users` rather than from the never-synced `profiles.email`.
    expect(sold?.recipient_email).toBe(seller.email);
    expect(sold?.payload.counterparty_email).toBe(winner.email);
    expect(sold?.payload.amount_cents).toBe(WINNING_AMOUNT_CENTS);

    expect(won?.recipient_email).toBe(winner.email);
    expect(won?.payload.counterparty_email).toBe(seller.email);
    expect(won?.payload.amount_cents).toBe(WINNING_AMOUNT_CENTS);

    expect(sold?.payload.artwork_title).toBe("S-04 outbox sold");
    expect(won?.payload.artwork_title).toBe("S-04 outbox sold");
  });

  it("tells a losing bidder nothing but which piece it was", async () => {
    const lost = (await readOutbox("sold")).filter(
      (row) => row.kind === "auction_lost",
    );

    expect(lost).toHaveLength(2);

    for (const row of lost) {
      // The §Access Control assertion, and the only one here that is about the
      // product rather than the plumbing. It is made against the payload rather
      // than against a rendered body on purpose: a field that was never stored
      // cannot be disclosed by a template written later.
      expect(Object.keys(row.payload).sort()).toEqual(["artwork_title"]);
      expect(row.payload.counterparty_email).toBeUndefined();
      expect(row.payload.amount_cents).toBeUndefined();

      // Belt and braces against a future field carrying an address under some
      // other name.
      expect(JSON.stringify(row.payload)).not.toContain("@");
      expect(JSON.stringify(row.payload)).not.toContain(
        String(WINNING_AMOUNT_CENTS),
      );
    }

    expect(lost.map((row) => row.recipient_email).sort()).toEqual(
      [loserOne.email, loserTwo.email].sort(),
    );
  });

  it("sends the seller of an unsold piece a single notice, with no amount", async () => {
    const rows = await readOutbox("noBids");

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("auction_unsold");
    expect(rows[0].recipient_email).toBe(seller.email);

    // FR-010 treats "it ran and nobody bid" as a closing notice with the piece
    // free to relist, so there is nothing to carry but the title — no amount,
    // no counterparty, and nothing that counts the bids that did not happen.
    expect(Object.keys(rows[0].payload).sort()).toEqual(["artwork_title"]);
    expect(rows[0].payload.artwork_title).toBe("S-04 outbox noBids");
  });

  it("leaves a cancelled auction with nothing to send at all", async () => {
    // The sweep skips cancelled auctions, so `closed_at` stays null and the
    // trigger's `when` clause never holds. "The seller withdrew it" and "it ran
    // and nobody bid" are situations FR-010 treats differently, and the silence
    // here is what keeps them disjoint.
    expect(await readClosedAt("cancelled")).toBeNull();
    expect(await readOutbox("cancelled")).toHaveLength(0);
  });
});

describe("exactly once", () => {
  it("adds nothing on a second sweep, and does not move closed_at", async () => {
    expect(soldClosedAt).not.toBeNull();

    const closed = await closeDueAuctions(P_NOW);
    expect(closed).toBe(0);

    // The trigger's `when (old.closed_at is null and new.closed_at is not
    // null)` is the entire exactly-once guarantee, and it rests on this: a
    // re-close would move the timestamp, and there is no second transition to
    // fire on because there is no second write.
    expect(await readClosedAt("sold")).toBe(soldClosedAt);
    expect(await readOutbox("sold")).toHaveLength(4);
    expect(await readOutbox("noBids")).toHaveLength(1);
  });
});

describe("the closed table surface", () => {
  it("shows an authenticated client zero rows, and no error", async () => {
    const { data, error } = await seller.client
      .from("email_outbox")
      .select("*");

    // RLS is on with no select policy, so this is invisibility rather than
    // refusal — the caller learns nothing, including whether there was anything
    // to learn. The rows are provably there: `readOutbox` just read four.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { count } = await seller.client
      .from("email_outbox")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("refuses a direct insert, so no client can address a message", async () => {
    const { error } = await winner.client
      .from("email_outbox")
      .insert({
        auction_id: auctionId("sold"),
        recipient_email: "forged@example.test",
        kind: "auction_won",
        payload: { artwork_title: "forged" },
      })
      .select();

    // INSERT is the one verb that errors rather than no-ops: the new row has no
    // WITH CHECK to pass. Without this, anyone could make the drain send mail
    // to an address of their choosing.
    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");
  });

  it("refuses a direct update, leaving the payload exactly as the trigger wrote it", async () => {
    const before = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_lost",
    );

    await winner.client
      .from("email_outbox")
      .update({
        payload: { artwork_title: "x", counterparty_email: "y@z.test" },
      })
      .eq("id", before!.id);

    // With no UPDATE policy, Postgres admits no rows to the USING filter and
    // the statement is a silent no-op rather than an error — the shape
    // `bids.int.ts` and `email-sends.int.ts` both record.
    const after = (await readOutbox("sold")).find(
      (row) => row.id === before!.id,
    );
    expect(after?.payload).toEqual(before?.payload);
  });

  it("refuses a direct delete, so a queued message cannot be suppressed", async () => {
    const target = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_won",
    );

    await winner.client.from("email_outbox").delete().eq("id", target!.id);

    const still = (await readOutbox("sold")).find(
      (row) => row.id === target!.id,
    );
    expect(still).toBeDefined();
  });
});

describe("the drain's two operations", () => {
  it("refuses a claim from a caller without the secret", async () => {
    const { data, error } = await claim("not-the-secret", 50);

    // The publishable key is public by design, so the role is not the access
    // control — the secret argument is. A caller holding the key and not the
    // secret gets an exception rather than a row.
    expect(error).not.toBeNull();
    expect(error?.code).toBe("EML01");
    expect(data).toBeNull();
  });

  it("hands out pending rows to a caller with it, and counts the attempt", async () => {
    const { data, error } = await claim(drainSecret, 200);

    expect(error).toBeNull();

    const mine = new Set((await readOutbox("sold")).map((row) => row.id));
    const claimedMine = (data ?? []).filter((row) => mine.has(row.id));

    // Asserted as a superset rather than an exact match: the outbox is shared
    // with whatever a sibling spec's close left behind, and the drain is
    // deliberately not scoped to one auction.
    expect(claimedMine).toHaveLength(4);
    expect(claimedMine.every((row) => row.recipient_email.includes("@"))).toBe(
      true,
    );

    // The counter moves before any send is attempted, which is what bounds a
    // drain that dies mid-batch.
    const after = await readOutbox("sold");
    expect(after.every((row) => row.attempts === 1)).toBe(true);
    expect(after.every((row) => row.status === "pending")).toBe(true);
  });

  it("hands a row back until the ceiling, then stops", async () => {
    // The ceiling was one attempt when 20260913120000 landed, and
    // 20260913120200 raised it to three once a single-attempt drain had been
    // observed working end to end. Three is therefore the number under test —
    // this spec asserted the old ceiling's behaviour until an implementation
    // review caught that the two had been shipped in the same change set.
    //
    // It matters more since 20260913120400: a transient failure now leaves the
    // row `pending` rather than retiring it, so the ceiling is the only thing
    // standing between a broken provider and a row retried forever.
    const claimedOnce = async (): Promise<number> => {
      const { data, error } = await claim(drainSecret, 200);
      expect(error).toBeNull();

      // A superset, not an exact match: the outbox is shared with whatever a
      // sibling spec's close left behind, and the drain is deliberately not
      // scoped to one auction.
      const mine = new Set((await readOutbox("sold")).map((row) => row.id));
      return (data ?? []).filter((row) => mine.has(row.id)).length;
    };

    // The previous spec already spent attempt one.
    expect(await claimedOnce()).toBe(4);
    expect((await readOutbox("sold")).every((row) => row.attempts === 2)).toBe(
      true,
    );

    expect(await claimedOnce()).toBe(4);
    expect((await readOutbox("sold")).every((row) => row.attempts === 3)).toBe(
      true,
    );

    // Exhausted. The rows stay `pending` rather than moving to `failed`,
    // because pending is what the operator's "stuck for fifteen minutes" query
    // looks for — and a row nobody will retry is exactly what it is for.
    expect(await claimedOnce()).toBe(0);

    const exhausted = await readOutbox("sold");
    expect(exhausted.every((row) => row.attempts === 3)).toBe(true);
    expect(exhausted.every((row) => row.status === "pending")).toBe(true);
  });

  it("refuses a mark from a caller without the secret", async () => {
    const target = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_lost",
    );

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: "not-the-secret",
      p_id: target!.id,
      p_status: "sent",
    });

    expect(error?.code).toBe("EML01");
    expect(
      (await readOutbox("sold")).find((row) => row.id === target!.id)?.status,
    ).toBe("pending");
  });

  it("marks a row sent and writes the ledger row itself, with no actor", async () => {
    const target = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_won",
    );

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: drainSecret,
      p_id: target!.id,
      p_status: "sent",
      p_provider_id: "re_int_00000000",
    });
    expect(error).toBeNull();

    const after = (await readOutbox("sold")).find(
      (row) => row.id === target!.id,
    );
    expect(after?.status).toBe("sent");
    expect(after?.sent_at).not.toBeNull();
    expect(after?.last_error ?? null).toBeNull();

    // `record_email_send` is granted to `authenticated` only, and must stay
    // revoked from `anon` — so the drain cannot call it and `mark_email_sent`
    // calls it internally, definer to definer. `actor_id` lands null, which
    // 20260912140000_add_email_sends.sql:28-31 documents as the normal case for
    // exactly this slice.
    const ledger = await readLedgerFor(winner.email);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].actor_id).toBeNull();
    expect(ledger[0].kind).toBe("auction_won");
    expect(ledger[0].status).toBe("sent");
    expect(ledger[0].provider_id).toBe("re_int_00000000");
    expect(ledger[0].reason).toBeNull();
  });

  it("refuses a second mark on a settled row, so a replay cannot double the ledger", async () => {
    // 20260913120400 guards the update with `and o.status = 'pending'`. The
    // drain cannot tell "the write-back never ran" from "it ran and I never
    // heard back", so it may retry one that landed — and without the guard that
    // writes a second ledger row for a single send, and can flip a `sent` row
    // to `failed`.
    const target = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_won",
    );
    expect(target?.status).toBe("sent");

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: drainSecret,
      p_id: target!.id,
      p_status: "failed",
      p_reason: "unavailable",
    });

    expect(error?.code).toBe("EML03");

    const after = (await readOutbox("sold")).find(
      (row) => row.id === target!.id,
    );
    expect(after?.status).toBe("sent");
    expect(after?.last_error ?? null).toBeNull();

    // Still exactly the one row the successful mark wrote.
    const ledger = await readLedgerFor(winner.email);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("sent");
  });

  it("records a refused send with its reason, and does not retry it", async () => {
    const target = (await readOutbox("sold")).find(
      (row) => row.kind === "auction_sold",
    );

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: drainSecret,
      p_id: target!.id,
      p_status: "failed",
      p_reason: "not_permitted",
    });
    expect(error).toBeNull();

    const after = (await readOutbox("sold")).find(
      (row) => row.id === target!.id,
    );
    expect(after?.status).toBe("failed");
    expect(after?.last_error).toBe("not_permitted");

    const ledger = await readLedgerFor(seller.email);
    expect(ledger[0].status).toBe("failed");
    expect(ledger[0].reason).toBe("not_permitted");
    expect(ledger[0].provider_id).toBeNull();

    // A provider's refusal is a fact, recorded once. The attempt ceiling bounds
    // a *lost write-back*, where this call never happened at all; it is not a
    // second chance at a send the provider already rejected.
    const { data } = await claim(drainSecret, 200);
    const claimedMine = (data ?? []).filter((row) => row.id === target!.id);
    expect(claimedMine).toHaveLength(0);
  });

  it("records a deferred send but leaves the row pending", async () => {
    // 20260913120400. `not_permitted` and `invalid_recipient` are verdicts
    // about this recipient; `rate_limited`, `unavailable`, `timeout` and
    // `unconfigured` are about this moment, and retiring a row for one of those
    // loses a message nobody ever actually declined to deliver. The ledger still
    // records the attempt as `failed` — it did fail — while the outbox row goes
    // back to `pending` for the next tick.
    const target = (await readOutbox("noBids")).find(
      (row) => row.kind === "auction_unsold",
    );
    expect(target).toBeDefined();

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: drainSecret,
      p_id: target!.id,
      p_status: "deferred",
      p_reason: "rate_limited",
    });
    expect(error).toBeNull();

    const after = (await readOutbox("noBids")).find(
      (row) => row.id === target!.id,
    );
    expect(after?.status).toBe("pending");
    expect(after?.sent_at ?? null).toBeNull();
    // Kept rather than cleared: it is why the row is still here, and what an
    // operator reads when the fifteen-minute query turns it up.
    expect(after?.last_error).toBe("rate_limited");

    // By kind, not by position: the seller already has an `auction_sold` row
    // from the refusal above, and both carry this recipient.
    const ledger = (await readLedgerFor(seller.email)).filter(
      (entry) => entry.kind === "auction_unsold",
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].status).toBe("failed");
    expect(ledger[0].reason).toBe("rate_limited");
    expect(ledger[0].provider_id).toBeNull();
  });

  it("refuses a status outside the three it knows", async () => {
    const target = (await readOutbox("noBids")).find(
      (row) => row.kind === "auction_unsold",
    );

    const { error } = await anonymous.rpc("mark_email_sent", {
      p_secret: drainSecret,
      p_id: target!.id,
      p_status: "abandoned",
      p_reason: "invented",
    });

    // Checked before the update, so a bad status cannot leave the outbox row in
    // a state the ledger's own check constraint would then reject.
    expect(error?.code).toBe("EML02");
    expect(
      (await readOutbox("noBids")).find((row) => row.id === target!.id)?.status,
    ).toBe("pending");
  });
});
