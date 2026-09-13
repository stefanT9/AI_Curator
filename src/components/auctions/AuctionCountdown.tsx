"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatRemaining, msRemaining } from "@/lib/auctions/status";

type AuctionCountdownProps = {
  endsAt: string;
  /** The server-formatted absolute end time, shown until the client mounts. */
  absolute: string;
};

/**
 * How long to wait after the countdown hits zero before re-reading the page.
 *
 * `close_due_auctions` runs on a per-minute `pg_cron` schedule, so at the
 * instant the clock reaches zero the outcome is not in the database yet.
 * Refreshing immediately would re-render "this auction has ended" with nothing
 * to show -- §Guardrails' "countdown reaches zero and nothing happens" in
 * miniature -- so the delay covers the worst-case sweep lag, plus a little.
 */
const SWEEP_SETTLE_MS = 65_000;

/**
 * A server-computed relative string ("3 days left") would differ between the
 * server render and the client hydration pass -- a hydration mismatch. So the
 * server emits `absolute` and this swaps in the ticking remainder only after
 * mount, clearing the interval on unmount and once it reaches zero.
 *
 * Reaching zero also refreshes the route once, so a collector watching the
 * clock sees the outcome appear without touching the page. The pages that
 * render this are `force-dynamic`, so the refresh re-reads real state.
 */
export function AuctionCountdown({ endsAt, absolute }: AuctionCountdownProps) {
  const [remaining, setRemaining] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      const ms = msRemaining({ ends_at: endsAt }, new Date());
      setRemaining(formatRemaining(ms));
      return ms;
    };

    // Already over when this mounted: there is no transition to watch, and
    // whatever outcome exists is already in this render. Refreshing here would
    // reload every such page on every visit.
    if (tick() <= 0) {
      return;
    }

    const interval = setInterval(() => {
      if (tick() <= 0) {
        clearInterval(interval);
        settle = setTimeout(() => router.refresh(), SWEEP_SETTLE_MS);
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      clearTimeout(settle);
    };
  }, [endsAt, router]);

  return <span className="text-sm opacity-70">{remaining ?? absolute}</span>;
}
