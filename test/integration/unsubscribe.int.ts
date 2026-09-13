/**
 * The unauthenticated off switch, driven end to end against real Postgres.
 *
 * This lane can do something the default lane cannot: it runs the *actual*
 * Server Action against the *actual* definer function and the *actual* RLS
 * policies. `src/app/actions/notifications.ts` imports nothing from `next/*`,
 * so there is no framework to stand in for — calling it here exercises the
 * whole chain a recipient's click travels, minus the button.
 *
 * The split with the default lane is deliberate. That lane owns the token —
 * round-trip, tamper, wrong purpose, fail-closed — because HMAC behaviour needs
 * no database. This file owns the half a mock would simply agree with: that the
 * secret gate on `set_auction_emails_enabled` is real, that `anon` genuinely
 * cannot flip a stranger's preference without it, and that `verify_unsubscribe_
 * secret` is callable by nobody. `src/types/database.ts` reflects the catalog
 * and not the grants, so it lists both functions as `rpc()`-callable regardless.
 *
 * The vault entry is read if present and planted if not, exactly as
 * `email-outbox.int.ts` does — never overwritten, because on a developer's
 * stack the same name is what their running app authenticates with, and a spec
 * that rotated it out from under them would break the feature and say nothing
 * about why.
 *
 * Two users, one file (`sign_in_sign_ups` is rate-limited to 30 per five
 * minutes per IP): `recipient` holds the preference the link flips, `bystander`
 * is the stranger nobody may flip.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { requireLocalDatabaseUrl, requireLocalRunningStack } from "./setup";
import { createTestCollector, type TestCollector } from "./helpers";
// Safe to import at module scope: both read their secrets inside the function,
// so `beforeAll` setting them later is in time. That is the same property that
// keeps `next build` working with no secrets in CI.
import { createUnsubscribeToken } from "@/lib/email/unsubscribe";
import { setAuctionEmailsFromLink } from "@/app/actions/notifications";

/** Fixed by 20260913130100_add_unsubscribe_write.sql. */
const RPC_SECRET_NAME = "unsubscribe_rpc_secret";

const TOKEN_SECRET = `int-unsub-token-${crypto.randomUUID()}`;

let pool: Pool;
let recipient: TestCollector;
let bystander: TestCollector;
let anonymous: ReturnType<typeof createClient<Database>>;

/** Use the secret this stack already holds, or plant one. Never overwrite. */
const ensureRpcSecret = async (): Promise<string> => {
  const { rows } = await pool.query<{ decrypted_secret: string | null }>(
    "select decrypted_secret from vault.decrypted_secrets where name = $1",
    [RPC_SECRET_NAME],
  );

  const existing = rows[0]?.decrypted_secret;
  if (existing) return existing;

  const secret = `int-unsub-rpc-${crypto.randomUUID()}`;
  await pool.query("select vault.create_secret($1, $2, $3)", [
    secret,
    RPC_SECRET_NAME,
    "Planted by test/integration/unsubscribe.int.ts on a local stack.",
  ]);

  return secret;
};

/** Read a user's stored setting as that user, under their own RLS. */
const storedPreference = async (
  user: TestCollector,
): Promise<boolean | null> => {
  const { data } = await user.client
    .from("notification_preferences")
    .select("auction_emails_enabled")
    .eq("user_id", user.userId)
    .maybeSingle();

  return data?.auction_emails_enabled ?? null;
};

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  pool = new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 });

  // Set before the action module is imported below, and before anything calls
  // it — both values are read inside the function, so assigning here is enough.
  process.env.UNSUBSCRIBE_TOKEN_SECRET = TOKEN_SECRET;
  process.env.UNSUBSCRIBE_RPC_SECRET = await ensureRpcSecret();

  recipient = await createTestCollector(stack);
  bystander = await createTestCollector(stack);

  anonymous = createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

afterAll(async () => {
  await recipient?.cleanup();
  await bystander?.cleanup();
  await pool?.end();
  delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
  delete process.env.UNSUBSCRIBE_RPC_SECRET;
});

describe("the unsubscribe link, end to end", () => {
  it("creates a row and turns notifications off for a user who had none", async () => {
    expect(await storedPreference(recipient)).toBeNull();

    const token = createUnsubscribeToken(recipient.userId)!;
    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result).toEqual({ status: "done", enabled: false });
    expect(await storedPreference(recipient)).toBe(false);
  });

  it("turns them back on over the same token", async () => {
    const token = createUnsubscribeToken(recipient.userId)!;
    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "true" }),
    );

    expect(result).toEqual({ status: "done", enabled: true });
    expect(await storedPreference(recipient)).toBe(true);
  });

  it("writes nothing at all for a tampered token", async () => {
    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token: "AAAA.BBBB", enabled: "false" }),
    );

    expect(result).toEqual({ status: "invalid" });
    expect(await storedPreference(recipient)).toBe(true);
  });

  /**
   * The write is where a token naming nobody is finally resolved: the foreign
   * key to `profiles` refuses it. The page deliberately cannot tell — see
   * `test/actions/unsubscribe-page.test.ts`.
   */
  it("refuses a validly signed token for a user that does not exist", async () => {
    const token = createUnsubscribeToken(
      "00000000-0000-4000-8000-000000000000",
    )!;

    const result = await setAuctionEmailsFromLink(
      undefined,
      form({ token, enabled: "false" }),
    );

    expect(result?.status).toBe("error");
  });
});

describe("set_auction_emails_enabled", () => {
  beforeEach(async () => {
    // Put the bystander in a known state through the gate itself, so each
    // refusal below is measured against a value that was definitely there.
    await anonymous.rpc("set_auction_emails_enabled", {
      p_user_id: bystander.userId,
      p_enabled: true,
      p_secret: process.env.UNSUBSCRIBE_RPC_SECRET!,
    });
  });

  /**
   * The reason the function takes a secret at all. `anon` is the only role this
   * project's route can present — there is no service-role key — so without
   * this gate the function would be a mute-anyone endpoint reachable by anybody
   * holding the publishable key, which is public by design.
   */
  it("refuses an anonymous caller with the wrong secret", async () => {
    const { error } = await anonymous.rpc("set_auction_emails_enabled", {
      p_user_id: bystander.userId,
      p_enabled: false,
      p_secret: "not-the-secret",
    });

    expect(error).not.toBeNull();
    expect(await storedPreference(bystander)).toBe(true);
  });

  it("refuses an anonymous caller with no secret", async () => {
    const { error } = await anonymous.rpc("set_auction_emails_enabled", {
      p_user_id: bystander.userId,
      p_enabled: false,
      p_secret: "",
    });

    expect(error).not.toBeNull();
    expect(await storedPreference(bystander)).toBe(true);
  });

  /**
   * A signed-in user is no better placed than an anonymous one. Holding a
   * session buys the right to change your *own* row through the Phase 1
   * policies; it buys nothing here.
   */
  it("refuses a signed-in user trying to mute somebody else", async () => {
    const { error } = await recipient.client.rpc("set_auction_emails_enabled", {
      p_user_id: bystander.userId,
      p_enabled: false,
      p_secret: "not-the-secret",
    });

    expect(error).not.toBeNull();
    expect(await storedPreference(bystander)).toBe(true);
  });

  it("is the only way in: verify_unsubscribe_secret is callable by nobody", async () => {
    const asAnon = await anonymous.rpc("verify_unsubscribe_secret", {
      p_secret: process.env.UNSUBSCRIBE_RPC_SECRET!,
    });
    const asUser = await recipient.client.rpc("verify_unsubscribe_secret", {
      p_secret: process.env.UNSUBSCRIBE_RPC_SECRET!,
    });

    expect(asAnon.error).not.toBeNull();
    expect(asUser.error).not.toBeNull();
  });

  /**
   * The write goes through a definer function, so it bypasses the table's
   * policies by design — but it must not bypass their *reach*. What it wrote
   * for one user stays invisible to another.
   */
  it("leaves the row readable only by its owner", async () => {
    const { data } = await recipient.client
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", bystander.userId);

    expect(data).toHaveLength(0);
  });
});
