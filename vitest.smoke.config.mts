import { defineConfig } from "vitest/config";

/**
 * Opt-in config for the live smoke checks under `test/smoke/`.
 *
 * The default suite (`npm run test`) is deterministic and fully mocked — it
 * never reaches Supabase or a model, which is what lets CI run it. These
 * checks do the opposite: they call a real provider. Keeping them behind their
 * own config means they can never be picked up by `npm run test` or CI by
 * accident.
 *
 * Written standalone rather than via `mergeConfig`, because merging
 * concatenates `include` arrays — which would drag the whole mocked suite into
 * every smoke run.
 *
 * Run with `npm run test:smoke`.
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
    include: ["test/smoke/**/*.live.ts"],
  },
});
