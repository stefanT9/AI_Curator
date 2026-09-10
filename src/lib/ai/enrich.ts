import "server-only";

import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  TypeValidationError,
  generateText,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  ModelOutputSchema,
  normalizeEnrichment,
  type Enrichment,
} from "./schema";
import { taxonomyForPrompt } from "./taxonomy";

/**
 * The one place in the app that talks to a model.
 *
 * Never throws. Callers decide whether a failure is worth surfacing (the
 * upload form shows it) or swallowing (publish-time top-up ignores it), so the
 * failure mode is data, not an exception.
 */

/**
 * Free vision models that advertise structured output support, ordered by
 * measured latency rather than catalogue position. Verified against
 * https://openrouter.ai/api/v1/models on 2026-09-09; timings from three runs
 * each of this exact request shape on the same date:
 *
 *   mini  1.5-3.2s   ← comfortably inside the budget
 *   dots  6.2-11.1s
 *   pro   9.1-10.5s  ← alone eats most of a 12s budget
 *
 * `pro` is the strongest model but consistently too slow to lead. The free
 * roster churns — if every model here 404s, re-check the catalogue and
 * re-measure before reordering.
 */
const MODELS = [
  "nex-agi/nex-n2.5-mini:free",
  "dots-studio/dots-3-note-preview:free",
  "nex-agi/nex-n2.5-pro:free",
] as const;

/**
 * The SDK retries failed calls twice by default. Those retries would nest
 * inside our shared timeout — three attempts at a 10s model would blow the
 * budget before the chain ever reached a second model. Model-level fallback is
 * our retry strategy, so the per-call one is switched off.
 */
const MAX_RETRIES = 0;

/**
 * One budget for the whole fallback chain, not per attempt — a per-attempt
 * timeout would let three models run for three times as long.
 *
 * Planned at 12s, raised to 25s after live measurement: roughly one call in
 * three still timed out at 12s even with the chain reordered and the SDK's own
 * retries disabled, because free-tier latency is highly variable. A timeout is
 * non-blocking by design — the field shows a recoverable error and the artist
 * types manually — so a longer ceiling costs a slower worst case, never a
 * blocked publish.
 */
const TIMEOUT_MS = 25_000;

export type EnrichmentFailure =
  | "unconfigured"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid_response";

export type EnrichmentResult =
  { ok: true; data: Enrichment } | { ok: false; reason: EnrichmentFailure };

const PROMPT = `You are tagging an artwork for a gallery catalogue.

Write a short description of the piece — one paragraph, in the register an artist would use for their own work. No preamble, no "this image shows", no mention of being an AI or of the image itself.

Then choose descriptive tags. Use ONLY terms from this vocabulary, exactly as spelled:

${taxonomyForPrompt()}

Spread the tags across the facets rather than picking several near-synonyms from one. Prefer what is clearly true of the piece over what is merely plausible.`;

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Works for both accepted inputs: `data:image/jpeg;base64,...` carries its own
 * type, while an `https://…/piece.png` is typed from its extension. Getting
 * this wrong is not cosmetic — a PNG announced as JPEG is rejected by some
 * providers outright.
 */
const mediaTypeOf = (source: string) => {
  const fromDataUrl = source.match(/^data:([^;,]+)[;,]/)?.[1];
  if (fromDataUrl) return fromDataUrl;

  const extension = source.split("?")[0].split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_MEDIA_TYPES[extension]) || "image/jpeg";
};

/**
 * Map a thrown error onto a failure reason. Schema failures are the model
 * misbehaving in a way another model will likely repeat, so they are terminal;
 * rate limits and outages are worth retrying elsewhere in the chain.
 */
const classify = (error: unknown): EnrichmentFailure => {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof DOMException && error.name === "AbortError")
    return "timeout";

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 429) return "rate_limited";
    return "unavailable";
  }

  if (
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  ) {
    return "invalid_response";
  }

  return "unavailable";
};

/** Reasons that mean "stop now" rather than "try the next model". */
const isTerminal = (reason: EnrichmentFailure) =>
  reason === "timeout" || reason === "invalid_response";

/**
 * @param source a `data:image/...;base64,...` URL, or an https URL the model
 * provider can fetch. The upload form sends a downscaled data URL; the
 * publish-time top-up sends the public Storage URL of the uploaded piece.
 */
export async function enrichFromImage(
  source: string,
): Promise<EnrichmentResult> {
  // Read lazily, never at module scope: `next build` imports this file and CI
  // has no key. An unset key must degrade at call time, not break the build.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "unconfigured" };

  const openrouter = createOpenRouter({ apiKey });
  const abortSignal = AbortSignal.timeout(TIMEOUT_MS);

  let lastReason: EnrichmentFailure = "unavailable";

  for (const modelId of MODELS) {
    try {
      const { output } = await generateText({
        model: openrouter(modelId),
        abortSignal,
        maxRetries: MAX_RETRIES,
        output: Output.object({ schema: ModelOutputSchema }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              {
                type: "file",
                data: source,
                mediaType: mediaTypeOf(source),
              },
            ],
          },
        ],
      });

      return { ok: true, data: normalizeEnrichment(output) };
    } catch (error) {
      const reason = classify(error);
      if (isTerminal(reason)) return { ok: false, reason };
      lastReason = reason;
    }
  }

  return { ok: false, reason: lastReason };
}
