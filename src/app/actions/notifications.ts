"use server";

import { createClient } from "@supabase/supabase-js";
import * as z from "zod";
import type { Database } from "@/types/database";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

/**
 * The mutating half of the unsubscribe link.
 *
 * **Only a POST reaches here.** Gmail, Outlook and security gateways prefetch
 * every URL in a message, so a GET that mutated would unsubscribe people who
 * never clicked anything — and the symptom is indistinguishable from the
 * feature working. `src/app/unsubscribe/page.tsx` renders; this changes
 * something, and a scanner does not submit forms.
 *
 * **The token is re-verified here, and the user id is never read from the
 * body.** The form carries the same signed token the link did, not an id — a
 * hidden `userId` would be a mute-anyone endpoint dressed as a form field.
 * Every export of a `"use server"` module is a public endpoint, so the only
 * thing separating this from that is the HMAC.
 *
 * `verifyUnsubscribeToken` is imported, never re-exported: an exported minter
 * would hand any caller a valid link for any user they named.
 */

const LinkPreferenceSchema = z.object({
  token: z.string().min(1),
  /**
   * Which way to set it. Explicit rather than implied, so the confirmation
   * page can offer re-subscribe over the same proven token — a link that can
   * only ever turn something off punishes a misclick.
   */
  enabled: z.enum(["true", "false"]),
});

export type UnsubscribeFormState =
  | {
      /**
       * `invalid` is deliberately one state for every failure the token can
       * have — tampered, truncated, wrong purpose, or an unconfigured
       * environment. The page must not reveal whether a token named a real
       * user, so the caller is given nothing to distinguish them by.
       */
      status: "done" | "invalid" | "error";
      enabled?: boolean;
      message?: string;
    }
  | undefined;

export async function setAuctionEmailsFromLink(
  _state: UnsubscribeFormState,
  formData: FormData,
): Promise<UnsubscribeFormState> {
  const parsed = LinkPreferenceSchema.safeParse({
    token: formData.get("token"),
    enabled: formData.get("enabled"),
  });

  if (!parsed.success) {
    return { status: "invalid" };
  }

  const userId = verifyUnsubscribeToken(parsed.data.token);

  if (!userId) {
    return { status: "invalid" };
  }

  // Read inside the function, never at module scope — `next build` imports
  // every module and CI has no secret. Unset does not mean open: with no
  // secret the RPC below would be refused anyway, so failing here just makes
  // the reason legible instead of surfacing a Postgres error code.
  const rpcSecret = process.env.UNSUBSCRIBE_RPC_SECRET;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!rpcSecret || !supabaseUrl || !supabaseKey) {
    return {
      status: "error",
      message: "Notification settings are unavailable right now.",
    };
  }

  const enabled = parsed.data.enabled === "true";

  // Not the cookie-aware factory from `src/utils/supabase/server.ts`: there is
  // no session here and there must not be one. A sessionless client is exactly
  // right — this caller's authority comes from the token it proved and the
  // secret it holds, not from who it is. Same shape the drain route builds.
  const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await supabase.rpc("set_auction_emails_enabled", {
    p_user_id: userId,
    p_enabled: enabled,
    p_secret: rpcSecret,
  });

  if (error) {
    return {
      status: "error",
      message: "We couldn't save that. Please try again.",
    };
  }

  return { status: "done", enabled };
}
