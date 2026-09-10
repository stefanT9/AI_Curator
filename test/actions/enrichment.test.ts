import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireArtist, enrichFromImage, rpc } = vi.hoisted(() => ({
  requireArtist: vi.fn(),
  enrichFromImage: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({ requireArtist }));
vi.mock("@/lib/ai", () => ({ enrichFromImage }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc })),
}));

import { suggestArtworkFields } from "@/app/actions/enrichment";

/** Shortest string that satisfies the data-URL shape. */
const dataUrl = "data:image/jpeg;base64,AAAA";

beforeEach(() => {
  vi.clearAllMocks();
  requireArtist.mockResolvedValue({ id: "artist-1" });
  // Quota slot granted unless a test says otherwise.
  rpc.mockResolvedValue({ data: true, error: null });
});

describe("suggestArtworkFields", () => {
  it("rejects input that is not a data URL, without calling the service", async () => {
    const result = await suggestArtworkFields("https://example.com/cat.png");

    expect(result.ok).toBe(false);
    expect(enrichFromImage).not.toHaveBeenCalled();
  });

  it("rejects a payload above the size ceiling", async () => {
    const oversized = `data:image/jpeg;base64,${"A".repeat(1_600_000)}`;

    const result = await suggestArtworkFields(oversized);

    expect(result.ok).toBe(false);
    expect(enrichFromImage).not.toHaveBeenCalled();
  });

  it("refuses without spending a call when the quota is exhausted", async () => {
    rpc.mockResolvedValue({ data: false, error: null });

    const result = await suggestArtworkFields(dataUrl);

    expect(result.ok).toBe(false);
    expect(enrichFromImage).not.toHaveBeenCalled();
  });

  it("refuses when the quota check itself fails, rather than spending a call", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const result = await suggestArtworkFields(dataUrl);

    expect(result.ok).toBe(false);
    expect(enrichFromImage).not.toHaveBeenCalled();
  });

  // The slot is claimed only after the payload is known good, so a malformed
  // request cannot burn quota.
  it("does not claim a quota slot for invalid input", async () => {
    await suggestArtworkFields("not-a-data-url");

    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps a typed failure onto actionable copy", async () => {
    enrichFromImage.mockResolvedValue({ ok: false, reason: "rate_limited" });

    const result = await suggestArtworkFields(dataUrl);

    expect(result).toEqual({
      ok: false,
      message: "Too many suggestions just now. Wait a moment and try again.",
    });
  });

  it("returns the description and tags on success", async () => {
    enrichFromImage.mockResolvedValue({
      ok: true,
      data: { description: "A quiet study in ochre.", tags: ["oil painting"] },
    });

    const result = await suggestArtworkFields(dataUrl);

    expect(result).toEqual({
      ok: true,
      description: "A quiet study in ochre.",
      tags: ["oil painting"],
    });
  });

  // Auth is the first thing the action does, before validation touches input.
  it("enforces the artist gate before anything else", async () => {
    requireArtist.mockRejectedValue(new Error("redirect"));

    await expect(suggestArtworkFields("nonsense")).rejects.toThrow("redirect");
    expect(enrichFromImage).not.toHaveBeenCalled();
  });
});
