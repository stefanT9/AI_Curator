import "server-only";

import { cache } from "react";

import { createClient } from "@/utils/supabase/server";
import type {
  ArtistSummary,
  Artwork,
  Auction,
  AuctionWithArtwork,
  Bid,
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

export const AUCTIONS_PAGE_SIZE = 24;

/**
 * A bounded page of open auctions, for the `/auctions` browse grid.
 *
 * `getOpenAuctions` above loads every open auction in one query and feeds
 * every one of their artwork ids into `attachArtworks`'s `in()` filter — the
 * same shape that built a "URI too long" failure for the Studio grid once its
 * artist had 1000 artworks (see `getArtistArtworksPage` in
 * `src/lib/artworks/queries.ts`). Auction volume is low today, but nothing
 * bounds it as it grows, so the browse page paginates from the start rather
 * than waiting to hit the same wall.
 */
export const getOpenAuctionsPage = async ({
  limit = AUCTIONS_PAGE_SIZE,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{
  auctions: AuctionWithArtwork[];
  total: number;
}> => {
  const supabase = await createClient();
  const { data, error, count } = await supabase
    .from("auctions")
    .select("*", { count: "exact" })
    .is("cancelled_at", null)
    .gt("ends_at", new Date().toISOString())
    .order("ends_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to load auctions: ${error.message}`);
  }

  return { auctions: await attachArtworks(data ?? []), total: count ?? 0 };
};

/**
 * One auction by id, for the detail page. Cached: the page reads it in both
 * `generateMetadata` and the body, as `getArtwork` in
 * `src/lib/artworks/queries.ts` does.
 *
 * Deliberately *without* the openness predicate its neighbours above apply. An
 * ended or cancelled auction still renders -- it just is not biddable, which is
 * `canBid`'s question, not this one's.
 */
export const getAuction = cache(
  async (id: string): Promise<AuctionWithArtwork | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("auctions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (!data) {
      return null;
    }

    const [withArtwork] = await attachArtworks([data]);
    return withArtwork ?? null;
  },
);

/**
 * The caller's own bid on one auction, or null. Cached for the same reason
 * `getAuction` is.
 *
 * There is no `bidder_id` filter here and that is not an oversight: the select
 * policy on `bids` (`bidder_id = auth.uid()`) is the only thing that scopes
 * this read, and per AGENTS.md an ownership filter in a query would be for
 * correctness, never access control. `maybeSingle` is safe because
 * `bids_one_per_bidder` makes at most one row visible to any caller.
 */
export const getOwnBid = cache(
  async (auctionId: string): Promise<Bid | null> => {
    const supabase = await createClient();
    const { data } = await supabase
      .from("bids")
      .select("*")
      .eq("auction_id", auctionId)
      .maybeSingle();

    return data ?? null;
  },
);

/**
 * Which of a page's auctions the caller has bid on, for the browse grid's
 * badge -- one query for the whole page, never one per card, the same shape
 * `getLiveAuctionsByArtwork` uses for the studio.
 *
 * Returns ids only. No amount is selected, because no surface may show one:
 * the badge says *that* you bid, never how much.
 */
export const getOwnBidAuctionIds = async (
  auctionIds: string[],
): Promise<Set<string>> => {
  if (auctionIds.length === 0) {
    return new Set();
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bids")
    .select("auction_id")
    .in("auction_id", auctionIds);

  if (error) {
    throw new Error(`Failed to load your bids: ${error.message}`);
  }

  return new Set((data ?? []).map((bid) => bid.auction_id));
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
