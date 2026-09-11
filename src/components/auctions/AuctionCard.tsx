import { ArtCard } from "@/components/artworks/ArtCard";
import { AuctionCountdown } from "@/components/auctions/AuctionCountdown";
import { CancelAuctionButton } from "@/components/auctions/CancelAuctionButton";
import { formatCents } from "@/lib/auctions/price";
import type { AuctionWithArtwork } from "@/types/domain";

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * The one way an auction is drawn — the role `ArtCard` plays for artworks.
 *
 * No bid control, no bid count, no bidder name anywhere in this component —
 * §Guardrails "sealed means sealed". This is the file S-02 will be tempted to
 * add them to; don't.
 */
export function AuctionCard({
  auction,
  isOwn,
}: {
  auction: AuctionWithArtwork;
  isOwn: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <ArtCard
        artwork={auction.artwork}
        sizes="(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
      />
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-sm font-medium">
          {formatCents(auction.starting_price_cents)}
        </span>
        <AuctionCountdown
          endsAt={auction.ends_at}
          absolute={absoluteFormatter.format(new Date(auction.ends_at))}
        />
      </div>
      {isOwn ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs opacity-60">Your listing</span>
          <CancelAuctionButton auctionId={auction.id} />
        </div>
      ) : null}
    </div>
  );
}
