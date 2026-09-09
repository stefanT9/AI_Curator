/**
 * Browser-side artwork upload.
 *
 * The image goes straight from the browser to Supabase Storage and only its
 * object key travels through the Server Action. That is not an optimisation:
 * Next.js caps Server Action request bodies at 1 MB, while the bucket accepts
 * 10 MiB, so routing the bytes through the action made every real photograph
 * fail with a 413 before validation could produce a friendly error.
 *
 * No signed upload URL is needed. The RLS policy "Artists can upload into
 * their own folder" already scopes an authenticated artist's writes to
 * `${uid}/`, so the browser session is the authorisation.
 *
 * Deliberately free of "server-only" — and equally, never import this from a
 * server module.
 */

import { createClient } from "@/utils/supabase/client";
import {
  ALLOWED_MIME_TYPES,
  ARTWORKS_BUCKET,
  EXTENSIONS,
  MAX_IMAGE_BYTES,
} from "./images";

/** Thrown for anything the artist can fix by choosing a different file. */
export class ArtworkUploadError extends Error {}

/**
 * Put the file in the artist's own folder and return the object key.
 *
 * Size and type are checked before the network call so an oversized file costs
 * nothing. The bucket enforces both again — this is a courtesy, not the gate.
 */
export const uploadArtworkImage = async (file: File): Promise<string> => {
  if (file.size === 0) {
    throw new ArtworkUploadError("Choose an image to upload.");
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new ArtworkUploadError("Image must be 10 MB or smaller.");
  }

  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    throw new ArtworkUploadError("Image must be a PNG, JPEG or WebP.");
  }

  const supabase = createClient();
  const { data, error: userError } = await supabase.auth.getUser();

  if (userError || !data.user) {
    throw new ArtworkUploadError(
      "Your session expired. Sign in and try again.",
    );
  }

  // Folder-per-artist is what the storage policy keys off; the random filename
  // keeps two uploads of the same photo from colliding.
  const imagePath = `${data.user.id}/${crypto.randomUUID()}.${EXTENSIONS[file.type]}`;

  const { error } = await supabase.storage
    .from(ARTWORKS_BUCKET)
    .upload(imagePath, file, { contentType: file.type, upsert: false });

  if (error) {
    throw new ArtworkUploadError(
      `Could not upload the image: ${error.message}`,
    );
  }

  return imagePath;
};

/**
 * Delete an object whose artwork row never landed.
 *
 * Best-effort: a failure here leaves an orphan in the bucket, which is not
 * worth surfacing to an artist who is already looking at a validation error.
 */
export const removeArtworkImage = async (imagePath: string): Promise<void> => {
  const supabase = createClient();
  await supabase.storage.from(ARTWORKS_BUCKET).remove([imagePath]);
};
