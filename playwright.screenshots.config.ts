import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { requireLocalStack } from "./test/integration/setup";

/**
 * Opt-in config for the documentation capture under `test/screenshots/`.
 *
 * **This is not a test lane.** Nothing here asserts anything about the product;
 * it drives the real app through its real flows and writes PNGs into
 * `docs/screenshots/` for the README. It is separated from `playwright.config.ts`
 * for the same reason the four test lanes are separated from each other: its
 * `**\/*.shot.ts` glob is disjoint from `test/e2e/**\/*.spec.ts`,
 * `test/**\/*.test.ts`, `test/integration/**\/*.int.ts` and
 * `test/smoke/**\/*.live.ts`, so `npm run test:e2e` still runs exactly one test
 * — the one risk it exists for — and can never pick this up.
 *
 * Run with `npm run docs:screenshots`, after the same prerequisites the browser
 * lane needs (local stack, seeded corpus, `npx playwright install chromium`).
 * Never in CI.
 */

/** Same credential source as the browser and integration lanes. */
try {
  process.loadEnvFile(".env.test.local");
} catch (cause) {
  if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
}

/**
 * The loopback guard, at module scope for the reason `playwright.config.ts`
 * spells out: Playwright boots `webServer` before `globalSetup`, so a guard in
 * the hook would fire after a full production build had already completed
 * against whatever credentials were in scope. This capture signs users up and
 * uploads an image — exactly the hazard.
 */
const stack = requireLocalStack();

/**
 * One optional variable lifted out of `.env.local`, by name, and nothing else.
 *
 * `.env.local` also holds `NEXT_PUBLIC_SUPABASE_*` pointing at whatever project
 * the developer is linked to, so it is deliberately **not** loaded with
 * `loadEnvFile` — the Supabase pair must keep coming from the vetted, guarded
 * values above. This reads the one key the upload screenshot benefits from and
 * leaves every other line in that file alone.
 *
 * Absent, the capture still works: `enrichFromImage` degrades to unavailable
 * and the upload form screenshot simply shows no suggestions.
 */
const readFromEnvLocal = (name: string): string | undefined => {
  try {
    const line = readFileSync(".env.local", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim();
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const openRouterKey = readFromEnvLocal("OPENROUTER_API_KEY");

/**
 * A throwaway signing secret, generated per run and shared with the capture
 * through `process.env`.
 *
 * The unsubscribe page renders its real state only for a token that verifies,
 * and `verifyUnsubscribeToken` performs no database lookup — so a token this
 * secret signs over any uuid is enough to photograph the page. Generating one
 * rather than reading the developer's real `UNSUBSCRIBE_TOKEN_SECRET` keeps a
 * secret that can mint an unsubscribe token for **any** user, forever, out of a
 * documentation script.
 */
const unsubscribeSecret = randomBytes(32).toString("hex");
process.env.SHOT_UNSUBSCRIBE_TOKEN_SECRET = unsubscribeSecret;

const BASE_URL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "test/screenshots",
  testMatch: "**/*.shot.ts",

  /** One shared Postgres, and the capture's steps depend on each other. */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,

  /** The same health probe the browser lane uses, not a second copy of it. */
  globalSetup: "./test/e2e/global-setup.ts",

  /** A whole tour through a real app over a real Postgres. */
  timeout: 300_000,

  reporter: [["list"]],

  use: {
    baseURL: BASE_URL,
    /**
     * A fixed frame, so the shots sit together in the README without each one
     * being a different shape. `deviceScaleFactor: 2` keeps text crisp on the
     * displays people actually read GitHub on.
     */
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    trace: "retain-on-failure",
    screenshot: "off",
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
     * Build and start under one env block — `NEXT_PUBLIC_*` are inlined at
     * build time, so overriding them for `start` alone would serve a client
     * bundle built against `.env.local`. See `playwright.config.ts`.
     */
    command: "npm run build && npm run start",
    url: BASE_URL,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: stack.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.anonKey,
      UNSUBSCRIBE_TOKEN_SECRET: unsubscribeSecret,
      ...(openRouterKey ? { OPENROUTER_API_KEY: openRouterKey } : {}),
    },
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
