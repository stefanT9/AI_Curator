import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { getAuction, getOwnBid } from "@/lib/auctions/queries";
import { formatCents } from "@/lib/auctions/price";
import { canBid, isOpen } from "@/lib/auctions/status";
import { ArtCard } from "@/components/artworks/ArtCard";
import { AuctionCountdown } from "@/components/auctions/AuctionCountdown";
import { BidForm } from "@/components/auctions/BidForm";
import { CancelAuctionButton } from "@/components/auctions/CancelAuctionButton";

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const dynamic = "force-dynamic";

// `getAuction` is React-cached, so this and the page below share one query.
export async function generateMetadata({
  params,
}: PageProps<"/auctions/[id]">): Promise<Metadata> {
  const { id } = await params;
  const auction = await getAuction(id);

  return { title: auction?.artwork.title ?? "Auction" };
}

export default async function AuctionDetailPage({
  params,
}: PageProps<"/auctions/[id]">) {
  const user = await requireUser();

  const { id } = await params;
  const auction = await getAuction(id);

  // RLS returns nothing rather than erroring when a row is out of reach, so a
  // missing auction and a forbidden one are the same 404 — which tells an
  // attacker nothing, the same reasoning `/artwork/[id]` states.
  if (!auction) {
    notFound();
  }

  const now = new Date();
  const viewerIsSeller = auction.seller_id === user.id;
  const biddable = canBid(auction, user.id, now);

  // Read only when a bid form is actually rendered. The select policy would
  // hand the seller zero rows anyway, but not asking is clearer than relying
  // on being refused.
  const ownBid = biddable ? await getOwnBid(auction.id) : null;

  return (
    <div className="mx-auto w-full max-w-md">
      <Link
        href="/auctions"
        className="mb-4 inline-block text-sm underline opacity-70"
      >
        ← Back to auctions
      </Link>

      <ArtCard artwork={auction.artwork} priority showDescription />

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          <p className="text-lg font-medium">
            {formatCents(auction.starting_price_cents)}
          </p>
          <p className="text-xs opacity-60">Starting price</p>
        </div>
        <AuctionCountdown
          endsAt={auction.ends_at}
          absolute={absoluteFormatter.format(new Date(auction.ends_at))}
        />
      </div>

      <div className="mt-6">
        {/*
          Three mutually exclusive controls, in the order that makes each one
          honest: a closed auction takes no action from anyone, a seller may
          cancel but never bid, and everyone else bids. No branch shows a bid
          that is not the viewer's own.
        */}
        {!isOpen(auction, now) ? (
          <p className="text-sm opacity-70">
            {auction.cancelled_at === null
              ? "This auction has ended."
              : "This auction was cancelled."}
          </p>
        ) : viewerIsSeller ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm opacity-70">Your listing</span>
            <CancelAuctionButton auctionId={auction.id} />
          </div>
        ) : (
          <BidForm
            auctionId={auction.id}
            startingPriceCents={auction.starting_price_cents}
            currentBidCents={ownBid?.amount_cents ?? null}
          />
        )}
      </div>
    </div>
  );
}
