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
import type { Bid } from "@/types/domain";

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export const dynamic = "force-dynamic";

/**
 * What a closed auction tells the person looking at it — everything §Guardrails
 * permits them, and nothing beyond it.
 *
 * The winning amount reaches exactly two people: the seller, who cannot read
 * `bids` at all and for whom `winning_amount_cents` is the published result,
 * and the winner, who is shown the amount off *their own* bid row. A losing
 * bidder learns only that they lost; anyone else learns only that it ended. No
 * branch here reads a bid that is not the viewer's own, and none of them can
 * disclose a bid count.
 */
function closedOutcome({
  viewerIsSeller,
  winningBidId,
  winningAmountCents,
  ownBid,
}: {
  viewerIsSeller: boolean;
  winningBidId: string | null;
  winningAmountCents: number | null;
  ownBid: Bid | null;
}): string {
  if (viewerIsSeller) {
    return winningAmountCents === null
      ? "This auction ended with no bids. You're free to list it again."
      : `Sold for ${formatCents(winningAmountCents)}.`;
  }

  // Identity, not amount: the winner is recognised by their own bid id, and
  // the figure comes from the bid row they already own. `winning_bid_id` is
  // `on delete set null`, so a deleted bid can only ever under-claim here.
  if (ownBid !== null && ownBid.id === winningBidId) {
    return `You won this auction at ${formatCents(ownBid.amount_cents)}.`;
  }

  if (ownBid !== null) {
    return "This auction has ended. You did not win.";
  }

  return "This auction has ended.";
}

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

  // Read for everyone but the seller, open or closed: it seeds the bid form
  // while the auction runs, and afterwards it is what tells a collector
  // whether they won. The select policy would hand the seller zero rows
  // anyway, but not asking is clearer than relying on being refused.
  const ownBid = viewerIsSeller ? null : await getOwnBid(auction.id);

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
          Three mutually exclusive controls: everyone who may bid bids, a
          seller of a still-open auction may cancel but never bid, and anything
          else is no longer open and reports its outcome instead of offering an
          action. `canBid` is the only place the first question is asked. No
          branch shows a bid that is not the viewer's own.

          Within the terminal branch, cancelled is tested before closed because
          the two states are disjoint by construction -- `close_due_auctions`
          skips cancelled auctions and `cancel_auction` refuses closed ones --
          so the order states which one wins if that ever stops being true.
        */}
        {biddable ? (
          <BidForm
            auctionId={auction.id}
            startingPriceCents={auction.starting_price_cents}
            currentBidCents={ownBid?.amount_cents ?? null}
          />
        ) : viewerIsSeller && isOpen(auction, now) ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm opacity-70">Your listing</span>
            <CancelAuctionButton auctionId={auction.id} />
          </div>
        ) : (
          <p className="text-sm opacity-70">
            {auction.cancelled_at !== null
              ? "This auction was cancelled."
              : auction.closed_at !== null
                ? closedOutcome({
                    viewerIsSeller,
                    winningBidId: auction.winning_bid_id,
                    winningAmountCents: auction.winning_amount_cents,
                    ownBid,
                  })
                : // Past `ends_at` but the per-minute sweep has not reached it
                  // yet. No outcome exists to show, so say only what is true.
                  "This auction has ended."}
          </p>
        )}
      </div>
    </div>
  );
}
