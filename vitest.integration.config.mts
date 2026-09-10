import { defineConfig } from "vitest/config";

/**
 * Opt-in config for the real-boundary lane under `test/integration/`.
 *
 * These specs talk to a real Supabase stack — real Postgres, real Storage,
 * real Auth, real RLS — because the questions they answer (what `.exists()`
 * returns when no `select` policy exists on `storage.objects`; whether a
 * published row's image is retrievable at the URL the collector's browser
 * requests) cannot be answered by a mock of the thing being questioned.
 *
 * The stack must be local. `test/integration/setup.ts` refuses to run against
 * anything whose hostname is not 127.0.0.1 or localhost, because this lane
 * creates users and uploads objects.
 *
 * Its own config and its own `.int.ts` glob — disjoint from both
 * `test/**\/*.test.ts` and `test/smoke/**\/*.live.ts` — so `npm run test` and
 * CI can never pick it up. Written standalone rather than via `mergeConfig`,
 * which concatenates `include` arrays and would drag the mocked suite in.
 *
 * Run with `npm run test:integration`.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      "server-only": new URL("./test/stubs/server-only.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/integration/**/*.int.ts"],
    // No `test.env` block: the real URL and anon key come from
    // `.env.test.local`, generated from `supabase status`. Hardcoding
    // placeholders here would defeat the local-only guard.
    //
    // Real network round trips replace mocks, and a `db reset` between runs
    // makes the first call of a run slow.
    testTimeout: 30_000,
    // Raised alongside `testTimeout`, not left at the 10s default: the
    // per-file `beforeAll` signs a user up and promotes it, and a signup is
    // the slowest call in the lane — GoTrue hashes the password with bcrypt.
    // Without this the hook times out first and every test in the file is
    // reported as skipped, which hides the real cause.
    hookTimeout: 30_000,
  },
});
