/**
 * FR-005's storage, proven where its claim actually lives: in the policies.
 *
 * The default lane mocks Supabase entirely, so it can assert that the Server
 * Action *calls* upsert but not that one user is unable to read or rewrite
 * another's setting. And `src/types/database.ts` reflects the catalog rather
 * than the grants, so the generated types say `notification_preferences` is
 * selectable and updatable by anyone — which is exactly the claim this file has
 * to check for real.
 *
 * The isolation matters here in a way it did not for `interactions`, because
 * this table was created *instead of* a column on `profiles`: the migration's
 * header argues that a preference column there would have been exposed on every
 * artist row by the artist-profiles select policy. That argument is only worth
 * anything if the replacement genuinely has one reader. Hence the cross-user
 * cases below, which are the whole point of the table existing separately.
 *
 * Three users, one file (`sign_in_sign_ups` is rate-limited to 30 per five
 * minutes per IP): `owner` holds the preference row, `other` is the foil that
 * must not be able to see or touch it, and `bystander` never gets a row —
 * it exists so the "cannot reassign a row to another user" case has a target
 * whose primary key is free, leaving the policy as the only thing that can
 * refuse the statement.
 *
 * Note on teardown: there is no delete policy on this table by design, so these
 * rows outlive the run. `supabase db reset` clears them; they are keyed by
 * per-run user ids and collide with nothing.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireLocalRunningStack } from "./setup";
import { createTestCollector, type TestCollector } from "./helpers";

let owner: TestCollector;
let other: TestCollector;
let bystander: TestCollector;

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  owner = await createTestCollector(stack);
  other = await createTestCollector(stack);
  bystander = await createTestCollector(stack);
});

afterAll(async () => {
  await owner?.cleanup();
  await other?.cleanup();
  await bystander?.cleanup();
});

describe("notification_preferences", () => {
  /**
   * The absent-row rule, observed rather than assumed. A fresh user has no row
   * at all — `handle_new_user` does not write one and there is no backfill —
   * which is what makes "missing means enabled" the only correct reading.
   */
  it("gives a brand-new user no row at all", async () => {
    const { data, error } = await bystander.client
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", bystander.userId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("lets a user insert, read back and flip their own preference", async () => {
    const { error: insertError } = await owner.client
      .from("notification_preferences")
      .upsert(
        { user_id: owner.userId, auction_emails_enabled: false },
        { onConflict: "user_id" },
      );
    expect(insertError).toBeNull();

    const { data: offRow } = await owner.client
      .from("notification_preferences")
      .select("auction_emails_enabled")
      .eq("user_id", owner.userId)
      .single();
    expect(offRow?.auction_emails_enabled).toBe(false);

    // The same upsert shape the Server Action uses, taking the row back on.
    const { error: updateError } = await owner.client
      .from("notification_preferences")
      .upsert(
        { user_id: owner.userId, auction_emails_enabled: true },
        { onConflict: "user_id" },
      );
    expect(updateError).toBeNull();

    const { data: onRow } = await owner.client
      .from("notification_preferences")
      .select("auction_emails_enabled")
      .eq("user_id", owner.userId)
      .single();
    expect(onRow?.auction_emails_enabled).toBe(true);
  });

  it("defaults a row to enabled when the column is not supplied", async () => {
    const { error } = await other.client
      .from("notification_preferences")
      .insert({ user_id: other.userId });
    expect(error).toBeNull();

    const { data } = await other.client
      .from("notification_preferences")
      .select("auction_emails_enabled")
      .eq("user_id", other.userId)
      .single();
    expect(data?.auction_emails_enabled).toBe(true);
  });

  /**
   * The case `profiles` could not have delivered: a second signed-in user sees
   * nothing, not even that a row exists. A select policy scoped by nothing but
   * a column grant — which is what a `profiles` column would have had — would
   * return the row here.
   */
  it("hides one user's preference row from another user entirely", async () => {
    const { data, error } = await other.client
      .from("notification_preferences")
      .select("user_id, auction_emails_enabled")
      .eq("user_id", owner.userId);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("refuses an insert naming another user", async () => {
    const { error } = await other.client
      .from("notification_preferences")
      .insert({ user_id: owner.userId, auction_emails_enabled: false })
      .select();

    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");
  });

  /**
   * An UPDATE with no matching policy admits no rows to the USING filter rather
   * than erroring — the silent-no-op shape `auctions.int.ts` records. What
   * matters is the same either way: the owner's setting is unchanged.
   */
  it("cannot mute another user", async () => {
    await other.client
      .from("notification_preferences")
      .update({ auction_emails_enabled: false })
      .eq("user_id", owner.userId);

    const { data } = await owner.client
      .from("notification_preferences")
      .select("auction_emails_enabled")
      .eq("user_id", owner.userId)
      .single();

    expect(data?.auction_emails_enabled).toBe(true);
  });

  /**
   * WITH CHECK on the update policy, not just USING: without it a user could
   * reassign their own row's primary key and take over someone else's setting.
   *
   * The target is `bystander`, who has no row — so the primary key is free and
   * the foreign key resolves. The policy is the only thing left that can refuse
   * this statement, which is what makes the refusal mean what it says.
   */
  it("refuses to reassign a row to another user", async () => {
    const { error } = await other.client
      .from("notification_preferences")
      .update({ user_id: bystander.userId })
      .eq("user_id", other.userId)
      .select();

    expect(error).not.toBeNull();
    expect(error?.message).toContain("row-level security policy");

    const { data } = await bystander.client
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", bystander.userId);
    expect(data).toHaveLength(0);
  });

  /**
   * No delete policy, deliberately: under the absent-row rule a delete would
   * mean "enabled", reaching that state by a path nothing else in the schema
   * knows about. The update path is the only way to change this setting.
   */
  it("does not let a user delete their own preference row", async () => {
    await other.client
      .from("notification_preferences")
      .delete()
      .eq("user_id", other.userId);

    const { data } = await other.client
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", other.userId);

    expect(data).toHaveLength(1);
  });
});
