import "server-only";

import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import type { Artwork, ArtistSummary, ArtworkWithArtist } from "@/types/domain";

/**
 * Reads for both flows. Every one of these runs under RLS as the signed-in
 * user, so an ownership filter here is a nicety for the query planner, not the
 * security boundary.
 */

/**
 * Resolve attribution for a batch of artworks in one extra query.
 *
 * Deliberately not a PostgREST embed: `email` is withheld from `profiles` at
 * the column-grant level, so the columns an embed may select are constrained in
 * a way that is easier to state explicitly than to infer. One round trip for
 * the whole page either way — never per row.
 */
const attachArtists = async (
  artworks: Artwork[],
): Promise<ArtworkWithArtist[]> => {
  if (artworks.length === 0) {
    return [];
  }

  const artistIds = Array.from(new Set(artworks.map((a) => a.artist_id)));
  const supabase = await createClient();

  const { data } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", artistIds);

  const byId = new Map<string, ArtistSummary>(
    (data ?? []).map((row) => [
      row.id,
      { id: row.id, displayName: row.display_name },
    ]),
  );

  return artworks.map((artwork) => ({
    ...artwork,
    artist: byId.get(artwork.artist_id) ?? null,
  }));
};

/**
 * The collector's deck: unrated artworks by other artists, newest first.
 * The anti-join lives in a SQL function because PostgREST cannot express it.
 */
export const getSwipeDeck = async (limit = 20): Promise<ArtworkWithArtist[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("swipe_deck", { p_limit: limit });

  if (error) {
    throw new Error(`Failed to load the deck: ${error.message}`);
  }

  return attachArtists(data ?? []);
};

/** Cached: the detail page reads it in both `generateMetadata` and the page. */
export const getArtwork = cache(
  async (id: string): Promise<ArtworkWithArtist | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("artworks")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!data) {
      return null;
    }

    const [withArtist] = await attachArtists([data]);
    return withArtist;
  },
);

/** Everything the signed-in user has liked, most recently liked first. */
export const getLikedArtworks = async (): Promise<ArtworkWithArtist[]> => {
  const supabase = await createClient();

  const { data: likes, error: likesError } = await supabase
    .from("interactions")
    .select("artwork_id")
    .eq("action", "like")
    .order("created_at", { ascending: false });

  if (likesError) {
    throw new Error(`Failed to load likes: ${likesError.message}`);
  }

  const ids = likes?.map((like) => like.artwork_id) ?? [];

  if (ids.length === 0) {
    return [];
  }

  const { data: artworks, error: artworksError } = await supabase
    .from("artworks")
    .select("*")
    .in("id", ids);

  if (artworksError) {
    throw new Error(`Failed to load liked artworks: ${artworksError.message}`);
  }

  // `in` returns rows in the table's order, not the order of the ids we asked
  // for — restore the most-recently-liked-first ordering.
  const rank = new Map(ids.map((id, index) => [id, index]));

  return attachArtists(
    (artworks ?? []).sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    ),
  );
};

/**
 * One artist's catalog. Works for any artist id, not just your own — artworks
 * are readable by every signed-in user, which is what makes the public artist
 * page possible.
 */
export const getArtistArtworks = async (
  artistId: string,
): Promise<Artwork[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("artworks")
    .select("*")
    .eq("artist_id", artistId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load artworks: ${error.message}`);
  }

  return data ?? [];
};

/**
 * A public artist profile. Returns null for a collector as well as for an id
 * that does not exist — the RLS policy only exposes rows whose role is
 * 'artist', so the two cases are indistinguishable here by design.
 */
export const getArtistProfile = cache(
  async (id: string): Promise<ArtistSummary | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("profiles")
      .select("id, display_name, role")
      .eq("id", id)
      .eq("role", "artist")
      .maybeSingle();

    return data ? { id: data.id, displayName: data.display_name } : null;
  },
);
