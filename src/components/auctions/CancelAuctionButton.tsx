"use client";

import { cancelAuction } from "@/app/actions/auctions";

/**
 * Client-side only for the confirm prompt — the cancellation itself is the
 * server action, which re-checks that the caller is the seller.
 */
export function CancelAuctionButton({ auctionId }: { auctionId: string }) {
  return (
    <form
      action={cancelAuction}
      onSubmit={(event) => {
        if (!confirm("Cancel this auction? This cannot be undone.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="auctionId" value={auctionId} />
      <button
        type="submit"
        className="text-xs text-red-600 underline underline-offset-2 hover:opacity-80 dark:text-red-400"
      >
        Cancel
      </button>
    </form>
  );
}
