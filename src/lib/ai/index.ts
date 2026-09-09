/**
 * Public surface of the enrichment layer.
 *
 * Importing from here pulls in `enrich.ts`, which is "server-only". Client
 * components that just want the vocabulary should import `./taxonomy`
 * directly.
 */

export { enrichFromImage } from "./enrich";
export type { EnrichmentFailure, EnrichmentResult } from "./enrich";
export {
  MAX_GENERATED_TAGS,
  MIN_GENERATED_TAGS,
  normalizeEnrichment,
  ModelOutputSchema,
} from "./schema";
export type { Enrichment, ModelOutput } from "./schema";
export {
  ARTWORK_TAGS,
  FACETS,
  TAXONOMY_BY_FACET,
  taxonomyForPrompt,
} from "./taxonomy";
export type { ArtworkTag, Facet } from "./taxonomy";
