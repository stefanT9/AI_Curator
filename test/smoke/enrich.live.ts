/**
 * Live smoke check for the enrichment service — Phase 1 manual verification
 * steps 1.10 and 1.11.
 *
 * Deliberately named `.live.ts`, not `.test.ts`: the Vitest include pattern is
 * `test/**\/*.test.ts`, so this file is invisible to `npm run test` and to CI.
 * The automated suite stays deterministic and fully mocked; this is the opt-in
 * escape hatch for checking a real model.
 *
 * Run it:
 *
 *   SMOKE_IMAGE=./path/to/artwork.jpg npm run test:smoke
 *
 * With OPENROUTER_API_KEY set in .env.local it calls a real free model (1.10).
 * With the key empty it should report `unconfigured` and make no request (1.11).
 *
 * Always pass SMOKE_IMAGE. The built-in fallback is a 1x1 pixel — enough to
 * prove the request path works, but useless for judging tag quality or
 * latency, since image tokens dominate both.
 *
 * The result is written to test/smoke/.last-result.json (gitignored), because
 * Vitest swallows stdout for passing tests.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { expect, it } from "vitest";
import { enrichFromImage } from "@/lib/ai/enrich";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// A 1x1 PNG. Useless for tagging, but enough to prove the request path works
// when no real artwork is supplied.
const FALLBACK =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const loadImage = () => {
  const path = process.env.SMOKE_IMAGE;
  if (!path) return FALLBACK;

  const mediaType = MEDIA_TYPES[extname(path).toLowerCase()] ?? "image/jpeg";
  return `data:${mediaType};base64,${readFileSync(path).toString("base64")}`;
};

it(
  "enriches a real image through OpenRouter",
  { timeout: 60_000 },
  async () => {
    const hasKey = Boolean(process.env.OPENROUTER_API_KEY);
    console.log(
      `\nOPENROUTER_API_KEY: ${hasKey ? "set" : "absent"}` +
        `\nimage: ${process.env.SMOKE_IMAGE ?? "(1x1 placeholder — set SMOKE_IMAGE for a real check)"}\n`,
    );

    const startedAt = Date.now();
    const result = await enrichFromImage(loadImage());
    const elapsedMs = Date.now() - startedAt;

    // Vitest swallows stdout for passing tests, so write the result somewhere
    // readable. SMOKE_OUT overrides the default path.
    const outPath = process.env.SMOKE_OUT ?? "test/smoke/.last-result.json";
    writeFileSync(
      outPath,
      JSON.stringify(
        { elapsedMs, image: process.env.SMOKE_IMAGE ?? "placeholder", result },
        null,
        2,
      ),
    );
    console.log(`${elapsedMs}ms → ${outPath}`);

    if (!hasKey) {
      // Step 1.11: absent key short-circuits before any network call.
      expect(result).toEqual({ ok: false, reason: "unconfigured" });
      return;
    }

    // Step 1.10: a real call returns a description and 5-12 on-taxonomy tags.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.description.length).toBeGreaterThan(0);
      expect(result.data.tags.length).toBeGreaterThanOrEqual(1);
      expect(result.data.tags.length).toBeLessThanOrEqual(12);
    }
  },
);
