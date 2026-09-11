import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireArtist } from "@/lib/auth/dal";
import { getArtwork } from "@/lib/artworks/queries";
import { getLiveAuctionsByArtwork } from "@/lib/auctions/queries";
import { ArtCard } from "@/components/artworks/ArtCard";
import { AuctionForm } from "@/components/auctions/AuctionForm";

export const metadata: Metadata = {
  title: "List for auction",
};

export const dynamic = "force-dynamic";

export default async function ListAuctionPage({
  params,
}: PageProps<"/studio/[id]/auction">) {
  const artist = await requireArtist();

  const { id } = await params;
  const artwork = await getArtwork(id);

  // Artworks are readable by every signed-in user, so ownership has to be
  // checked here — RLS only stops the *write* from landing.
  if (!artwork || artwork.artist_id !== artist.id) {
    notFound();
  }

  // Same refusal `create_auction` would give (AUC04), surfaced before the
  // artist fills in a form that cannot succeed.
  const liveAuctions = await getLiveAuctionsByArtwork([artwork.id]);

  if (liveAuctions.has(artwork.id)) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        List for auction
      </h1>
      <p className="mb-6 text-sm opacity-70">
        Set a starting price and a duration. Once listed, the piece cannot be
        edited — only cancelled.
      </p>

      <div className="mb-6 max-w-xs">
        <ArtCard artwork={artwork} />
      </div>

      <AuctionForm artwork={artwork} />
    </div>
  );
}
