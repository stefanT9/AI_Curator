/**
 * FR-003 and FR-005, proven together against real Postgres and real RLS.
 *
 * This is the file the whole phase order was built for. Nothing in the default
 * lane can answer a question asked here: `npm run test` mocks Supabase
 * entirely, the enqueue is a trigger nobody calls, `email_outbox`'s access
 * control is the *absence* of four policies, and `src/types/database.ts`
 * reflects the catalog rather than the grants. A mock agrees with whatever the
 * caller asserts about all three.
 *
 * The claim under test is a claim about **rows that do not exist**. §Guardrails
 * says "no notification reaches an untargeted collector" and "off means off —
 * from any path", and the enqueue implements both as join conditions rather
 * than as a check somewhere downstream. So the assertions below are mostly
 * negative: a collector who opted out has no row, not a row that fails; a
 * skipper has none; the seller has none even having liked their own piece.
 * Counting rows in `email_outbox` is the only way to tell "we refused to
 * enqueue" from "we enqueued and something later declined to send".
 *
 * The second half drives `drainOutbox` over the rows the trigger wrote, with
 * only the provider faked. Claim, compose, link-minting, mark and the
 * `email_sends` write are all real — which is what makes the unsubscribe link
 * in the rendered body assertable: it is minted from the `recipient_id` the
 * *trigger* chose, and verifying it back to that collector's user id proves the
 * payload names the right person. `test/lib/email-templates.test.ts` owns the
 * body's wording; this file owns the identity behind it.
 *
 * Five users, one file (`sign_in_sign_ups` is rate-limited to 30 per five
 * minutes per IP): `seller` is the artist who lists, `likerDefault` never
 * touched the setting, `likerEnabled` turned it on explicitly, `optedOut`
 * turned it off, and `skipper` swiped left. `likerDefault` and `likerEnabled`
 * are both present because the absent-row rule and the stored-true case reach
 * the same outcome down two different branches of the same `coalesce`.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

// Hoisted so the `vi.mock` factory can see it — a module-level const cannot.
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));

/**
 * The one boundary this file fakes, and the only one it may.
 *
 * Resend is a third party with a shared sending domain that answers 403 for
 * every address but the account owner's; a lane that called it for real would
 * assert delivery it cannot have and would mail whoever is running the suite.
 * Everything on this side of it — the trigger, the claim, the compose, the
 * link minting, the ledger write — stays real. The smoke lane owns one actual
 * send.
 */
vi.mock("@/lib/email/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/send")>();
  return { ...actual, sendEmail };
});

import { drainOutbox } from "@/lib/email/outbox";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

/** The vault entry both drain functions read. Fixed by 20260913120000. */
const DRAIN_SECRET_NAME = "email_drain_secret";

const SITE_URL = "https://artswipe.test";
const TOKEN_SECRET = `int-opened-token-${crypto.randomUUID()}`;

const STARTING_PRICE_CENTS = 12_500;

type OutboxRow = {
  id: string;
  recipient_email: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string | null;
};

type FixtureKey = "liked" | "unliked";

let pool: Pool;
let anonymous: TestClient;
let drainSecret: string;

let seller: TestArtist;
let likerDefault: TestCollector;
let likerEnabled: TestCollector;
let optedOut: TestCollector;
let skipper: TestCollector;

const artworkIds = new Map<FixtureKey, string>();
const auctionIds = new Map<FixtureKey, string>();

const auctionId = (key: FixtureKey): string => {
  const value = auctionIds.get(key);
  if (!value) throw new Error(`Fixture auction ${key} was not created`);
  return value;
};

/** Read the outbox over the direct connection — no client has a select policy. */
const readOutbox = async (key: FixtureKey): Promise<OutboxRow[]> => {
  const { rows } = await pool.query<OutboxRow>(
    `select id, recipient_email, kind, payload, status, attempts, last_error
       from public.email_outbox
      where auction_id = $1
      order by recipient_email`,
    [auctionId(key)],
  );

  return rows;
};

const readLedgerFor = async (recipient: string) => {
  const { rows } = await pool.query<{
    kind: string;
    status: string;
    reason: string | null;
    provider_id: string | null;
    actor_id: string | null;
  }>(
    `select kind, status, reason, provider_id, actor_id
       from public.email_sends
      where recipient = $1
      order by created_at desc`,
    [recipient],
  );

  return rows;
};

/** Use the secret this stack already holds, or plant one. Never overwrite. */
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
    "Planted by test/integration/auction-opened-emails.int.ts on a local stack.",
  ]);

  return secret;
};

const rate = async (
  who: TestArtist | TestCollector,
  key: FixtureKey,
  action: "like" | "skip",
): Promise<void> => {
  const artworkId = artworkIds.get(key);
  if (!artworkId) throw new Error(`Fixture artwork ${key} was not created`);

  const { error } = await who.client
    .from("interactions")
    .insert({ user_id: who.userId, artwork_id: artworkId, action });

  if (error) {
    throw new Error(
      `Could not record the ${action} on ${key}: ${error.message}`,
    );
  }
};

/** Write a preference row as its own owner, under the Phase 1 policies. */
const setPreference = async (
  who: TestCollector,
  enabled: boolean,
): Promise<void> => {
  const { error } = await who.client
    .from("notification_preferences")
    .insert({ user_id: who.userId, auction_emails_enabled: enabled });

  if (error) {
    throw new Error(`Could not set the preference: ${error.message}`);
  }
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

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 });
  anonymous = createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  drainSecret = await ensureDrainSecret();

  [seller, likerDefault, likerEnabled, optedOut, skipper] = await Promise.all([
    createTestArtist(stack),
    createTestCollector(stack),
    createTestCollector(stack),
    createTestCollector(stack),
    createTestCollector(stack),
  ]);

  // One object, reused by both fixtures — this spec asserts who gets a row,
  // not what an image looks like.
  const imagePath = await seller.upload(TINY_PNG);

  const { data: rows, error } = await seller.client
    .from("artworks")
    .insert([
      {
        artist_id: seller.userId,
        title: "S-05 opened liked",
        image_path: imagePath,
      },
      {
        artist_id: seller.userId,
        title: "S-05 opened unliked",
        image_path: imagePath,
      },
    ])
    .select("id, title");

  if (error || !rows) {
    throw new Error(`Could not insert fixture artworks: ${error?.message}`);
  }

  for (const row of rows) {
    artworkIds.set(row.title.replace("S-05 opened ", "") as FixtureKey, row.id);
  }

  // The preferences go in before the likes, and both before the listing: the
  // trigger reads the world as it finds it at insert time, which is exactly
  // what §Constraints requires of likes recorded before this feature existed.
  await setPreference(likerEnabled, true);
  await setPreference(optedOut, false);

  await rate(likerDefault, "liked", "like");
  await rate(likerEnabled, "liked", "like");
  await rate(optedOut, "liked", "like");
  await rate(skipper, "liked", "skip");
  // Nothing stops an artist liking their own work — `swipe_deck` hides it from
  // the deck, `interactions` has no such constraint — so the seller exclusion
  // has a real case to answer rather than a hypothetical one.
  await rate(seller, "liked", "like");

  // The listing itself. Every outbox row this file reads is a side effect of
  // these two calls; nothing here ever inserts one.
  await openAuction("liked");
  await openAuction("unliked");
});

afterAll(async () => {
  // Deleting the fixture artworks clears the auctions via `on delete cascade`,
  // and those clear their outbox rows the same way. The `email_sends` rows are
  // deliberately left: the ledger is append-only, and reaching over the
  // superuser connection to erase its own history would model a capability the
  // schema exists to deny. `notification_preferences` has no delete policy by
  // design, so those rows outlive the run too — `supabase db reset` clears
  // them and they are keyed by per-run user ids.
  await Promise.all([
    seller?.cleanup(),
    likerDefault?.cleanup(),
    likerEnabled?.cleanup(),
    optedOut?.cleanup(),
    skipper?.cleanup(),
  ]);
  await pool?.end();
});

describe("listing a piece notifies the collectors who liked it", () => {
  it("writes exactly one row per eligible liker, and no more", async () => {
    const rows = await readOutbox("liked");

    // Two, not five. The other three people who interacted with this artwork
    // are each excluded by a different clause, asserted one at a time below.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.recipient_email).sort()).toEqual(
      [likerDefault.email, likerEnabled.email].sort(),
    );
    expect(rows.every((row) => row.kind === "auction_opened")).toBe(true);

    // Every row starts unclaimed; `attempts` is the drain's business alone.
    expect(rows.every((row) => row.status === "pending")).toBe(true);
    expect(rows.every((row) => row.attempts === 0)).toBe(true);
  });

  it("gives a collector who never touched the setting a row", async () => {
    // The absent-row rule, observed at the only place it matters. `left join`
    // plus `coalesce(..., true)`: an inner join here would notify nobody but
    // the handful of people who have visited their account page, and would
    // look like a working feature to whoever tested it after opting in.
    const { rows } = await pool.query<{ count: string }>(
      `select count(*) as count from public.notification_preferences where user_id = $1`,
      [likerDefault.userId],
    );
    expect(rows[0].count).toBe("0");

    const mine = (await readOutbox("liked")).filter(
      (row) => row.recipient_email === likerDefault.email,
    );
    expect(mine).toHaveLength(1);
  });

  it("gives a collector who explicitly opted in a row", async () => {
    const mine = (await readOutbox("liked")).filter(
      (row) => row.recipient_email === likerEnabled.email,
    );
    expect(mine).toHaveLength(1);
  });

  it("gives a collector who opted out NO row at all", async () => {
    // The distinction this whole slice turns on. A row that later failed to
    // send would still have written this person's address into `email_outbox`
    // and then into `email_sends`, on account of a message they declined —
    // so "no row" is the assertion, and counting is the only way to make it.
    const rows = await readOutbox("liked");
    expect(
      rows.filter((row) => row.recipient_email === optedOut.email),
    ).toHaveLength(0);

    // Nothing anywhere in the outbox names them, not just nothing on this
    // auction.
    const { rows: anywhere } = await pool.query<{ count: string }>(
      `select count(*) as count from public.email_outbox where recipient_email = $1`,
      [optedOut.email],
    );
    expect(anywhere[0].count).toBe("0");
  });

  it("gives a collector who skipped the piece no row", async () => {
    // `and i.action = 'like'`. A skip is an interaction too, and the guardrail
    // is "no notification reaches an untargeted collector" — a swipe left is
    // the clearest statement of untargeted there is.
    const rows = await readOutbox("liked");
    expect(
      rows.filter((row) => row.recipient_email === skipper.email),
    ).toHaveLength(0);
  });

  it("gives the seller no row, even though they liked their own piece", async () => {
    const rows = await readOutbox("liked");
    expect(
      rows.filter((row) => row.recipient_email === seller.email),
    ).toHaveLength(0);
  });

  it("enqueues nothing for a piece nobody liked, without erroring", async () => {
    // The listing itself succeeded — `openAuction` throws otherwise — which is
    // the real assertion here: an enqueue that raised on an empty recipient set
    // would take the artist's listing down with it, inside the same
    // transaction.
    expect(auctionId("unliked")).toBeTruthy();
    expect(await readOutbox("unliked")).toHaveLength(0);
  });

  it("carries the piece, the asking price and the closing time, and nothing about bidding", async () => {
    const row = (await readOutbox("liked"))[0];

    // Exactly the five keys `auctionOpenedPayloadSchema` admits. It is a
    // `z.strictObject`, so a sixth added here would make every row
    // unrenderable rather than rendering a body that quietly dropped it.
    expect(Object.keys(row.payload).sort()).toEqual([
      "artwork_title",
      "auction_id",
      "ends_at",
      "recipient_id",
      "starting_price_cents",
    ]);

    expect(row.payload.artwork_title).toBe("S-05 opened liked");
    expect(row.payload.starting_price_cents).toBe(STARTING_PRICE_CENTS);
    expect(row.payload.auction_id).toBe(auctionId("liked"));

    // The recipient's own id, so the link can be minted in Node at render
    // time — the signing secret never reaches SQL.
    expect(row.payload.recipient_id).toBe(
      row.recipient_email === likerDefault.email
        ? likerDefault.userId
        : likerEnabled.userId,
    );

    // ISO 8601 with an offset, which is what the payload schema requires and
    // what `to_json(timestamptz)` always produces.
    expect(String(row.payload.ends_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/,
    );

    // No address but the recipient's own, which lives in its own column, and
    // nothing that could be an amount anyone offered. Belt and braces against
    // a future field smuggling one in under another name.
    expect(JSON.stringify(row.payload)).not.toContain("@");
  });
});

describe("the drain sends what the trigger queued", () => {
  it("renders, sends and records each row as auction_opened", async () => {
    vi.stubEnv("EMAIL_DRAIN_SECRET", drainSecret);
    vi.stubEnv("SITE_URL", SITE_URL);
    vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", TOKEN_SECRET);
    sendEmail.mockImplementation(async () => ({
      ok: true,
      id: `re_int_${crypto.randomUUID().slice(0, 8)}`,
    }));

    // The drain is deliberately not scoped to one auction, so ask for enough
    // that our two rows are certainly in the batch, and assert on ours rather
    // than on the summary. Sibling specs clean their outbox rows up by
    // cascade, but the queue is shared and this file does not own it.
    const summary = await drainOutbox(anonymous, { limit: 200 });
    expect(summary.claimError).toBeUndefined();

    const rows = await readOutbox("liked");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.last_error).toBeNull();
    }

    // `mark_email_sent` writes the ledger itself, definer to definer, so
    // `actor_id` lands null — the case 20260912140000 documents as normal for
    // a drained message.
    for (const collector of [likerDefault, likerEnabled]) {
      const ledger = (await readLedgerFor(collector.email)).filter(
        (entry) => entry.kind === "auction_opened",
      );
      expect(ledger).toHaveLength(1);
      expect(ledger[0].status).toBe("sent");
      expect(ledger[0].reason).toBeNull();
      expect(ledger[0].provider_id).not.toBeNull();
      expect(ledger[0].actor_id).toBeNull();
    }
  });

  it("addresses each body's unsubscribe link to the collector the trigger chose", async () => {
    const sent = sendEmail.mock.calls
      .map(([message]) => message as { to: string; text: string })
      .filter(
        (message) =>
          message.to === likerDefault.email ||
          message.to === likerEnabled.email,
      );

    expect(sent).toHaveLength(2);

    for (const message of sent) {
      const expectedId =
        message.to === likerDefault.email
          ? likerDefault.userId
          : likerEnabled.userId;

      const link = message.text.match(
        new RegExp(`${SITE_URL}/unsubscribe\\?token=([^\\s]+)`),
      );
      expect(link).not.toBeNull();

      // The end-to-end identity claim: the token in the body was minted from
      // the `recipient_id` the *trigger* chose, and it verifies back to the
      // collector this message was addressed to. A trigger that put the wrong
      // id in the payload would mail one person an off switch for another's
      // notifications, and every intermediate step would look fine.
      expect(verifyUnsubscribeToken(decodeURIComponent(link![1]))).toBe(
        expectedId,
      );

      expect(message.text).toContain(
        `${SITE_URL}/auctions/${auctionId("liked")}`,
      );
    }
  });
});
