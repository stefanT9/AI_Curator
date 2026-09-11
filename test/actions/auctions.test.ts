import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireArtist, requireUser, rpc, redirect } = vi.hoisted(() => ({
  requireArtist: vi.fn(),
  requireUser: vi.fn(),
  rpc: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({ requireArtist, requireUser }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { cancelAuction, createAuction } from "@/app/actions/auctions";

const VALID_ARTWORK_ID = "11111111-1111-4111-8111-111111111111";
const VALID_AUCTION_ID = "22222222-2222-4222-8222-222222222222";

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireArtist.mockResolvedValue({ id: "artist-1" });
  requireUser.mockResolvedValue({ id: "user-1", email: null });
  rpc.mockResolvedValue({ data: VALID_AUCTION_ID, error: null });
});

describe("createAuction", () => {
  it("rejects a malformed artwork id before calling the database", async () => {
    const result = await createAuction(
      undefined,
      form({ artworkId: "not-a-uuid", startingPrice: "10", duration: "24" }),
    );

    expect(result).toEqual({ message: "Unknown artwork." });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a duration outside the preset set", async () => {
    const result = await createAuction(
      undefined,
      form({
        artworkId: VALID_ARTWORK_ID,
        startingPrice: "10",
        duration: "48",
      }),
    );

    expect(result?.errors?.duration).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a zero, negative, or unparseable starting price", async () => {
    const result = await createAuction(
      undefined,
      form({
        artworkId: VALID_ARTWORK_ID,
        startingPrice: "0",
        duration: "24",
      }),
    );

    expect(result?.errors?.startingPrice).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("calls create_auction with cents and hours on the happy path", async () => {
    await createAuction(
      undefined,
      form({
        artworkId: VALID_ARTWORK_ID,
        startingPrice: "12.50",
        duration: "72",
      }),
    );

    expect(rpc).toHaveBeenCalledWith("create_auction", {
      p_artwork_id: VALID_ARTWORK_ID,
      p_duration_hours: 72,
      p_starting_price_cents: 1250,
    });
    expect(redirect).toHaveBeenCalledWith("/auctions");
  });

  it("surfaces an already-live auction as a message, not a crash", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "artwork already has a live auction", code: "AUC04" },
    });

    const result = await createAuction(
      undefined,
      form({
        artworkId: VALID_ARTWORK_ID,
        startingPrice: "10",
        duration: "24",
      }),
    );

    expect(result).toEqual({
      message: "This piece already has a live auction.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("falls back to a generic message for an unmapped database refusal", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "boom", code: "UNKNOWN" },
    });

    const result = await createAuction(
      undefined,
      form({
        artworkId: VALID_ARTWORK_ID,
        startingPrice: "10",
        duration: "24",
      }),
    );

    expect(result?.message).toBeDefined();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("cancelAuction", () => {
  it("no-ops on a non-UUID auction id without calling the database", async () => {
    await cancelAuction(form({ auctionId: "nope" }));

    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns quietly on a false result", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    await expect(
      cancelAuction(form({ auctionId: VALID_AUCTION_ID })),
    ).resolves.toBeUndefined();
  });

  it("calls cancel_auction with the auction id", async () => {
    await cancelAuction(form({ auctionId: VALID_AUCTION_ID }));

    expect(rpc).toHaveBeenCalledWith("cancel_auction", {
      p_auction_id: VALID_AUCTION_ID,
    });
  });
});
