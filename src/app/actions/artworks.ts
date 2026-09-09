"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireArtist } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";
import { ARTWORKS_BUCKET } from "@/lib/artworks/images";
import { MAX_TAGS, MAX_TAG_LENGTH } from "@/lib/artworks/tags";

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

/** Mirrors the bucket's own limits, so a rejection happens before the upload. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

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

const ImageSchema = z
  .instanceof(File, { error: "Choose an image to upload." })
  .refine((file) => file.size > 0, { error: "Choose an image to upload." })
  .refine((file) => file.size <= MAX_IMAGE_BYTES, {
    error: "Image must be 10 MB or smaller.",
  })
  .refine((file) => ALLOWED_MIME_TYPES.includes(file.type), {
    error: "Image must be a PNG, JPEG or WebP.",
  });

const CreateArtworkSchema = z.object({
  title: TitleSchema,
  description: DescriptionSchema,
  tags: TagsSchema,
  image: ImageSchema,
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
    image: formData.get("image"),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const { title, description, tags, image } = validatedFields.data;
  const supabase = await createClient();

  // Folder-per-artist is what the storage policy keys off; the random filename
  // keeps two uploads of the same photo from colliding.
  const imagePath = `${artist.id}/${crypto.randomUUID()}.${EXTENSIONS[image.type]}`;

  const { error: uploadError } = await supabase.storage
    .from(ARTWORKS_BUCKET)
    .upload(imagePath, image, { contentType: image.type, upsert: false });

  if (uploadError) {
    return { message: `Could not upload the image: ${uploadError.message}` };
  }

  const { error: insertError } = await supabase.from("artworks").insert({
    artist_id: artist.id,
    title,
    description,
    tags,
    image_path: imagePath,
  });

  if (insertError) {
    // The file is already in the bucket. Without this the bucket would collect
    // orphans no row ever points at.
    await supabase.storage.from(ARTWORKS_BUCKET).remove([imagePath]);
    return { message: `Could not save the artwork: ${insertError.message}` };
  }

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
