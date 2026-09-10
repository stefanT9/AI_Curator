/**
 * Characterization tests for the storage boundary.
 *
 * The point here is to RECORD real behavior, especially where the source code
 * cannot tell us the answer. `.exists()` uses a different route than the public
 * URL, has no `select` policy on `storage.objects` to enumerate what a user
 * owns, and returns a different response shape than `fetch()`.
 *
 * These tests document what the boundary actually does, serving as the
 * foundation for Phase 3 (proving Risk #1) and Phase 4 (closing the gap).
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicImageUrl, ARTWORKS_BUCKET } from "@/lib/artworks/images";
import { requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  TINY_PNG,
  type TestArtist,
} from "./helpers";

let artist1: TestArtist;
let artist2: TestArtist;

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  // Mint two test users for testing RLS policies.
  [artist1, artist2] = await Promise.all([
    createTestArtist(stack),
    createTestArtist(stack),
  ]);
});

afterAll(async () => {
  await Promise.all([artist1?.cleanup(), artist2?.cleanup()]);
});

describe("Existence-check semantics", () => {
  it("returns true on `.exists()` for a freshly uploaded object", async () => {
    const imagePath = await artist1.upload(TINY_PNG);

    const { data } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(imagePath);

    expect(data).toBe(true);
  });

  it("returns 200 at the public URL for a freshly uploaded object", async () => {
    const imagePath = await artist1.upload(TINY_PNG);

    const response = await fetch(publicImageUrl(imagePath));

    expect(response.status).toBe(200);
    expect(Number(response.headers.get("content-length"))).toBe(
      TINY_PNG.byteLength,
    );
    await response.arrayBuffer();
  });

  it("returns false on `.exists()` for a key that was never uploaded", async () => {
    const neverUploaded = `${artist1.userId}/${crypto.randomUUID()}.png`;

    const { data } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(neverUploaded);

    // `.exists()` returns false when the key doesn't exist, even if the lookup
    // results in a 400 error (which is what the storage-api returns for
    // unauthorized or not-found GET requests on the authenticated route).
    expect(data).toBe(false);
  });

  it("returns non-200 at the public URL for a key that was never uploaded", async () => {
    const neverUploaded = `${artist1.userId}/${crypto.randomUUID()}.png`;

    const response = await fetch(publicImageUrl(neverUploaded));

    expect(response.ok).toBe(false);
    await response.arrayBuffer();
  });

  it("returns false on `.exists()` for a key in another user's folder", async () => {
    const imagePath = await artist1.upload(TINY_PNG);
    // Extract the filename and pretend it's in artist2's folder.
    const filename = imagePath.split("/")[1];
    const otherUserKey = `${artist2.userId}/${filename}`;

    const { data } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(otherUserKey);

    expect(data).toBe(false);
  });

  it("returns non-200 at the public URL for a key in another user's folder", async () => {
    const imagePath = await artist1.upload(TINY_PNG);
    // Extract the filename and pretend it's in artist2's folder.
    const filename = imagePath.split("/")[1];
    const otherUserKey = `${artist2.userId}/${filename}`;

    const response = await fetch(publicImageUrl(otherUserKey));

    expect(response.ok).toBe(false);
    await response.arrayBuffer();
  });
});

describe("Existence check for unusable objects", () => {
  it("accepts a zero-byte upload through the bucket", async () => {
    const zeroBytes = new Uint8Array(0);
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.png`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, zeroBytes, { contentType: "image/png", upsert: false });

    // The bucket permits empty files (the size check is only in the browser).
    expect(error).toBeNull();
    artist1.track(imagePath);
  });

  it("`.exists()` returns true for a zero-byte object", async () => {
    const zeroBytes = new Uint8Array(0);
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.png`;

    await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, zeroBytes, { contentType: "image/png", upsert: false });
    artist1.track(imagePath);

    const { data } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(imagePath);

    expect(data).toBe(true);
  });

  it("accepts a mismatched MIME type upload through the bucket", async () => {
    // Send PNG data but claim it's JPEG.
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.jpg`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, TINY_PNG, { contentType: "image/jpeg", upsert: false });

    // The bucket permits MIME mismatches (the check is only in the browser).
    expect(error).toBeNull();
    artist1.track(imagePath);
  });

  it("`.exists()` returns true for a mismatched-MIME object", async () => {
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.jpg`;

    await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, TINY_PNG, { contentType: "image/jpeg", upsert: false });
    artist1.track(imagePath);

    const { data } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(imagePath);

    expect(data).toBe(true);
  });
});

describe("Storage RLS policies", () => {
  it("allows an artist to upload into their own folder", async () => {
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.png`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, TINY_PNG, { contentType: "image/png", upsert: false });

    expect(error).toBeNull();
    artist1.track(imagePath);
  });

  it("denies an artist from uploading into another's folder", async () => {
    const otherUserPath = `${artist2.userId}/${crypto.randomUUID()}.png`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(otherUserPath, TINY_PNG, {
        contentType: "image/png",
        upsert: false,
      });

    expect(error).not.toBeNull();
    // The RLS policy rejects with "new row violates row-level security policy"
    expect(error?.message).toContain("row-level security policy");
  });

  it("silently ignores delete of another's object (RLS policy working)", async () => {
    const imagePath = await artist2.upload(TINY_PNG);

    // FINDING: When artist1 tries to delete artist2's object, the `.remove()`
    // call returns no error, but the object is not deleted. This is the RLS
    // policy working — the `using` clause silently rejects the operation
    // without raising an exception. The delete is a no-op.
    const { error: deleteError } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .remove([imagePath]);

    expect(deleteError).toBeNull();

    // The object still exists because the delete was silently rejected by RLS.
    const { data: stillExists } = await artist2.client.storage
      .from(ARTWORKS_BUCKET)
      .exists(imagePath);

    expect(stillExists).toBe(true);
  });

  it("rejects an upload larger than 10 MiB", async () => {
    // 10 MiB + 1 byte.
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.png`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, oversized, {
        contentType: "image/png",
        upsert: false,
      });

    expect(error).not.toBeNull();
  });

  it("rejects an upload with a disallowed MIME type declared in the bucket", async () => {
    const imagePath = `${artist1.userId}/${crypto.randomUUID()}.txt`;

    const { error } = await artist1.client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, new Uint8Array([1, 2, 3]), {
        contentType: "text/plain",
        upsert: false,
      });

    expect(error).not.toBeNull();
  });
});
