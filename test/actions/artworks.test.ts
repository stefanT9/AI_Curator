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

  it("rejects an image key that is not a valid object path", async () => {
    const result = await createArtwork(
      undefined,
      form({
        title: "Valid",
        description: "",
        tags: "",
        image: "../../etc/passwd",
      }),
    );

    expect(result?.errors?.image).toBeDefined();
  });

  // The bucket is public, so without the folder check an artist could publish a
  // row pointing at another artist's object. Rejected before Storage is reached
  // — `createClient` is mocked to throw, so getting this far would blow up.
  it("rejects a well-formed key belonging to another artist", async () => {
    const artistId = "00000000-0000-4000-8000-000000000001";
    const otherId = "00000000-0000-4000-8000-000000000002";
    requireArtist.mockResolvedValue({ id: artistId });

    const result = await createArtwork(
      undefined,
      form({
        title: "Valid",
        description: "",
        tags: "",
        image: `${otherId}/00000000-0000-4000-8000-0000000000ff.jpg`,
      }),
    );

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
