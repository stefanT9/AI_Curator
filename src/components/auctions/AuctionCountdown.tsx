"use client";

import { useEffect, useState } from "react";
import { formatRemaining, msRemaining } from "@/lib/auctions/status";

type AuctionCountdownProps = {
  endsAt: string;
  /** The server-formatted absolute end time, shown until the client mounts. */
  absolute: string;
};

/**
 * A server-computed relative string ("3 days left") would differ between the
 * server render and the client hydration pass -- a hydration mismatch. So the
 * server emits `absolute` and this swaps in the ticking remainder only after
 * mount, clearing the interval on unmount and once it reaches zero.
 */
export function AuctionCountdown({ endsAt, absolute }: AuctionCountdownProps) {
  const [remaining, setRemaining] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const ms = msRemaining({ ends_at: endsAt }, new Date());
      setRemaining(formatRemaining(ms));
      return ms;
    };

    if (tick() <= 0) {
      return;
    }

    const interval = setInterval(() => {
      if (tick() <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [endsAt]);

  return <span className="text-sm opacity-70">{remaining ?? absolute}</span>;
}
