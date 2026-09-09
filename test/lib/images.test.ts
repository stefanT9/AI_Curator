import { describe, expect, it } from "vitest";

import { ARTWORKS_BUCKET, publicImageUrl } from "@/lib/artworks/images";

describe("publicImageUrl", () => {
  it("builds the storage public URL from the bucket and image path", () => {
    expect(publicImageUrl("artist-1/piece.jpg")).toBe(
      "https://smoke-test.supabase.co/storage/v1/object/public/artworks/artist-1/piece.jpg",
    );
  });

  it("keeps the artist folder prefix intact", () => {
    expect(publicImageUrl("a/b/c.webp")).toContain(
      `/public/${ARTWORKS_BUCKET}/a/b/c.webp`,
    );
  });
});
