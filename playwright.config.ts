import { defineConfig, devices } from "@playwright/test";
import { requireLocalStack } from "./test/integration/setup";

/**
 * Opt-in config for the browser lane under `test/e2e/`.
 *
 * The fourth lane, and the only one that drives a real browser against a real
 * server. It exists for the one risk no other lane spans: a collector
 * completes onboarding, likes pieces, and the deck that follows is ordered
 * toward what they liked — auth, the proxy, RLS, the `swipe_deck` RPC and the
 * rendered deck, all at once.
 *
 * Its `.spec.ts` glob under `test/e2e/` is disjoint from all three Vitest
 * globs (`test/**\/*.test.ts`, `test/integration/**\/*.int.ts`,
 * `test/smoke/**\/*.live.ts`), so `npm run test` and CI can never pick it up.
 *
 * Never in CI. It needs a local Supabase stack, a seeded 1000-row corpus and a
 * full production build; a workflow that provisioned all three would be
 * building a second CI system to run one test.
 *
 * Run with `npm run test:e2e`, after:
 *   npx supabase start
 *   npx supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
 *     --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY > .env.test.local
 *   npm run db:seed:fetch   # once — ~260 MB of corpus images
 *   npm run db:reset
 *   npx playwright install chromium   # once
 */

/**
 * The lane's credentials, from the same file the integration lane reads.
 *
 * Loaded here rather than through the `--env-file-if-exists` flag the Vitest
 * lanes use in their npm scripts: the Playwright CLI is not `node`, so that
 * flag has nowhere to go. Node 24 (see `.nvmrc`) has `loadEnvFile` built in.
 *
 * It does **not** overwrite anything already in `process.env`, which is what
 * lets the guard below be exercised by hand:
 *   NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co npm run test:e2e
 *
 * A missing file is swallowed rather than thrown. `loadEnvFile` raises ENOENT,
 * and a config that dies at import time takes `globalSetup` down with it —
 * meaning the developer who has not generated `.env.test.local` yet would get
 * a bare stack trace instead of the instruction `requireLocalStack` exists to
 * print. Any other error is a real one and is left alone.
 */
try {
  process.loadEnvFile(".env.test.local");
} catch (cause) {
  if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
}

/**
 * The loopback guard, and it runs **here** rather than in `globalSetup`.
 *
 * Playwright boots `webServer` *before* `globalSetup`, so a guard that only
 * lived in the setup hook would fire after a full `next build` had already
 * completed against whatever credentials were in scope — observed exactly
 * that way while building this lane. By then the damage a guard exists to
 * prevent is a `start` away: `npm run build && npm run start` are one command,
 * so the server is serving before the hook gets a turn.
 *
 * Config module scope is the only point earlier than the server. It costs
 * `--list` the requirement of a valid `.env.test.local`, which is the right
 * trade — the failure is `requireLocalStack`'s instruction, not a production
 * build.
 *
 * `globalSetup` keeps the async half (is the stack actually up?), which cannot
 * run here because config evaluation is synchronous.
 */
const stack = requireLocalStack();

/**
 * The two variables the built app needs, forwarded to `webServer` explicitly.
 *
 * Taken from the guard's return value, not from `process.env` again — these
 * are the vetted, proven-loopback values by construction, so there is no
 * reachable path where an unchecked URL is handed to `next build`.
 */
const stackEnv = {
  NEXT_PUBLIC_SUPABASE_URL: stack.url,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.anonKey,
};

/**
 * `supabase/config.toml` sets `site_url = "http://127.0.0.1:3000"`. Using
 * `localhost` here instead would put auth redirects on a different origin from
 * the one GoTrue was configured with.
 */
const BASE_URL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.ts",

  /**
   * One shared Postgres, exactly as `vitest.integration.config.mts` reasons
   * about `fileParallelism: false`: concurrent specs mutate each other's
   * fixtures. Serialising costs seconds on a lane that is opt-in and local.
   *
   * The signup rate limit compounds it — `[auth.rate_limit] sign_in_sign_ups`
   * is 30 per 5 minutes per IP, shared with the integration lane, and parallel
   * workers would burn through it in bursts.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * The async half of the guard — is the local stack actually up? The
   * loopback check already ran at config load, above.
   */
  globalSetup: "./test/e2e/global-setup.ts",

  /**
   * No retries. A retry on a lane this slow hides flake instead of surfacing
   * it, and every spec here is meant to be deterministic against a seeded
   * corpus — a second attempt passing is information, not a green run.
   */
  retries: 0,

  /**
   * Fail the run if a spec ships with `test.only`. Local-only lanes are where
   * that survives a review; `forbidOnly` makes it survive nothing.
   */
  forbidOnly: true,

  reporter: [["list"]],

  use: {
    baseURL: BASE_URL,
    /**
     * Artifacts only when something went wrong. Both directories are
     * gitignored and Prettier-ignored.
     */
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    /**
     * Build AND start under the same env block. `NEXT_PUBLIC_*` are inlined
     * into the client bundle at **build** time, so overriding them for `start`
     * alone would serve a bundle pointing at whatever `.env.local` holds —
     * which in this repo is the linked **production** project. The browser
     * would then sign real accounts up on the live stack while `globalSetup`
     * reported "local" from a different file entirely.
     *
     * Next.js skips any variable already present in `process.env`, so these
     * win over `.env.local` rather than merging with it.
     */
    command: "npm run build && npm run start",
    url: BASE_URL,
    env: stackEnv,
    /**
     * Never reuse a server already on :3000. A `next dev` the developer left
     * running would be built from `.env.local` — production — and would look
     * like a working lane.
     */
    reuseExistingServer: false,
    /** A cold `next build` on this repo is slow; this survives it, not a hang. */
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
