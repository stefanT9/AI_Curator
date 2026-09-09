/**
 * The JSON contract the model must satisfy.
 *
 * Two schemas, deliberately. `ModelOutputSchema` is what gets handed to the AI
 * SDK and converted to JSON Schema for the provider, so it stays plain — no
 * transforms, which do not survive that conversion. `normalizeEnrichment`
 * applies the tidying (trim, dedupe) afterwards, in ordinary TypeScript.
 */

import * as z from "zod";
import { ARTWORK_TAGS } from "./taxonomy";

/** Mirrors `artworks_description_length` — description is null or <= 2000. */
export const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Generated tags cap below the 20-tag storage ceiling so an artist's own tags
 * survive the publish-time merge instead of being crowded out.
 */
export const MIN_GENERATED_TAGS = 5;
export const MAX_GENERATED_TAGS = 12;

const TagEnum = z.enum(ARTWORK_TAGS);

export const ModelOutputSchema = z.object({
  description: z
    .string()
    .max(MAX_DESCRIPTION_LENGTH)
    .describe(
      "A short paragraph describing the artwork, in the register an artist would use for their own piece.",
    ),
  tags: z
    .array(TagEnum)
    .min(MIN_GENERATED_TAGS)
    .max(MAX_GENERATED_TAGS)
    .describe(
      "Descriptive tags chosen only from the supplied vocabulary, spread across the facets.",
    ),
});

export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export type Enrichment = {
  description: string;
  tags: string[];
};

/**
 * Tidy what the model returned. Runs after validation, so the shape is already
 * known good; this only trims and dedupes.
 *
 * Deduping can drop the count below MIN_GENERATED_TAGS — that is accepted. A
 * short-but-valid tag set is more useful than a rejected response, and the
 * publish-time top-up treats it as it would any other partial result.
 */
export const normalizeEnrichment = (output: ModelOutput): Enrichment => ({
  description: output.description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
  tags: Array.from(new Set(output.tags.map((tag) => tag.trim().toLowerCase()))),
});
