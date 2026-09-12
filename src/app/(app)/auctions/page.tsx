import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import {
  AUCTIONS_PAGE_SIZE,
  getOpenAuctionsPage,
  getOwnBidAuctionIds,
} from "@/lib/auctions/queries";
import { parsePage } from "@/lib/pagination";
import { AuctionCard } from "@/components/auctions/AuctionCard";
import { Pagination } from "@/components/ui/Pagination";

export const metadata: Metadata = {
  title: "Auctions",
};

export const dynamic = "force-dynamic";

export default async function AuctionsPage({
  searchParams,
}: PageProps<"/auctions">) {
  const user = await requireUser();
  const { page: pageParam } = await searchParams;
  const page = parsePage(pageParam);

  const { auctions, total } = await getOpenAuctionsPage({
    offset: (page - 1) * AUCTIONS_PAGE_SIZE,
  });

  // One query for the whole page's badges, never one per card — the shape the
  // studio uses for its live-auction badge. Ids only: the badge says *that*
  // you bid, never how much.
  const bidAuctionIds = await getOwnBidAuctionIds(
    auctions.map((auction) => auction.id),
  );

  const totalPages = Math.max(1, Math.ceil(total / AUCTIONS_PAGE_SIZE));

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Auctions</h1>
      <p className="mb-6 text-sm opacity-70">
        {total === 0
          ? "No open auctions right now."
          : `${total} open ${total === 1 ? "auction" : "auctions"}.`}
      </p>

      {auctions.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 p-8 text-center dark:border-white/20">
          <p className="text-sm opacity-70">
            Nothing listed yet. Check back soon.
          </p>
        </div>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {auctions.map((auction) => (
            <li key={auction.id}>
              <AuctionCard
                auction={auction}
                isOwn={auction.seller_id === user.id}
                hasBid={bidAuctionIds.has(auction.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <Pagination page={page} totalPages={totalPages} basePath="/auctions" />
    </div>
  );
}
