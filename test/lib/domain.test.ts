import { describe, expect, it } from "vitest";

import { artistLabel } from "@/types/domain";

describe("artistLabel", () => {
  it("returns the display name when present", () => {
    expect(artistLabel({ id: "1", displayName: "Ada Lovelace" })).toBe(
      "Ada Lovelace",
    );
  });

  it("falls back for a null artist", () => {
    expect(artistLabel(null)).toBe("Unnamed artist");
  });

  it("falls back for an artist with no display name", () => {
    expect(artistLabel({ id: "1", displayName: null })).toBe("Unnamed artist");
  });
});
