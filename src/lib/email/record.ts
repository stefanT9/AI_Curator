import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { SendResult } from "./send";

/**
 * The ledger sidecar: one row per send attempt, written through the only
 * function permitted to write it.
 *
 * Lives here rather than beside a Server Action because every export of a
 * `"use server"` module is a public endpoint, and a function that writes
 * arbitrary recipients into the send record has no business being one — the
 * same argument `src/lib/artworks/top-up.ts` makes about `topUpTags`, applied
 * to a table nobody can read back through a client.
 *
 * Separate from `./send` for a reason that is not tidiness: `sendEmail` is
 * database-free so it can be called from the smoke lane, which has no session
 * and no Supabase client at all. Keeping the write out here is what lets a
 * caller with no database access still send, and a caller with one still
 * record.
 *
 * Takes a client rather than constructing one, so the same function serves a
 * Server Action, a route handler and a script without being bound to a request
 * context.
 */

/**
 * Only the surface this module uses. `SupabaseClient<Database>` is the shape
 * both `src/utils/supabase/server.ts` and the integration lane's clients
 * satisfy; naming it here keeps the dependency one-way.
 */
export type EmailLedgerClient = SupabaseClient<Database>;

/**
 * What happened, and to whom. `result` is a `SendResult` verbatim so a caller
 * hands over exactly what `sendEmail` gave it, with nothing to translate and
 * therefore nothing to get wrong.
 *
 * `actor_id` is deliberately absent: `record_email_send` reads it from
 * `auth.uid()` itself, so a caller cannot attribute a row to anyone else.
 */
export type SendLedgerEntry = {
  recipient: string;
  /** What sort of message this was — `"auction_closed"`, `"artwork_liked"`. */
  kind: string;
  result: SendResult;
};

/**
 * Record one attempt. Never throws, and never reports.
 *
 * A ledger that fails must not take down the send it was recording: by the
 * time this runs the message has already left (or already failed), and there
 * is nothing a caller could usefully do with a write error anyway. The
 * try/catch is the same belt-and-braces wrapper `topUpTags` puts around
 * `enrichFromImage` — the RPC returns errors rather than throwing, so reaching
 * the catch means something outside the request path broke.
 */
export const recordSend = async (
  supabase: EmailLedgerClient,
  entry: SendLedgerEntry,
): Promise<void> => {
  const { result } = entry;

  try {
    await supabase.rpc("record_email_send", {
      p_recipient: entry.recipient,
      p_kind: entry.kind,
      p_status: result.ok ? "sent" : "failed",
      // Omitted rather than nulled: both are `default null` in the function and
      // the generated argument types are therefore `?: string`. The union makes
      // the pairing structural — a `provider_id` without a delivery, or a
      // `reason` without a failure, is not expressible here.
      ...(result.ok
        ? { p_provider_id: result.id }
        : { p_reason: result.reason }),
    });
  } catch {
    // Swallowed on purpose — see the docblock above.
  }
};
