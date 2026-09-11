import "server-only";

import { cache } from "react";
import { createClient } from "@/utils/supabase/server";
import { requireUser } from "@/lib/auth/dal";
import { ONBOARDING_POOL_SIZE } from "@/lib/onboarding/config";
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
export const getSwipeDeck = async (
  limit = 20,
): Promise<ArtworkWithArtist[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("swipe_deck", { p_limit: limit });

  if (error) {
    throw new Error(`Failed to load the deck: ${error.message}`);
  }

  return attachArtists(data ?? []);
};

/**
 * The onboarding pool: artworks matching any of the style terms the collector
 * just picked, by other artists, that they have not already rated.
 *
 * Expressed in PostgREST rather than a SQL function because — unlike
 * `swipe_deck` — the anti-join it needs is against a set small enough to read
 * first: RLS on `interactions` already scopes the select to this user's own
 * rows, so one round trip gets every id to exclude.
 *
 * `overlaps` compiles to the `&&` array operator, which uses
 * `artworks_tags_idx` — the same GIN index the ranking function relies on.
 *
 * Returning fewer than `ONBOARDING_POOL_SIZE` rows — including none at all —
 * is a valid result, not an error. A collector whose terms match nothing must
 * still be able to finish the flow.
 */
export const getStarterDeck = async (
  terms: string[],
): Promise<ArtworkWithArtist[]> => {
  if (terms.length === 0) {
    return [];
  }

  const user = await requireUser();
  const supabase = await createClient();

  const { data: rated, error: ratedError } = await supabase
    .from("interactions")
    .select("artwork_id");

  if (ratedError) {
    throw new Error(`Failed to load your ratings: ${ratedError.message}`);
  }

  let query = supabase
    .from("artworks")
    .select("*")
    .overlaps("tags", terms)
    // Same exclusion `swipe_deck` makes: nobody rates their own work.
    .neq("artist_id", user.id)
    .order("created_at", { ascending: false })
    .limit(ONBOARDING_POOL_SIZE);

  const ratedIds = (rated ?? []).map((row) => row.artwork_id);

  if (ratedIds.length > 0) {
    // Quoted: PostgREST's `in` list is parsed as CSV, so an unquoted value
    // would be at the mercy of whatever punctuation it contains.
    query = query.not("id", "in", `("${ratedIds.join('","')}")`);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load starter artworks: ${error.message}`);
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

export const STUDIO_PAGE_SIZE = 24;

/**
 * A bounded page of one artist's catalog, for the Studio grid.
 *
 * `getArtistArtworks` above loads everything in one query, which is unsafe to
 * feed straight into `getLiveAuctionsByArtwork`: the local seed corpus gives
 * its demo artist 1000 artworks, and passing every id into a PostgREST `in`
 * filter built a GET request whose query string was too long for the client
 * to send at all ("URI too long"), before RLS or the database ever saw it.
 * Paginating the Studio grid bounds that list to `STUDIO_PAGE_SIZE` ids
 * regardless of catalog size, which is what keeps that lookup safe.
 */
export const getArtistArtworksPage = async (
  artistId: string,
  {
    limit = STUDIO_PAGE_SIZE,
    offset = 0,
  }: { limit?: number; offset?: number } = {},
): Promise<{ artworks: Artwork[]; total: number }> => {
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("artworks")
    .select("*", { count: "exact" })
    .eq("artist_id", artistId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to load artworks: ${error.message}`);
  }

  return { artworks: data ?? [], total: count ?? 0 };
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
