"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  setAuctionEmailsFromLink,
  type UnsubscribeFormState,
} from "@/app/actions/notifications";
import { secondaryButtonClass, submitButtonClass } from "@/components/ui/Field";

/**
 * The confirm button behind the unsubscribe link.
 *
 * The token rides in a hidden field and is re-verified server-side on every
 * submit — it is the only thing standing in for a session, so the client is
 * never trusted to say which user this is. There is deliberately no user id
 * here to send.
 */
export function UnsubscribeForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<
    UnsubscribeFormState,
    FormData
  >(setAuctionEmailsFromLink, undefined);

  if (state?.status === "done") {
    return (
      <div className="flex flex-col gap-4">
        <p role="status" className="text-sm">
          {state.enabled
            ? "Auction emails are back on. We'll let you know when a piece you liked goes up for auction."
            : "Done — auction emails are off. You won't hear from us when a piece you liked goes up for auction."}
        </p>

        {/*
          Re-subscribe over the same proven token, so a misclick costs one more
          click rather than a sign-in.
        */}
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <input
            type="hidden"
            name="enabled"
            value={state.enabled ? "false" : "true"}
          />
          <button
            type="submit"
            disabled={pending}
            className={`${secondaryButtonClass} self-start`}
          >
            {pending
              ? "Saving…"
              : state.enabled
                ? "Turn them off"
                : "Turn them back on"}
          </button>
        </form>

        <Link href="/account" className="text-sm underline opacity-70">
          Go to your account
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="enabled" value="false" />

      {state?.status === "invalid" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          This link didn&rsquo;t work. You can change this setting from your
          account page instead.
        </p>
      ) : null}

      {state?.status === "error" ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className={`${submitButtonClass} self-start`}
      >
        {pending ? "Saving…" : "Turn off auction emails"}
      </button>
    </form>
  );
}
