import { describe, expect, it } from "vitest";

import { formatRemaining, isOpen, msRemaining } from "@/lib/auctions/status";
import type { Auction } from "@/types/domain";

const endsAt = "2026-09-18T12:00:00.000Z";

function auction(
  overrides: Partial<Pick<Auction, "cancelled_at" | "ends_at">> = {},
): Pick<Auction, "cancelled_at" | "ends_at"> {
  return { cancelled_at: null, ends_at: endsAt, ...overrides };
}

describe("isOpen", () => {
  it("is open one millisecond before ends_at", () => {
    const now = new Date(new Date(endsAt).getTime() - 1);
    expect(isOpen(auction(), now)).toBe(true);
  });

  it("is not open at the exact ends_at instant", () => {
    expect(isOpen(auction(), new Date(endsAt))).toBe(false);
  });

  it("is not open one millisecond after ends_at", () => {
    const now = new Date(new Date(endsAt).getTime() + 1);
    expect(isOpen(auction(), now)).toBe(false);
  });

  it("is not open when cancelled, even before ends_at", () => {
    const now = new Date(new Date(endsAt).getTime() - 1);
    expect(
      isOpen(auction({ cancelled_at: "2026-09-12T00:00:00.000Z" }), now),
    ).toBe(false);
  });
});

describe("msRemaining", () => {
  it("returns the exact gap to ends_at", () => {
    const now = new Date(new Date(endsAt).getTime() - 5000);
    expect(msRemaining(auction(), now)).toBe(5000);
  });

  it("clamps to zero once ends_at has passed", () => {
    const now = new Date(new Date(endsAt).getTime() + 5000);
    expect(msRemaining(auction(), now)).toBe(0);
  });
});

describe("formatRemaining", () => {
  it("reports Ended at zero", () => {
    expect(formatRemaining(0)).toBe("Ended");
  });

  it("reports Ended for a negative remainder", () => {
    expect(formatRemaining(-1)).toBe("Ended");
  });

  it("formats days and hours", () => {
    const ms = (3 * 24 + 5) * 60 * 60 * 1000;
    expect(formatRemaining(ms)).toBe("3d 5h left");
  });

  it("formats hours and minutes once under a day", () => {
    const ms = (2 * 60 + 30) * 60 * 1000;
    expect(formatRemaining(ms)).toBe("2h 30m left");
  });

  it("formats minutes once under an hour", () => {
    expect(formatRemaining(45 * 60 * 1000)).toBe("45m left");
  });

  it("reports less than a minute under one minute", () => {
    expect(formatRemaining(30_000)).toBe("Less than a minute left");
  });
});
