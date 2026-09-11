"use client";

import { useActionState, useEffect, useState } from "react";
import { createAuction } from "@/app/actions/auctions";
import { Field, submitButtonClass } from "@/components/ui/Field";
import { AUCTION_DURATIONS } from "@/lib/auctions/config";
import type { Artwork } from "@/types/domain";

const endTimeFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/**
 * A client component because `useActionState` drives `createAuction` and the
 * resolved end time updates as the artist picks a duration -- the actual end
 * time is set by `create_auction` from its own `now()`, so this is a preview,
 * not a promise.
 */
export function AuctionForm({ artwork }: { artwork: Artwork }) {
  const [state, action, pending] = useActionState(createAuction, undefined);
  const [durationHours, setDurationHours] = useState<number>(
    AUCTION_DURATIONS[0].hours,
  );

  // `Date.now()` is impure, so it cannot run during render -- computed in an
  // effect instead, same reasoning as `AuctionCountdown` swapping in a ticking
  // value only after mount.
  const [endsAtLabel, setEndsAtLabel] = useState<string | null>(null);

  useEffect(() => {
    const computeLabel = () => {
      const endsAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);
      setEndsAtLabel(endTimeFormatter.format(endsAt));
    };

    computeLabel();
  }, [durationHours]);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="artworkId" value={artwork.id} />

      <Field
        name="startingPrice"
        label="Starting price"
        placeholder="150.00"
        hint="US dollars."
        errors={state?.errors?.startingPrice}
      />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Duration</legend>
        <div className="flex flex-col gap-2">
          {AUCTION_DURATIONS.map((duration) => (
            <label
              key={duration.hours}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="radio"
                name="duration"
                value={duration.hours}
                defaultChecked={duration.hours === durationHours}
                onChange={() => setDurationHours(duration.hours)}
              />
              {duration.label}
            </label>
          ))}
        </div>
        {state?.errors?.duration ? (
          <p className="text-xs text-red-600 dark:text-red-400">
            {state.errors.duration[0]}
          </p>
        ) : null}
      </fieldset>

      {endsAtLabel ? (
        <p className="text-xs opacity-60">Ends {endsAtLabel}.</p>
      ) : null}

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={submitButtonClass}>
        {pending ? "Listing…" : "List for auction"}
      </button>
    </form>
  );
}
