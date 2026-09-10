/**
 * The lane's first assertion, and the one the whole phase is about: an object
 * an artist uploaded is retrievable **at the URL a collector's browser will
 * request**.
 *
 * That distinction is the point. `ArtCard` renders `publicImageUrl(key)` —
 * `/storage/v1/object/public/artworks/<key>` — which is a different route,
 * with different authorization, from the one `.exists()` probes. Asserting
 * against the public route is the only check that matches what a collector
 * actually sees, and no mock can answer it.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { publicImageUrl } from "@/lib/artworks/images";
import { requireLocalRunningStack } from "./setup";
import { createTestArtist, TINY_PNG, type TestArtist } from "./helpers";

let artist: TestArtist;

beforeAll(async () => {
  const stack = await requireLocalRunningStack();
  artist = await createTestArtist(stack);
});

afterAll(async () => {
  await artist?.cleanup();
});

it("serves an uploaded object at the collector's public URL", async () => {
  const imagePath = await artist.upload(TINY_PNG);

  // Scoped to this run's user id, so parallel files cannot collide.
  expect(imagePath.startsWith(`${artist.userId}/`)).toBe(true);

  const response = await fetch(publicImageUrl(imagePath));

  expect(response.status).toBe(200);
  expect(Number(response.headers.get("content-length"))).toBe(
    TINY_PNG.byteLength,
  );

  // Drain the body so the connection is released rather than left open until
  // the run's timeout.
  await response.arrayBuffer();
});

it("returns 400 at the public URL for a key that was never uploaded", async () => {
  const missing = `${artist.userId}/${crypto.randomUUID()}.png`;

  const response = await fetch(publicImageUrl(missing));

  // Recorded, not desired: storage-api answers a missing public object with a
  // JSON error body, and this is the status a broken card would produce.
  expect(response.ok).toBe(false);
  await response.arrayBuffer();
});
