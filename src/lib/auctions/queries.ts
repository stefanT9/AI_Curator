import "server-only";

import { createClient } from "@/utils/supabase/server";
import type {
  ArtistSummary,
  Artwork,
  Auction,
  AuctionWithArtwork,
} from "@/types/domain";

/**
 * Resolve artwork and artist attribution for a batch of auctions in two extra
 * queries, never per row — the same reasoning `attachArtists` in
 * `src/lib/artworks/queries.ts` states: `email` is withheld from `profiles`
 * at the column-grant level, so a PostgREST embed cannot express this shape
 * as cleanly as explicit selects.
 */
const attachArtworks = async (
  auctions: Auction[],
): Promise<AuctionWithArtwork[]> => {
  if (auctions.length === 0) {
    return [];
  }

  const supabase = await createClient();
  const artworkIds = Array.from(new Set(auctions.map((a) => a.artwork_id)));

  const { data: artworks, error: artworksError } = await supabase
    .from("artworks")
    .select("*")
    .in("id", artworkIds);

  if (artworksError) {
    throw new Error(
      `Failed to load auction artworks: ${artworksError.message}`,
    );
  }

  const artistIds = Array.from(
    new Set((artworks ?? []).map((artwork) => artwork.artist_id)),
  );

  const { data: artists } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", artistIds);

  const artistById = new Map<string, ArtistSummary>(
    (artists ?? []).map((row) => [
      row.id,
      { id: row.id, displayName: row.display_name },
    ]),
  );

  const artworkById = new Map<string, Artwork>(
    (artworks ?? []).map((artwork) => [artwork.id, artwork]),
  );

  return auctions.flatMap((auction) => {
    const artwork = artworkById.get(auction.artwork_id);

    // Cannot happen under the FK's `on delete cascade`, but a row that has
    // lost its artwork between the two selects is not renderable — drop it
    // rather than crash the browse page.
    if (!artwork) {
      return [];
    }

    return [
      {
        ...auction,
        artwork: {
          ...artwork,
          artist: artistById.get(artwork.artist_id) ?? null,
        },
      },
    ];
  });
};

/**
 * FR-006's browse surface: every open auction, closing-soonest first.
 *
 * The `is` / `gt` pair here is the SQL mirror of `isOpen` in
 * `src/lib/auctions/status.ts` (`cancelled_at is null and ends_at > now()`) —
 * change them together.
 */
export const getOpenAuctions = async (): Promise<AuctionWithArtwork[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("auctions")
    .select("*")
    .is("cancelled_at", null)
    .gt("ends_at", new Date().toISOString())
    .order("ends_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to load auctions: ${error.message}`);
  }

  return attachArtworks(data ?? []);
};

/**
 * One query for a whole studio page's worth of artworks, never per row. Only
 * live auctions matter to the studio badge, so the same openness predicate
 * applies as `getOpenAuctions`.
 */
export const getLiveAuctionsByArtwork = async (
  artworkIds: string[],
): Promise<Map<string, Auction>> => {
  if (artworkIds.length === 0) {
    return new Map();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("auctions")
    .select("*")
    .in("artwork_id", artworkIds)
    .is("cancelled_at", null)
    .gt("ends_at", new Date().toISOString());

  if (error) {
    throw new Error(`Failed to load live auctions: ${error.message}`);
  }

  return new Map((data ?? []).map((auction) => [auction.artwork_id, auction]));
};
