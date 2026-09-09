/**
 * The controlled vocabulary generated tags are drawn from.
 *
 * Artist-typed tags stay free text; only AI-generated tags are restricted to
 * this list. The point is overlap: two artworks tagged "warm ochre tones" and
 * "warm palette" never match, but two tagged `warm palette` always do. Array
 * containment against the `artworks_tags_idx` GIN index is only as useful as
 * the vocabulary is shared.
 *
 * Facets are kept separate so the prompt can ask for coverage across all five
 * rather than five near-synonyms from one. Every term must be lowercase and 30
 * characters or fewer — see MAX_TAG_LENGTH in `@/lib/artworks/tags`.
 *
 * Deliberately free of "server-only": this is plain data, and the upload form
 * may want to show the vocabulary. Import it directly rather than via
 * `@/lib/ai`, whose index pulls in the server-only enrichment call.
 */

export const TAXONOMY_BY_FACET = {
  medium: [
    "oil painting",
    "acrylic",
    "watercolour",
    "gouache",
    "ink",
    "charcoal",
    "graphite",
    "pastel",
    "collage",
    "mixed media",
    "screenprint",
    "lithograph",
    "etching",
    "linocut",
    "digital painting",
    "photography",
    "sculpture",
    "ceramic",
    "textile",
    "mural",
  ],
  style: [
    "abstract",
    "figurative",
    "realism",
    "hyperrealism",
    "impressionist",
    "expressionist",
    "surrealist",
    "minimalist",
    "geometric",
    "cubist",
    "pop art",
    "folk art",
    "art nouveau",
    "art deco",
    "brutalist",
    "naive",
    "psychedelic",
    "street art",
    "illustrative",
    "gestural",
  ],
  subject: [
    "portrait",
    "self portrait",
    "figure study",
    "nude",
    "landscape",
    "seascape",
    "cityscape",
    "architecture",
    "still life",
    "botanical",
    "floral",
    "animal",
    "bird",
    "wildlife",
    "interior",
    "crowd",
    "machinery",
    "food",
    "celestial",
    "map",
  ],
  palette: [
    "monochrome",
    "black and white",
    "sepia",
    "warm palette",
    "cool palette",
    "pastel palette",
    "earth tones",
    "jewel tones",
    "neon",
    "high contrast",
    "muted",
    "desaturated",
    "vivid",
    "primary colours",
    "complementary",
    "gradient",
    "metallic",
    "red dominant",
    "blue dominant",
    "green dominant",
  ],
  mood: [
    "serene",
    "melancholic",
    "joyful",
    "dramatic",
    "tense",
    "dreamlike",
    "nostalgic",
    "playful",
    "solemn",
    "romantic",
    "eerie",
    "energetic",
    "contemplative",
    "chaotic",
    "intimate",
    "monumental",
    "whimsical",
    "brooding",
    "hopeful",
    "austere",
  ],
} as const;

export type Facet = keyof typeof TAXONOMY_BY_FACET;

export const FACETS = Object.keys(TAXONOMY_BY_FACET) as Facet[];

/**
 * Every term, flattened. Typed as a non-empty tuple so `z.enum` accepts it
 * directly and the resulting union is the literal vocabulary, not `string`.
 */
export const ARTWORK_TAGS = Object.values(
  TAXONOMY_BY_FACET,
).flat() as unknown as [string, ...string[]];

export type ArtworkTag = (typeof ARTWORK_TAGS)[number];

/** Renders the vocabulary for the prompt, one facet per line. */
export const taxonomyForPrompt = () =>
  FACETS.map(
    (facet) => `${facet}: ${TAXONOMY_BY_FACET[facet].join(", ")}`,
  ).join("\n");
