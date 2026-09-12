import Link from "next/link";
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
 * S-02 narrowed this component's standing rule rather than lifting it: the card
 * may say that *you* have bid, and nothing more. No amount, no bid count, no
 * other bidder's identity — to anyone, the seller included (§Guardrails "sealed
 * means sealed"). `hasBid` is a boolean for exactly that reason; do not give it
 * a number.
 *
 * S-03 held the same line for closed auctions: a closed card says only
 * "Closed". No winning amount, and no "You won" badge — whether you won is the
 * detail page's answer, because that is the only surface that knows who is
 * asking. Do not add an outcome here.
 */
export function AuctionCard({
  auction,
  isOwn,
  hasBid,
}: {
  auction: AuctionWithArtwork;
  isOwn: boolean;
  hasBid?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/*
        The whole card is the link through to the detail page, so `ArtCard`'s
        own artist link is turned off — nested anchors are invalid HTML.
      */}
      <Link href={`/auctions/${auction.id}`} className="block">
        <ArtCard
          artwork={auction.artwork}
          sizes="(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
          linkArtist={false}
        />
      </Link>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-sm font-medium">
          {formatCents(auction.starting_price_cents)}
        </span>
        {auction.closed_at === null ? (
          <AuctionCountdown
            endsAt={auction.ends_at}
            absolute={absoluteFormatter.format(new Date(auction.ends_at))}
          />
        ) : (
          <span className="text-sm opacity-70">Closed</span>
        )}
      </div>
      {hasBid ? (
        <div className="px-1">
          <span className="rounded-full border border-black/10 px-2 py-0.5 text-xs opacity-70 dark:border-white/15">
            You&rsquo;ve bid
          </span>
        </div>
      ) : null}
      {isOwn ? (
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-xs opacity-60">Your listing</span>
          {/*
            `cancel_auction` refuses a closed auction, so offering the control
            there could only produce a failure the seller cannot act on.
          */}
          {auction.closed_at === null ? (
            <CancelAuctionButton auctionId={auction.id} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
