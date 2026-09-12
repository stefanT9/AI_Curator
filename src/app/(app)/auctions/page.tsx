import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import {
  AUCTIONS_PAGE_SIZE,
  CLOSED_AUCTIONS_WINDOW_DAYS,
  getMyClosedAuctions,
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

  // Until S-04 tells a winner anything, this is the only way to find a closed
  // auction without its URL. A bounded recent window, not a history — which is
  // why it is not paginated.
  const closedAuctions = await getMyClosedAuctions(user.id);

  // One query for both grids' badges, never one per card — the shape the studio
  // uses for its live-auction badge. Ids only: the badge says *that* you bid,
  // never how much, and that holds after the close too.
  const bidAuctionIds = await getOwnBidAuctionIds([
    ...auctions.map((auction) => auction.id),
    ...closedAuctions.map((auction) => auction.id),
  ]);

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

      {closedAuctions.length === 0 ? null : (
        <section className="mt-12">
          <h2 className="mb-1 text-lg font-semibold tracking-tight">
            Recently closed
          </h2>
          <p className="mb-6 text-sm opacity-70">
            Auctions you sold or bid on in the last{" "}
            {CLOSED_AUCTIONS_WINDOW_DAYS} days. Open one to see how it went.
          </p>
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {closedAuctions.map((auction) => (
              <li key={auction.id}>
                <AuctionCard
                  auction={auction}
                  isOwn={auction.seller_id === user.id}
                  hasBid={bidAuctionIds.has(auction.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
