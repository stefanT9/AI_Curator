import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireArtist } = vi.hoisted(() => ({ requireArtist: vi.fn() }));

vi.mock("@/lib/auth/dal", () => ({ requireArtist }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => {
    throw new Error("no test reaches Supabase");
  }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createArtwork,
  deleteArtwork,
  updateArtwork,
} from "@/app/actions/artworks";

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireArtist.mockResolvedValue({ id: "artist-1" });
});

describe("createArtwork", () => {
  it("reports field errors for an empty submission with no image", async () => {
    const result = await createArtwork(
      undefined,
      form({ title: "", description: "", tags: "" }),
    );

    expect(result?.errors?.title).toBeDefined();
    expect(result?.errors?.image).toBeDefined();
  });
});

describe("updateArtwork", () => {
  it("rejects a non-UUID artwork id", async () => {
    const result = await updateArtwork(
      undefined,
      form({ artworkId: "nope", title: "Valid", description: "", tags: "" }),
    );

    expect(result).toEqual({ message: "Unknown artwork." });
  });
});

describe("deleteArtwork", () => {
  it("no-ops on a non-UUID artwork id", async () => {
    await expect(
      deleteArtwork(form({ artworkId: "nope" })),
    ).resolves.toBeUndefined();
  });
});
