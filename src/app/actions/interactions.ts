"use server";

import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireUser } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";
import type { InteractionAction } from "@/types/domain";

export type InteractionResult = { ok: true } | { ok: false; message: string };

const InteractionSchema = z.object({
  artworkId: z.uuid({ error: "Unknown artwork." }),
  action: z.enum(["like", "skip"]),
});

/**
 * Called from the swipe deck rather than a form, so it takes arguments instead
 * of FormData and returns a result the client can act on — the deck advances
 * optimistically and puts the card back if this fails.
 */
export async function recordInteraction(
  artworkId: string,
  action: InteractionAction,
): Promise<InteractionResult> {
  const validated = InteractionSchema.safeParse({ artworkId, action });

  if (!validated.success) {
    return { ok: false, message: "That swipe could not be recorded." };
  }

  const user = await requireUser();
  const supabase = await createClient();

  // Upsert on the (user_id, artwork_id) unique constraint: changing your mind
  // about a piece overwrites the old verdict rather than erroring.
  const { error } = await supabase.from("interactions").upsert(
    {
      user_id: user.id,
      artwork_id: validated.data.artworkId,
      action: validated.data.action,
    },
    { onConflict: "user_id,artwork_id" },
  );

  if (error) {
    return { ok: false, message: "That swipe could not be recorded." };
  }

  revalidatePath("/liked");

  return { ok: true };
}
