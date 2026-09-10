/**
 * Per-run fixtures for the real-boundary lane.
 *
 * Everything here runs as an ordinary authenticated user under the same RLS a
 * real artist has. No service-role key: `.env.example` warns against putting
 * one in this repo, and teardown does not need one — a user can delete its own
 * rows and its own objects through the policies that already exist.
 *
 * Mint users **per file**, not per test. `[auth.rate_limit]
 * sign_in_sign_ups = 30` per five minutes per IP (`supabase/config.toml`), so
 * a signup per test would flake the moment a file grew past thirty cases. A
 * handful per file is fine — the deck spec needs an artist and two collectors,
 * because `swipe_deck` hides the caller's own work.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { ARTWORKS_BUCKET, EXTENSIONS } from "@/lib/artworks/images";
import type { LocalStack } from "./setup";

export type TestClient = SupabaseClient<Database>;

export type TestArtist = {
  client: TestClient;
  userId: string;
  email: string;
  /**
   * Register an object key so teardown removes it. Needed because there is no
   * `select` policy on `storage.objects`, so `list()` cannot enumerate what
   * this user uploaded — Phase 2 pins that behavior; here we just work with it.
   */
  track: (imagePath: string) => void;
  /** Upload a buffer into this artist's own folder and track the key. */
  upload: (
    body: Uint8Array,
    options?: { contentType?: string; extension?: string },
  ) => Promise<string>;
  cleanup: () => Promise<void>;
};

/**
 * A real 1x1 PNG. Small enough that a round trip costs nothing, real enough
 * that the bucket's MIME sniffing and a `content-length` assertion both mean
 * something.
 */
export const TINY_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/**
 * A client with no session attached — the shape `src/utils/supabase/client.ts`
 * produces in the browser, minus the cookie storage that has no meaning in
 * Node. Sessions are held in memory and never written to disk, so two artists
 * in the same file cannot clobber each other's auth.
 */
const anonymousClient = (stack: LocalStack): TestClient =>
  createClient<Database>(stack.url, stack.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

/**
 * Sign up a fresh user and leave it at the default role.
 *
 * `auth.email.enable_confirmations = false` locally, so signUp returns a live
 * session in one call.
 */
const signUpTestUser = async (
  stack: LocalStack,
): Promise<{ client: TestClient; userId: string; email: string }> => {
  const client = anonymousClient(stack);
  const email = `artswipe-int-${crypto.randomUUID()}@example.test`;
  const password = `pw-${crypto.randomUUID()}`;

  const { data, error } = await client.auth.signUp({ email, password });

  if (error || !data.user || !data.session) {
    throw new Error(
      `Could not mint a test user: ${error?.message ?? "no session returned"}`,
    );
  }

  return { client, userId: data.user.id, email };
};

/**
 * Sign up a fresh user and promote it to artist.
 *
 * The promotion goes through the same column-granted `profiles` update that
 * `becomeArtist` uses — the storage insert policy calls `private.is_artist()`,
 * so a collector cannot upload at all.
 */
export const createTestArtist = async (
  stack: LocalStack,
): Promise<TestArtist> => {
  const { client, userId, email } = await signUpTestUser(stack);

  const { error: promoteError } = await client
    .from("profiles")
    .update({ role: "artist", display_name: `Int Test ${userId.slice(0, 8)}` })
    .eq("id", userId);

  if (promoteError) {
    throw new Error(
      `Could not promote the test user to artist: ${promoteError.message}`,
    );
  }

  const tracked = new Set<string>();

  const upload: TestArtist["upload"] = async (body, options) => {
    const contentType = options?.contentType ?? "image/png";
    const extension = options?.extension ?? EXTENSIONS[contentType] ?? "png";
    // Same key shape `uploadArtworkImage` builds, because
    // `IMAGE_PATH_PATTERN` and the storage policy both key off it.
    const imagePath = `${userId}/${crypto.randomUUID()}.${extension}`;

    const { error: uploadError } = await client.storage
      .from(ARTWORKS_BUCKET)
      .upload(imagePath, body, { contentType, upsert: false });

    if (uploadError) {
      throw new Error(`Test upload failed: ${uploadError.message}`);
    }

    tracked.add(imagePath);
    return imagePath;
  };

  const cleanup = async () => {
    // Rows first: RLS scopes the delete to this artist, and the filter makes
    // that explicit rather than implicit.
    await client.from("artworks").delete().eq("artist_id", userId);

    if (tracked.size > 0) {
      // Best-effort. `supabase db reset` clears Storage too, so an object that
      // outlives a run is a nuisance, not a correctness problem.
      await client.storage.from(ARTWORKS_BUCKET).remove([...tracked]);
      tracked.clear();
    }

    await client.auth.signOut();
  };

  return {
    client,
    userId,
    email,
    track: (key) => tracked.add(key),
    upload,
    cleanup,
  };
};

export type TestCollector = {
  client: TestClient;
  userId: string;
  email: string;
  cleanup: () => Promise<void>;
};

/**
 * Sign up a fresh user and leave it a collector.
 *
 * The absence of a promotion is the whole point: `swipe_deck` excludes
 * `a.artist_id = auth.uid()`, so a deck is only observable from an account
 * that did not upload the catalogue. That makes the artist helper unusable for
 * deck assertions and this one necessary.
 */
export const createTestCollector = async (
  stack: LocalStack,
): Promise<TestCollector> => {
  const { client, userId, email } = await signUpTestUser(stack);

  const cleanup = async () => {
    // RLS already scopes this delete to the caller; the filter states it.
    await client.from("interactions").delete().eq("user_id", userId);
    await client.auth.signOut();
  };

  return { client, userId, email, cleanup };
};
