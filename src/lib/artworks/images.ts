/**
 * Storage keys are what we persist; URLs are derived at render time. Kept free
 * of "server-only" because the swipe deck renders cards on the client too —
 * and because the browser uploader below needs these same limits.
 *
 * `publicImageUrl` builds the same string
 * `supabase.storage.from(...).getPublicUrl()` does, without needing a client
 * instance in a component that has no other use for one.
 */

export const ARTWORKS_BUCKET = "artworks";

export const publicImageUrl = (imagePath: string) =>
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${ARTWORKS_BUCKET}/${imagePath}`;

/**
 * Mirrors the bucket's own `file_size_limit`, so a rejection happens in the
 * browser rather than as a failed upload.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * The object-key shape the storage policy keys off: a folder named after the
 * uploading artist, then a random filename. The action re-checks the folder
 * against the authenticated artist — this pattern only proves the shape, never
 * the ownership.
 */
export const IMAGE_PATH_PATTERN =
  /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
