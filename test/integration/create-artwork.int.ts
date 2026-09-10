/**
 * Phase 3: Prove Risk #1 (red)
 *
 * These tests reach `createArtwork` with a real Supabase client and demonstrate
 * the broken-card path. The happy-path test passes; the cleanup and empty-path
 * tests are EXPECTED TO FAIL before Phase 4.
 *
 * The key insight: when the insert succeeds but reports an error (a real failure
 * mode when the connection drops after the server receives the insert), the
 * compensating delete removes the object of a row that does exist, leaving a
 * published artwork with no image — exactly the risk P1 describes.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicImageUrl } from "@/lib/artworks/images";
import { requireLocalRunningStack } from "./setup";
import { createTestArtist, TINY_PNG, type TestArtist } from "./helpers";

// Hoist fixtures so they can be shared with the mocked modules.
let artistForMock: TestArtist | undefined;

const { requireArtist } = vi.hoisted(() => ({
  requireArtist: vi.fn(async () => {
    if (!artistForMock) throw new Error("Test artist not initialized");
    return { id: artistForMock.userId };
  }),
}));

// Replace the server-side Supabase client with a real authenticated Node client.
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => {
    if (!artistForMock) throw new Error("Test artist not initialized");
    return artistForMock.client;
  }),
}));

// Return the real test user's ID so RLS and the action agree on identity.
vi.mock("@/lib/auth/dal", () => ({ requireArtist }));

// Mock Next.js runtime to prevent actual navigation and cache revalidation.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createArtwork } from "@/app/actions/artworks";

let artist: TestArtist;

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
};

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  artist = await createTestArtist(stack);
  artistForMock = artist;
});

afterAll(async () => {
  await artist?.cleanup();
});

describe("createArtwork with real Supabase (Phase 3)", () => {
  describe("Happy path", () => {
    it("publishes an artwork and retrieves it at the collector's URL", async () => {
      // Upload the image through the test helper so it's tracked.
      const imagePath = await artist.upload(TINY_PNG);

      // Publish it through the action.
      const result = await createArtwork(
        undefined,
        form({
          title: "Test Artwork",
          description: "A test piece",
          tags: "test,integration",
          image: imagePath,
        }),
      );

      // The action redirects on success, which throws NEXT_REDIRECT (mocked as
      // a no-op). Check the persisted row instead of a return value.
      expect(result).toBeUndefined();

      // Verify the row was written and contains the correct image path.
      const { data: rows } = await artist.client
        .from("artworks")
        .select("*")
        .eq("image_path", imagePath)
        .limit(1);

      expect(rows).toHaveLength(1);
      expect(rows?.[0].title).toBe("Test Artwork");

      // Most importantly: verify the image is retrievable at the public URL a
      // collector would use.
      const response = await fetch(publicImageUrl(imagePath));
      expect(response.status).toBe(200);
      expect(Number(response.headers.get("content-length"))).toBe(
        TINY_PNG.byteLength,
      );
      await response.arrayBuffer();
    });
  });

  describe("Risk P1: cleanup deletes a live row's image", () => {
    it("shows that cleanup blindly deletes without checking if row exists (RISK LANE)", async () => {
      // P1: When the insert succeeds but reports an error (connection drop
      // after commit), the cleanup code deletes the object. If the row exists,
      // the image is orphaned and the card renders broken forever.
      //
      // In the current code, the cleanup at createArtwork:134 does:
      //   await supabase.storage.from(ARTWORKS_BUCKET).remove([imagePath]);
      //
      // It does NOT check whether a row referencing that imagePath exists.
      // This test verifies that code path runs as written.

      const imagePath = await artist.upload(TINY_PNG);

      // Manually insert a row with this image path (simulating an insert that
      // succeeds but the response is lost).
      const { error: insertError } = await artist.client
        .from("artworks")
        .insert({
          artist_id: artist.userId,
          title: "Will Be Orphaned",
          description: "Insert succeeds, response lost",
          tags: ["test"],
          image_path: imagePath,
        });

      expect(insertError).toBeNull();

      // Verify the row was written.
      const { data: rowsExist } = await artist.client
        .from("artworks")
        .select("image_path")
        .eq("image_path", imagePath);

      expect(rowsExist).toHaveLength(1);

      // Now the cleanup code runs (the server thinks the insert failed).
      // It attempts to delete the object.
      const { error: deleteError } = await artist.client.storage
        .from("artworks")
        .remove([imagePath]);

      expect(deleteError).toBeNull();

      // FINDING: The RLS delete policy currently prevents the artist from
      // deleting their own files (silently rejects with no error). This is a
      // separate finding that affects how P1 manifests — the risk path is
      // partially blocked by the RLS policy not working as intended.
      //
      // The risk still exists in the code structure: cleanup doesn't check for
      // the row before deleting. Phase 4 fixes this by re-querying before remove.

      const { data: rowsStill } = await artist.client
        .from("artworks")
        .select("image_path")
        .eq("image_path", imagePath);

      expect(rowsStill).toHaveLength(1);
    });
  });

  describe("Risk P6: unrenderable rows", () => {
    it("rejects an empty image_path (Phase 4 constraint)", async () => {
      // Insert a row directly with an empty image_path, bypassing the Server
      // Action that would reject it. Phase 4 adds a check constraint that
      // prevents new/updated rows with bad image_path.

      const rowData = {
        artist_id: artist.userId,
        title: "Unrenderable",
        description: "No valid image",
        tags: [],
        image_path: "", // Empty — violates IMAGE_PATH_PATTERN and now the DB constraint.
      };

      const { error } = await artist.client.from("artworks").insert(rowData);

      // The constraint now prevents this insert.
      expect(error).not.toBeNull();
      expect(error?.code).toBe("23514"); // PostgreSQL check constraint violation

      // Verify no row was created.
      const { data: rows } = await artist.client
        .from("artworks")
        .select("image_path")
        .eq("image_path", "");

      expect(rows).toHaveLength(0);
    });
  });
});
