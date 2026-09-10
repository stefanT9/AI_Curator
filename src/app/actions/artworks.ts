"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireArtist } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";
import { ARTWORKS_BUCKET, IMAGE_PATH_PATTERN } from "@/lib/artworks/images";
import { MAX_TAGS, MAX_TAG_LENGTH } from "@/lib/artworks/tags";
import { topUpTags } from "@/lib/artworks/top-up";

export type ArtworkFormState =
  | {
      errors?: {
        title?: string[];
        description?: string[];
        tags?: string[];
        image?: string[];
      };
      message?: string;
    }
  | undefined;

const asString = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value : "";

const TitleSchema = z
  .string()
  .trim()
  .min(1, { error: "Give the piece a title." })
  .max(120, { error: "Title must be 120 characters or fewer." });

const DescriptionSchema = z
  .string()
  .trim()
  .max(2000, { error: "Description must be 2000 characters or fewer." })
  .transform((value) => (value.length > 0 ? value : null));

/** One comma-separated field in, a clean array out: trimmed, lowercased, deduped. */
const TagsSchema = z
  .string()
  .transform((value) =>
    Array.from(
      new Set(
        value
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
      ),
    ),
  )
  .pipe(
    z
      .array(
        z.string().max(MAX_TAG_LENGTH, {
          error: `Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`,
        }),
      )
      .max(MAX_TAGS, { error: `Use at most ${MAX_TAGS} tags.` }),
  );

/**
 * The browser uploads the image and submits its object key, so what arrives
 * here is a string, not a `File` — see `src/lib/artworks/upload.ts` for why.
 * The pattern proves the key's shape only; ownership and existence are checked
 * against the authenticated artist below.
 */
const ImagePathSchema = z
  .string()
  .regex(IMAGE_PATH_PATTERN, { error: "Choose an image to upload." });

const CreateArtworkSchema = z.object({
  title: TitleSchema,
  description: DescriptionSchema,
  tags: TagsSchema,
  image: ImagePathSchema,
});

/** Editing metadata only — swapping the image is a delete-and-reupload for now. */
const UpdateArtworkSchema = z.object({
  title: TitleSchema,
  description: DescriptionSchema,
  tags: TagsSchema,
});

export async function createArtwork(
  _state: ArtworkFormState,
  formData: FormData,
): Promise<ArtworkFormState> {
  const artist = await requireArtist();

  const validatedFields = CreateArtworkSchema.safeParse({
    title: asString(formData.get("title")),
    description: asString(formData.get("description")),
    tags: asString(formData.get("tags")),
    image: asString(formData.get("image")),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const { title, description, tags, image: imagePath } = validatedFields.data;

  // The key came from the client, so neither of these can be assumed. The
  // folder check is the security one: the bucket is public, so without it an
  // artist could point their row at someone else's object.
  if (!imagePath.startsWith(`${artist.id}/`)) {
    return { errors: { image: ["Choose an image to upload."] } };
  }

  const supabase = await createClient();

  const { data: uploaded } = await supabase.storage
    .from(ARTWORKS_BUCKET)
    .exists(imagePath);

  if (!uploaded) {
    return {
      errors: { image: ["The image upload did not finish. Try again."] },
    };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("artworks")
    .insert({
      artist_id: artist.id,
      title,
      description,
      tags,
      image_path: imagePath,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    // The file is already in the bucket. Without this the bucket would collect
    // orphans no row ever points at.
    await supabase.storage.from(ARTWORKS_BUCKET).remove([imagePath]);
    return {
      message: `Could not save the artwork: ${insertError?.message ?? "unknown error"}`,
    };
  }

  // The piece is saved with the artist's own tags before this runs. `after`
  // defers the model call until the response has been sent, so publishing is
  // never slower for it — the PRD guardrail says no step in the upload flow
  // blocks waiting on an AI response, and awaiting it here would be that step.
  //
  // Both /studio and /discover render dynamically, so the later tags show up
  // on the next request without an explicit revalidate.
  after(async () => {
    const toppedUp = await topUpTags(tags, imagePath);

    if (toppedUp.length > tags.length) {
      await supabase
        .from("artworks")
        .update({ tags: toppedUp })
        .eq("id", inserted.id)
        .eq("artist_id", artist.id);
    }
  });

  revalidatePath("/studio");
  revalidatePath("/discover");
  redirect("/studio");
}

export async function updateArtwork(
  _state: ArtworkFormState,
  formData: FormData,
): Promise<ArtworkFormState> {
  const artist = await requireArtist();
  const artworkId = asString(formData.get("artworkId"));

  if (!z.uuid().safeParse(artworkId).success) {
    return { message: "Unknown artwork." };
  }

  const validatedFields = UpdateArtworkSchema.safeParse({
    title: asString(formData.get("title")),
    description: asString(formData.get("description")),
    tags: asString(formData.get("tags")),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const supabase = await createClient();

  // The artist_id filter is belt-and-braces — RLS already scopes the update to
  // rows this artist owns.
  const { error } = await supabase
    .from("artworks")
    .update(validatedFields.data)
    .eq("id", artworkId)
    .eq("artist_id", artist.id);

  if (error) {
    return { message: `Could not save your changes: ${error.message}` };
  }

  revalidatePath("/studio");
  revalidatePath(`/artwork/${artworkId}`);
  redirect("/studio");
}

export async function deleteArtwork(formData: FormData) {
  const artist = await requireArtist();
  const artworkId = asString(formData.get("artworkId"));

  if (!z.uuid().safeParse(artworkId).success) {
    return;
  }

  const supabase = await createClient();

  // Read the key before the row is gone, or the file becomes unreachable.
  const { data: artwork } = await supabase
    .from("artworks")
    .select("image_path")
    .eq("id", artworkId)
    .eq("artist_id", artist.id)
    .maybeSingle();

  if (!artwork) {
    return;
  }

  const { error } = await supabase
    .from("artworks")
    .delete()
    .eq("id", artworkId)
    .eq("artist_id", artist.id);

  if (error) {
    throw new Error(`Could not delete the artwork: ${error.message}`);
  }

  await supabase.storage.from(ARTWORKS_BUCKET).remove([artwork.image_path]);

  revalidatePath("/studio");
  revalidatePath("/discover");
}
