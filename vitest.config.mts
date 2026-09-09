import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve the `@/*` paths from tsconfig.json.
    tsconfigPaths: true,
    alias: {
      // `import "server-only"` throws outside an RSC bundle. Neutralise it so
      // `src/lib/**` modules can be unit-tested in Node.
      "server-only": new URL("./test/stubs/server-only.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    // These smoke tests exercise Server Actions and `src/lib` helpers — plain
    // Node code. No jsdom; component tests would need their own environment.
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Placeholder values so modules that read them at import time don't blow up.
    // No test talks to a real Supabase project.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://smoke-test.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_smoke_test",
    },
  },
});
