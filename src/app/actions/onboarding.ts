"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";

/**
 * The terminal transition of the first-run flow: stamp `onboarded_at` and hand
 * the collector to their now-ranked deck.
 *
 * Separate from `recordInteraction` because the like rows are already durable
 * by the time this runs — they were written card by card as the collector
 * rated. This action must not batch or re-write them.
 *
 * Every export of a "use server" module is a public endpoint, which is why this
 * file holds exactly one function.
 *
 * Called on both exit conditions — the like target reached, or the starter pool
 * exhausted. Exhaustion with zero likes is a normal completion, not an error:
 * releasing that collector onto the newest-first deck is the proven-safe
 * fallback, and treating it as a failure would lock them in the flow forever.
 */
export async function completeOnboarding(): Promise<never> {
  const profile = await requireProfile();

  // Idempotent under a double submit — React StrictMode remounts the auto-fire
  // handoff, and a collector can double-click their fifth like.
  if (profile.onboardedAt !== null) {
    redirect("/discover");
  }

  const supabase = await createClient();

  // A client-side timestamp rather than SQL `now()`: the column grant is what
  // permits this write, and PostgREST has no way to express a server-side
  // default in an update. The value is a record of completion, never compared
  // for ordering against anything else.
  const { error } = await supabase
    .from("profiles")
    .update({ onboarded_at: new Date().toISOString() })
    .eq("id", profile.id);

  if (error) {
    throw new Error(
      `Could not finish setting up your account: ${error.message}`,
    );
  }

  // "layout" so the (app) segment re-runs its gate with the stamp in place.
  revalidatePath("/", "layout");
  redirect("/discover");
}
