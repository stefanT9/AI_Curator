"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireProfile } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";

export type ProfileFormState =
  | {
      errors?: { displayName?: string[] };
      message?: string;
      success?: boolean;
    }
  | undefined;

/**
 * Required, because an artist profile is public — a piece attributed to nobody
 * is worse than no attribution at all.
 */
const DisplayNameSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, { error: "Your artist name needs at least 2 characters." })
    .max(60, { error: "Artist name must be 60 characters or fewer." }),
});

/**
 * The collector → artist opt-in. Every account starts as a collector; this is
 * the only way to leave that state.
 *
 * RLS lets a user update their own profile, and a column grant restricts that
 * to `display_name` and `role` — so this cannot be turned into a way to rewrite
 * someone's email even if it were called with a forged body.
 */
export async function becomeArtist(
  _state: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const profile = await requireProfile();

  if (profile.role === "artist") {
    redirect("/studio");
  }

  const validatedFields = DisplayNameSchema.safeParse({
    displayName: formData.get("displayName"),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      role: "artist",
      display_name: validatedFields.data.displayName,
    })
    .eq("id", profile.id);

  if (error) {
    return {
      message: `Could not switch to an artist account: ${error.message}`,
    };
  }

  // "layout" so the nav in (app)/layout.tsx picks up the new Studio link.
  revalidatePath("/", "layout");
  redirect("/studio");
}

/** Renaming yourself later. The name is public, so it is validated the same way. */
export async function updateDisplayName(
  _state: ProfileFormState,
  formData: FormData,
): Promise<ProfileFormState> {
  const profile = await requireProfile();

  const validatedFields = DisplayNameSchema.safeParse({
    displayName: formData.get("displayName"),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: validatedFields.data.displayName })
    .eq("id", profile.id);

  if (error) {
    return { message: `Could not save your name: ${error.message}` };
  }

  revalidatePath("/", "layout");
  revalidatePath(`/artist/${profile.id}`);

  return { success: true };
}
