/**
 * F-02's ledger, proven where it is provable: against real Postgres, under
 * real RLS.
 *
 * Nothing in the default lane can answer a single question this file asks.
 * `npm run test` mocks Supabase entirely, and `src/types/database.ts` reflects
 * the *catalog*, not the grants — `close_due_auctions` is `rpc()`-callable at
 * the type level despite being granted to nobody
 * (src/types/database.ts, 20260912120000_add_auction_close.sql:129-132). So a
 * wrongly-privileged call type-checks, lints, builds and passes the default
 * suite, and only a real database disagrees. `email_sends` leans harder on
 * that than anything before it: its access control is the *absence* of four
 * policies and the revoke on one function, and an absence is exactly what a
 * mock cannot fail to honour.
 *
 * The split follows `auction-close.int.ts`: ordinary RLS-bound clients for
 * everything a user can attempt, and one direct postgres connection for the
 * thing that is deliberately ungranted — here, reading the table at all.
 * `requireLocalDatabaseUrl` applies the same loopback guard the anon rail does.
 *
 * Two collectors, one file (`sign_in_sign_ups` is rate-limited to 30 per five
 * minutes per IP): `author` writes every fixture row, and `other` exists only
 * to show that attribution follows the session rather than the arguments.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { requireLocalDatabaseUrl, requireLocalRunningStack } from "./setup";
import { createTestCollector, type TestCollector } from "./helpers";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recipients are fabricated per run so a reset-less local stack stays legible. */
const recipient = (label: string) =>
  `artswipe-ledger-${label}-${crypto.randomUUID()}@example.test`;

type LedgerRow = {
  id: string;
  actor_id: string | null;
  recipient: string;
  kind: string;
  status: string;
  reason: string | null;
  provider_id: string | null;
};

let author: TestCollector;
let other: TestCollector;
let pool: Pool;

/** A delivered send, recorded the way a real caller records one. */
let sentId: string;
let sentRecipient: string;

/** A refused send: the shape the ledger exists for. */
let failedId: string;
let failedRecipient: string;

/**
 * Record one attempt as the given user. Optional arguments are omitted rather
 * than passed as null, because `record_email_send` defaults them — which is
 * also how `recordSend` in `src/lib/email/record.ts` builds the call.
 */
const record = async (
  who: TestCollector,
  entry: {
    recipient: string;
    kind: string;
    status: "sent" | "failed";
    reason?: string;
    providerId?: string;
  },
): Promise<string> => {
  const { data, error } = await who.client.rpc("record_email_send", {
    p_recipient: entry.recipient,
    p_kind: entry.kind,
    p_status: entry.status,
    ...(entry.reason === undefined ? {} : { p_reason: entry.reason }),
    ...(entry.providerId === undefined
      ? {}
      : { p_provider_id: entry.providerId }),
  });

  if (error || !data) {
    throw new Error(`Could not record a send: ${error?.message}`);
  }

  return data;
};

/** The only way to read this table: no client has a select policy to use. */
const readRow = async (id: string): Promise<LedgerRow | undefined> => {
  const { rows } = await pool.query<LedgerRow>(
    `select id, actor_id, recipient, kind, status, reason, provider_id
       from public.email_sends
      where id = $1`,
    [id],
  );

  return rows[0];
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 });

  [author, other] = await Promise.all([
    createTestCollector(stack),
    createTestCollector(stack),
  ]);

  sentRecipient = recipient("sent");
  sentId = await record(author, {
    recipient: sentRecipient,
    kind: "auction_closed",
    status: "sent",
    providerId: "re_fixture_00000000",
  });

  failedRecipient = recipient("failed");
  failedId = await record(author, {
    recipient: failedRecipient,
    kind: "auction_closed",
    status: "failed",
    reason: "not_permitted",
  });
});

afterAll(async () => {
  // The fixture rows are deliberately **not** deleted, unlike every other
  // spec's teardown. Two reasons, and neither is laziness: the ledger is
  // append-only by design, so a teardown reaching over the superuser
  // connection to erase its own history would be modelling a capability this
  // schema exists to deny — and the rows are what the operator's
  // failure-visibility query reads after a run
  // (`select ... from public.email_sends order by created_at desc`). They cost
  // a few bytes on a local stack that `supabase db reset` clears anyway.
  await Promise.all([author?.cleanup(), other?.cleanup()]);
  await pool?.end();
});

describe("the one writer", () => {
  it("accepts a send from an authenticated caller and returns the row id", () => {
    // `authenticated` is the only role with execute on this function, and the
    // uuid comes back because the caller gets an id it can quote later without
    // ever being able to read the row.
    expect(sentId).toMatch(UUID_PATTERN);
    expect(failedId).toMatch(UUID_PATTERN);
    expect(sentId).not.toBe(failedId);
  });

  it("round-trips a delivered send with its provider id and no reason", async () => {
    const row = await readRow(sentId);

    expect(row).toBeDefined();
    expect(row?.recipient).toBe(sentRecipient);
    expect(row?.kind).toBe("auction_closed");
    expect(row?.status).toBe("sent");
    expect(row?.provider_id).toBe("re_fixture_00000000");
    expect(row?.reason).toBeNull();
  });

  it("round-trips a failed send with its SendFailure reason and no provider id", async () => {
    const row = await readRow(failedId);

    // This row is the whole point of F-02: "a failure is visible rather than
    // silent" is this column, queryable after the fact, and nothing else —
    // the project has no logger at all.
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("not_permitted");
    expect(row?.provider_id).toBeNull();
  });

  it("refuses the call outright from a signed-out caller", async () => {
    const stack = await requireLocalRunningStack();
    const anonymous = createClient<Database>(stack.url, stack.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { error } = await anonymous.rpc("record_email_send", {
      p_recipient: recipient("anon"),
      p_kind: "auction_closed",
      p_status: "sent",
    });

    // The revoke from `anon` is not decoration: a new function in `public` is
    // born granted to anon, authenticated, service_role and public, so without
    // it a signed-out caller could write ledger rows naming any recipient.
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

describe("attribution follows the session", () => {
  it("stamps the row with the caller's own user, not the fixture's author", async () => {
    const sent = await readRow(sentId);
    expect(sent?.actor_id).toBe(author.userId);

    const theirs = await record(other, {
      recipient: recipient("other"),
      kind: "artwork_liked",
      status: "sent",
      providerId: "re_fixture_11111111",
    });

    const row = await readRow(theirs);
    expect(row?.actor_id).toBe(other.userId);
    expect(row?.actor_id).not.toBe(author.userId);
  });

  it("exposes no parameter through which an actor could be named", async () => {
    const { rows } = await pool.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_email_send'`,
    );

    // `actor_id` is set from `(select auth.uid())` inside the function. The
    // absence of a parameter is what makes granting execute to `authenticated`
    // safe — the call writes a row the caller could not otherwise write, but
    // only ever about itself.
    expect(rows).toHaveLength(1);
    expect(rows[0].args).not.toContain("actor");
  });
});

describe("the closed table surface", () => {
  it("shows the very author of a row zero rows, and no error", async () => {
    const { data, error } = await author.client
      .from("email_sends")
      .select("*")
      .eq("id", sentId);

    // RLS is on with no select policy, so this is invisibility rather than
    // refusal — the caller learns nothing, including whether there was
    // anything to learn. The row is provably there: `readRow` just read it.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { count } = await author.client
      .from("email_sends")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("refuses a direct insert", async () => {
    const { error } = await author.client
      .from("email_sends")
      .insert({
        actor_id: author.userId,
        recipient: recipient("forged"),
        kind: "auction_closed",
        status: "sent",
      })
      .select();

    // INSERT is the one verb that errors rather than no-ops: the new row has
    // no WITH CHECK to pass. Every write therefore goes through
    // `record_email_send`, which is what makes `actor_id` trustworthy.
    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");
  });

  it("refuses a direct update, leaving a recorded failure exactly as it was", async () => {
    await author.client
      .from("email_sends")
      .update({ status: "sent", reason: null })
      .eq("id", failedId);

    // With no UPDATE policy, Postgres admits no rows to the USING filter and
    // the statement is a silent no-op rather than an error — the shape
    // `bids.int.ts` records. What matters is observable either way: append-only
    // means a failure cannot be rewritten into a success.
    const row = await readRow(failedId);
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("not_permitted");
  });

  it("refuses a direct delete, so a failure cannot be erased", async () => {
    await author.client.from("email_sends").delete().eq("id", failedId);

    const row = await readRow(failedId);
    expect(row).toBeDefined();
    expect(row?.id).toBe(failedId);
  });
});
