/**
 * Storage keys are what we persist; URLs are derived at render time. Kept free
 * of "server-only" because the swipe deck renders cards on the client too.
 *
 * This is the same string `supabase.storage.from(...).getPublicUrl()` builds,
 * without needing a client instance in a component that has no other use for
 * one.
 */

export const ARTWORKS_BUCKET = "artworks";

export const publicImageUrl = (imagePath: string) =>
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${ARTWORKS_BUCKET}/${imagePath}`;
