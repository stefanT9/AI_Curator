"use client";

import { useActionState } from "react";
import {
  updateNotificationPreference,
  type NotificationPreferenceFormState,
} from "@/app/actions/profile";
import { secondaryButtonClass } from "@/components/ui/Field";

export function NotificationPreferenceForm({
  enabled,
}: {
  /** Server-read current value. A user with no preference row arrives `true`. */
  enabled: boolean;
}) {
  const [state, action, pending] = useActionState<
    NotificationPreferenceFormState,
    FormData
  >(updateNotificationPreference, undefined);

  // The action reports what it stored, so the button flips as soon as the
  // response lands rather than waiting for the revalidated page to stream in.
  const current = state?.enabled ?? enabled;
  const target = !current;

  return (
    <form action={action} className="flex flex-col gap-3">
      {/*
        The desired state travels explicitly rather than as a checkbox: an
        unchecked box sends nothing, and "no field" would have to be read as
        "off" — so a dropped or malformed body would silently opt someone out.
      */}
      <input type="hidden" name="auctionEmailsEnabled" value={String(target)} />

      <p className="text-sm" role="status">
        Auction emails are <strong>{current ? "on" : "off"}</strong>
        {current
          ? " — we'll let you know when a piece you liked goes up for auction."
          : " — you won't hear from us when a piece you liked goes up for auction."}
      </p>

      {state?.errors?.auctionEmailsEnabled ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.errors.auctionEmailsEnabled[0]}
        </p>
      ) : null}

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={`${secondaryButtonClass} self-start`}
      >
        {pending
          ? "Saving…"
          : target
            ? "Turn auction emails on"
            : "Turn auction emails off"}
      </button>
    </form>
  );
}
