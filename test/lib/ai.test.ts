import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the `vi.mock` factory below can see it — module-level consts are
// not visible inside hoisted factories.
const { generateText } = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  // Keep the real error classes: `enrich.ts` classifies failures with their
  // `isInstance` guards, so stubbing them would test nothing.
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText };
});

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: () => (modelId: string) => ({ modelId }),
}));

import { APICallError, TypeValidationError } from "ai";
import { enrichFromImage } from "@/lib/ai/enrich";
import { MAX_TAGS, MAX_TAG_LENGTH as MAX_TAG_CHARS } from "@/lib/artworks/tags";
import {
  MAX_GENERATED_TAGS,
  ModelOutputSchema,
  normalizeEnrichment,
} from "@/lib/ai/schema";
import { ARTWORK_TAGS, TAXONOMY_BY_FACET } from "@/lib/ai/taxonomy";

const DATA_URL = "data:image/jpeg;base64,AAAA";

const validOutput = {
  description: "A quiet study in ochre and dust.",
  tags: ["oil painting", "abstract", "landscape", "earth tones", "serene"],
};

const apiError = (statusCode: number) =>
  new APICallError({
    message: `status ${statusCode}`,
    url: "https://openrouter.ai",
    requestBodyValues: {},
    statusCode,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("taxonomy", () => {
  it("keeps every term within the per-tag storage limit", () => {
    const tooLong = ARTWORK_TAGS.filter((tag) => tag.length > MAX_TAG_CHARS);
    expect(tooLong).toEqual([]);
  });

  it("has no duplicate terms across facets", () => {
    expect(new Set(ARTWORK_TAGS).size).toBe(ARTWORK_TAGS.length);
  });

  it("uses only lowercase terms", () => {
    const notLower = ARTWORK_TAGS.filter((tag) => tag !== tag.toLowerCase());
    expect(notLower).toEqual([]);
  });

  it("offers more terms than a single artwork can hold", () => {
    expect(ARTWORK_TAGS.length).toBeGreaterThan(MAX_TAGS);
    expect(Object.keys(TAXONOMY_BY_FACET)).toHaveLength(5);
  });
});

describe("ModelOutputSchema", () => {
  it("accepts a well-formed response", () => {
    expect(ModelOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("rejects a tag outside the taxonomy", () => {
    const result = ModelOutputSchema.safeParse({
      ...validOutput,
      tags: [...validOutput.tags.slice(1), "warm ochre tones"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than the generated-tag ceiling", () => {
    const result = ModelOutputSchema.safeParse({
      ...validOutput,
      tags: ARTWORK_TAGS.slice(0, MAX_GENERATED_TAGS + 1),
    });

    expect(result.success).toBe(false);
  });

  it("rejects fewer than the generated-tag floor", () => {
    const result = ModelOutputSchema.safeParse({
      ...validOutput,
      tags: ["abstract", "serene"],
    });

    expect(result.success).toBe(false);
  });
});

describe("normalizeEnrichment", () => {
  it("trims the description and dedupes tags", () => {
    const normalized = normalizeEnrichment({
      description: "  spacious  ",
      tags: ["abstract", "abstract", "serene"],
    });

    expect(normalized.description).toBe("spacious");
    expect(normalized.tags).toEqual(["abstract", "serene"]);
  });
});

describe("enrichFromImage", () => {
  it("returns `unconfigured` without calling the model when no key is set", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: false, reason: "unconfigured" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("returns the normalized output on success", async () => {
    generateText.mockResolvedValue({ output: validOutput });

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: true, data: validOutput });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("advances to the next model on a rate limit", async () => {
    generateText
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce({ output: validOutput });

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: true, data: validOutput });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("reports `rate_limited` when every model is rate limited", async () => {
    generateText.mockRejectedValue(apiError(429));

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(generateText).toHaveBeenCalledTimes(3);
  });

  it("advances past an unavailable model", async () => {
    generateText
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce({ output: validOutput });

    const result = await enrichFromImage(DATA_URL);

    expect(result.ok).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it("does not advance on a schema failure", async () => {
    generateText.mockRejectedValue(
      new TypeValidationError({
        value: { tags: ["warm ochre tones"] },
        cause: new Error("off-taxonomy tag"),
      }),
    );

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: false, reason: "invalid_response" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("does not advance on a timeout", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    generateText.mockRejectedValue(timeout);

    const result = await enrichFromImage(DATA_URL);

    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("derives the media type from the data URL", async () => {
    generateText.mockResolvedValue({ output: validOutput });

    await enrichFromImage("data:image/png;base64,AAAA");

    const filePart = generateText.mock.calls[0][0].messages[0].content[1];
    expect(filePart).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
  });
});
