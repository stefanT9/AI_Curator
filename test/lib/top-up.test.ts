import { beforeEach, describe, expect, it, vi } from "vitest";

const { enrichFromImage } = vi.hoisted(() => ({ enrichFromImage: vi.fn() }));

vi.mock("@/lib/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai")>();
  return { ...actual, enrichFromImage };
});

import { topUpTags } from "@/lib/artworks/top-up";

const imagePath = "artist-1/piece.jpg";

const generated = (...tags: string[]) => ({
  ok: true as const,
  data: { description: "", tags },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("topUpTags", () => {
  it("makes no model call when the artist tagged adequately", async () => {
    const tags = ["oil painting", "abstract", "warm palette", "large", "blue"];

    await expect(topUpTags(tags, imagePath)).resolves.toEqual(tags);
    expect(enrichFromImage).not.toHaveBeenCalled();
  });

  it("calls the model exactly once when the artist is under the minimum", async () => {
    enrichFromImage.mockResolvedValue(generated("ink", "portrait", "moody"));

    await topUpTags(["sketch"], imagePath);

    expect(enrichFromImage).toHaveBeenCalledTimes(1);
  });

  it("hands the model a public URL, not a storage key", async () => {
    enrichFromImage.mockResolvedValue(generated("ink"));

    await topUpTags([], imagePath);

    expect(enrichFromImage).toHaveBeenCalledWith(
      expect.stringContaining(`/artworks/${imagePath}`),
    );
    expect(enrichFromImage).not.toHaveBeenCalledWith(imagePath);
  });

  it("keeps the artist's tags when enrichment fails", async () => {
    enrichFromImage.mockResolvedValue({ ok: false, reason: "unavailable" });

    await expect(topUpTags(["sketch"], imagePath)).resolves.toEqual(["sketch"]);
  });

  it("keeps the artist's tags when enrichment throws", async () => {
    enrichFromImage.mockRejectedValue(new Error("boom"));

    await expect(topUpTags(["sketch"], imagePath)).resolves.toEqual(["sketch"]);
  });

  it("does not duplicate a tag the artist already typed", async () => {
    enrichFromImage.mockResolvedValue(generated("ink", "sketch", "moody"));

    const result = await topUpTags(["sketch"], imagePath);

    expect(result).toEqual(["sketch", "ink", "moody"]);
  });

  it("caps at the storage ceiling, dropping generated tags before artist tags", async () => {
    const artistTags = ["a", "b", "c", "d"];
    const generatedTags = Array.from({ length: 25 }, (_, i) => `gen-${i}`);
    enrichFromImage.mockResolvedValue(generated(...generatedTags));

    const result = await topUpTags(artistTags, imagePath);

    expect(result).toHaveLength(20);
    expect(result.slice(0, 4)).toEqual(artistTags);
  });
});
