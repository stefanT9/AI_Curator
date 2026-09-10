/**
 * Risk #1: a published artwork whose image no longer resolves.
 *
 * These tests reach `createArtwork` with a real authenticated Supabase client
 * (Next runtime still mocked) and assert the guarantee at the URL a collector's
 * browser actually requests.
 *
 * The core case — P1 — is the "insert commits but the client sees an error"
 * failure mode: a connection dropped after commit is enough for postgrest-js to
 * surface `error`, and the pre-Phase-4 compensating delete then removed the
 * object of a row that exists. The test injects that fault at the client seam
 * and asserts the Phase 4 guard skips the delete. To watch it go red, revert
 * the guard in `src/app/actions/artworks.ts` (`insertError` branch) and rerun.
 *
 * The P6 case asserts the Phase 4 `check` constraint now rejects an
 * unrenderable `image_path`; it was red before that migration landed.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { publicImageUrl, ARTWORKS_BUCKET } from "@/lib/artworks/images";
import { requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  TINY_PNG,
  type TestArtist,
  type TestClient,
} from "./helpers";

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
// `after` needs a request scope Node/Vitest has no way to provide. The publish
// path itself is what this lane tests; the deferred tag top-up is `src/lib/ai/`
// territory and has its own coverage. No-op it so `createArtwork` runs to the end.
vi.mock("next/server", () => ({ after: vi.fn() }));

import { createArtwork } from "@/app/actions/artworks";
import { createClient as createServerClient } from "@/utils/supabase/server";

let artist: TestArtist;

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
};

/**
 * Wrap a real authenticated client so the next `.from("artworks").insert(...)`
 * runs the real write and THEN resolves to an error — the "row committed but
 * the response was lost" failure mode (research P1: a dropped connection after
 * commit is enough for postgrest-js to surface `error`).
 *
 * Everything else passes straight through to the real client: the guard's
 * re-query on `artworks`, every other table, and all of storage. `.remove()`
 * on the artworks bucket is recorded in `removeCalls` and still delegated, so
 * the assertion can check *whether the action tried to delete* without
 * depending on whether storage RLS would honour the artist's own delete.
 */
type FaultedResult = {
  data: null;
  error: { message: string; code: string; details: string; hint: string };
};

const bindIfFn = (value: unknown, thisArg: object): unknown =>
  typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(thisArg)
    : value;

function wrapWithInsertFault(real: TestClient) {
  const removeCalls: string[][] = [];

  const faulted: FaultedResult = {
    data: null,
    error: {
      message: "connection reset after commit",
      code: "08006",
      details: "",
      hint: "",
    },
  };

  const faultedThenable = (realWrite: PromiseLike<unknown>) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      single: () => chain,
      maybeSingle: () => chain,
      then: (
        onFulfilled: (v: FaultedResult) => unknown,
        onRejected?: unknown,
      ) =>
        Promise.resolve(realWrite)
          .then(
            () => faulted,
            () => faulted,
          )
          .then(onFulfilled, onRejected as never),
      catch: (onRejected: unknown) =>
        (chain.then as (f: unknown, r: unknown) => unknown)(
          undefined,
          onRejected,
        ),
    };
    return chain;
  };

  const artworksBuilderProxy = (real: TestClient) =>
    new Proxy(real.from("artworks"), {
      get(target, prop, receiver) {
        if (prop === "insert") {
          return (values: unknown) =>
            faultedThenable(
              real
                .from("artworks")
                .insert(values as never)
                .select("id")
                .single(),
            );
        }
        return bindIfFn(Reflect.get(target, prop, receiver), target);
      },
    });

  const artworksBucketProxy = (realStorage: TestClient["storage"]) =>
    new Proxy(realStorage.from(ARTWORKS_BUCKET), {
      get(target, prop, receiver) {
        if (prop === "remove") {
          return (paths: string[]) => {
            removeCalls.push(paths);
            return target.remove(paths);
          };
        }
        return bindIfFn(Reflect.get(target, prop, receiver), target);
      },
    });

  const storageProxy = (realStorage: TestClient["storage"]) =>
    new Proxy(realStorage, {
      get(target, prop, receiver) {
        if (prop === "from") {
          return (bucket: string) =>
            bucket === ARTWORKS_BUCKET
              ? artworksBucketProxy(target)
              : target.from(bucket);
        }
        return bindIfFn(Reflect.get(target, prop, receiver), target);
      },
    });

  const client = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) =>
          table === "artworks"
            ? artworksBuilderProxy(target)
            : target.from(table as "artworks");
      }
      if (prop === "storage") return storageProxy(target.storage);
      return bindIfFn(Reflect.get(target, prop, receiver), target);
    },
  }) as unknown as TestClient;

  return { client, removeCalls };
}

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

  describe("Risk P1: insert commits but the client sees an error", () => {
    it("does not delete the live row's image when cleanup fires on a committed insert", async () => {
      // The production failure mode (research P1): the INSERT reaches Postgres
      // and commits, but the response is lost — a dropped connection after
      // commit is enough for postgrest-js to surface `error`. `createArtwork`
      // then runs its compensating delete. Before Phase 4 that delete removed
      // the object of a row that exists → a published card with no image, the
      // exact shape of Risk #1.
      //
      // Fault injection at the client seam: the real insert runs to completion,
      // then the awaited result is replaced with an error. Storage stays real,
      // but `.remove()` is recorded so the assertion tests whether the action
      // *tried* to delete — independent of whether storage RLS would honour an
      // artist deleting their own object.
      const imagePath = await artist.upload(TINY_PNG);
      const { client: faultedClient, removeCalls } = wrapWithInsertFault(
        artist.client,
      );
      vi.mocked(createServerClient).mockImplementationOnce(
        async () => faultedClient,
      );

      const result = await createArtwork(
        undefined,
        form({
          title: "Committed Despite Error",
          description: "Connection dropped after the row committed",
          tags: "test,integration",
          image: imagePath,
        }),
      );

      // The action reports failure to the artist...
      expect(result?.message).toMatch(/Could not save the artwork/);

      // ...but the row committed, so it is still there.
      const { data: rows } = await artist.client
        .from("artworks")
        .select("id, image_path")
        .eq("image_path", imagePath);
      expect(rows).toHaveLength(1);

      // The Phase 4 guard must have re-queried, found the row, and skipped the
      // delete. Revert the guard in src/app/actions/artworks.ts and this line
      // goes red — `remove()` gets called with the live row's key.
      expect(removeCalls).toEqual([]);

      // And the image is still retrievable at the collector's URL.
      const response = await fetch(publicImageUrl(imagePath));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
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
