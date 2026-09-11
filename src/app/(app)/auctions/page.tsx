import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { getOpenAuctions } from "@/lib/auctions/queries";
import { AuctionCard } from "@/components/auctions/AuctionCard";

export const metadata: Metadata = {
  title: "Auctions",
};

export const dynamic = "force-dynamic";

export default async function AuctionsPage() {
  const user = await requireUser();
  const auctions = await getOpenAuctions();

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Auctions</h1>
      <p className="mb-6 text-sm opacity-70">
        {auctions.length === 0
          ? "No open auctions right now."
          : `${auctions.length} open ${auctions.length === 1 ? "auction" : "auctions"}.`}
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
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
