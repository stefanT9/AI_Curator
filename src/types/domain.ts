/**
 * Domain aliases over the generated database types.
 *
 * These live here rather than in `database.ts` because that file is overwritten
 * wholesale by `npm run db:types`.
 */

import type { Database } from "@/types/database";

export type UserRole = Database["public"]["Enums"]["user_role"];
export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Artwork = Database["public"]["Tables"]["artworks"]["Row"];

export type InteractionAction = "like" | "skip";

/**
 * The public face of an artist. Deliberately not `Profile`: artist profiles are
 * readable by every signed-in user, and `email` is withheld from that read at
 * the column-grant level. Modelling the narrow shape here keeps the app from
 * assuming it has an address it was never given.
 */
export type ArtistSummary = {
  id: string;
  displayName: string | null;
};

/** An artwork with its attribution resolved, which is how the UI wants it. */
export type ArtworkWithArtist = Artwork & {
  artist: ArtistSummary | null;
};

export const artistLabel = (artist: ArtistSummary | null | undefined) =>
  artist?.displayName ?? "Unnamed artist";
