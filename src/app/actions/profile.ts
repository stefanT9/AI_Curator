"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireProfile, requireUser } from "@/lib/auth/dal";
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

export type NotificationPreferenceFormState =
  | {
      errors?: { auctionEmailsEnabled?: string[] };
      message?: string;
      /** The value that is now stored, so the form can render the new state. */
      enabled?: boolean;
    }
  | undefined;

/**
 * The desired state travels explicitly, as the string "true" or "false".
 *
 * An unchecked checkbox sends no field at all, which is indistinguishable from
 * a malformed body — so "absent" would have to mean "off", and Zod would have
 * nothing left to reject. A hidden field carrying the target value keeps the
 * boundary real: anything that is not one of these two is a bad request rather
 * than a silent opt-out.
 */
const NotificationPreferenceSchema = z.object({
  auctionEmailsEnabled: z.enum(["true", "false"], {
    error: "That isn't a valid notification setting.",
  }),
});

/**
 * FR-005's off switch, from the account page.
 *
 * Every export of a `"use server"` module is a public endpoint, so the user id
 * comes from the verified session and is never accepted from the caller — a
 * user-id parameter here would let anyone mute anyone. RLS enforces the same
 * thing a second time: the insert and update policies on
 * `notification_preferences` both check `auth.uid() = user_id`.
 *
 * Upsert rather than update, because absent-means-enabled leaves most users
 * with no row until the first time they touch this.
 */
export async function updateNotificationPreference(
  _state: NotificationPreferenceFormState,
  formData: FormData,
): Promise<NotificationPreferenceFormState> {
  const user = await requireUser();

  const validatedFields = NotificationPreferenceSchema.safeParse({
    auctionEmailsEnabled: formData.get("auctionEmailsEnabled"),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const enabled = validatedFields.data.auctionEmailsEnabled === "true";

  const supabase = await createClient();
  const { error } = await supabase.from("notification_preferences").upsert(
    {
      user_id: user.id,
      auction_emails_enabled: enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    return {
      message: `Could not save your notification setting: ${error.message}`,
    };
  }

  revalidatePath("/account");

  return { enabled };
}
