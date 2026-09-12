"use client";

import { useActionState } from "react";
import { placeBid } from "@/app/actions/auctions";
import { Field, submitButtonClass } from "@/components/ui/Field";
import { formatCents } from "@/lib/auctions/price";

type BidFormProps = {
  auctionId: string;
  startingPriceCents: number;
  /** The caller's own standing bid, or null if they have not bid yet. */
  currentBidCents: number | null;
};

/**
 * The one place in the product where a bid amount is rendered — and it is the
 * viewer's own, read through a select policy scoped to `bidder_id`. Nothing
 * here knows anyone else's amount, the number of bidders, or who they are, and
 * nothing may be added that does (§Guardrails "sealed means sealed").
 *
 * A client component because `useActionState` drives `placeBid`. The floor it
 * hints at is a hint only: `place_bid` re-checks it under a row lock, and that
 * check — not this one — is what refuses a bid.
 */
export function BidForm({
  auctionId,
  startingPriceCents,
  currentBidCents,
}: BidFormProps) {
  const [state, action, pending] = useActionState(placeBid, undefined);
  const raising = currentBidCents !== null;

  return (
    <div className="flex flex-col gap-4">
      {raising ? (
        <div className="rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
          <p className="text-sm font-medium">
            Your bid: {formatCents(currentBidCents)}
          </p>
          <p className="text-xs opacity-60">
            Sealed — only you can see this. The seller cannot see it either.
          </p>
        </div>
      ) : null}

      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="auctionId" value={auctionId} />

        <Field
          name="amount"
          label={raising ? "Raise your bid" : "Your bid"}
          placeholder="150.00"
          hint={
            raising
              ? `US dollars. More than your current ${formatCents(currentBidCents)}.`
              : `US dollars. At least the ${formatCents(startingPriceCents)} starting price.`
          }
          errors={state?.errors?.amount}
        />

        {state?.message ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.message}
          </p>
        ) : null}

        <button type="submit" disabled={pending} className={submitButtonClass}>
          {pending
            ? raising
              ? "Raising…"
              : "Placing…"
            : raising
              ? "Raise bid"
              : "Place bid"}
        </button>
      </form>
    </div>
  );
}
