import "server-only";

import { createClient } from "@/utils/supabase/server";

/**
 * Read the caller's own auction-notification setting.
 *
 * **Absent means enabled.** `notification_preferences` has no backfill and
 * `handle_new_user` does not write to it, so most users have no row at all —
 * the table comment in
 * `supabase/migrations/20260913130000_add_notification_preferences.sql` records
 * that the column default and this null-handling are the same rule written
 * twice. Returning `false` for a missing row would opt out exactly the users
 * who never touched the switch.
 *
 * An error is treated the same way. This value decides what a page renders, not
 * whether anything sends — the send-side gate is a join condition inside the
 * enqueue function, where a failed read cannot reach it. Rendering the switch
 * "off" because a select failed would tell a collector they had opted out when
 * they had not.
 */
export const getAuctionEmailsEnabled = async (
  userId: string,
): Promise<boolean> => {
  const supabase = await createClient();

  // `maybeSingle`, not `single`: no row is the common case, not an error.
  const { data, error } = await supabase
    .from("notification_preferences")
    .select("auction_emails_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    return true;
  }

  return data.auction_emails_enabled;
};
