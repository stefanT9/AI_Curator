/**
 * Builds the local ranking-evaluation corpus from the Art Institute of Chicago's
 * public-domain collection.
 *
 * Four stages over one file, `supabase/seed-assets/corpus.json`:
 *
 *   fetch     network  → manifest + gitignored JPEGs
 *   enrich    images   → manifest (style / mood / description)
 *   coverage  manifest → onboarding style-term report
 *   generate  manifest → the generated region of `supabase/seed.sql`
 *
 * The manifest is the source of truth and the unit of review. Every later stage
 * reads and writes it, so a failure halfway leaves usable progress, and a
 * regeneration months from now reads the manifest rather than the network —
 * determinism survives AIC re-indexing or a model being retired.
 *
 * Run through the npm scripts, never with bare `node`:
 *
 *   npm run db:seed:fetch            sample and download
 *   npm run db:seed:enrich           enrich, resuming where the last run stopped
 *   npm run db:seed:enrich:resume    the same thing, named for what it does
 *   npm run db:seed:enrich:retry     reopen pieces pinned as failed
 *
 * `enrich` resumes by default and is safe to re-run: a piece is done once it
 * carries a `tags_from_enrichment` field, so a re-run over a finished manifest
 * makes no model calls at all. `--limit N` bounds one run; `--retry-failed`
 * reopens pinned failures, which resume alone deliberately never does.
 *
 * which is `tsx --conditions=react-server`. Both halves are load-bearing. `tsx`
 * resolves the extensionless relative imports inside `src/lib/**` that Node ESM
 * rejects, and `--conditions=react-server` maps `import "server-only"` onto its
 * empty stub instead of the bare `throw` its default export is.
 *
 * LOCAL DEVELOPMENT ONLY. This writes seed data for `supabase db reset`.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod";
import { enrichFromImage, type EnrichmentFailure } from "@/lib/ai";
import { FACETS, TAXONOMY_BY_FACET, type Facet } from "@/lib/ai/taxonomy";
import { MAX_TAGS } from "@/lib/artworks/tags";

// ---------------------------------------------------------------------------
// Source and layout
// ---------------------------------------------------------------------------

const AIC_API = "https://api.artic.edu/api/v1";

/** From the API's own `config.iiif_url`. Pinned so the manifest records it. */
const IIIF_BASE = "https://www.artic.edu/iiif/2";

/**
 * IIIF sizes server-side, so there is no local resize step and no image
 * dependency — the JPEG arrives ready to upload. This is a ceiling, not a
 * demand: AIC's image server refuses any request that would scale a source
 * above 100% ("Requests for scales in excess of 100% are not allowed", 403),
 * and part of the collection is digitised narrower than this. `thumbnail.width`
 * is the source width, so the request is capped at it.
 */
const IIIF_MAX_WIDTH = 843;

/**
 * The IIIF image server answers `403 text/html` to a request without a
 * `User-Agent`; the JSON API answers a bare request fine. `AIC-User-Agent` is
 * AIC's documented courtesy header identifying the application.
 */
const REQUEST_HEADERS = {
  "User-Agent": "ArtSwipe/0.1 (local seed corpus builder)",
  "AIC-User-Agent": "ArtSwipe local seed corpus builder (development only)",
};

/**
 * The seeded artist owns every corpus piece, and `image_path_pattern`
 * (`supabase/migrations/20260910000100_constrain_artwork_image_path.sql`)
 * requires `<artist_id>/<uuid>.<ext>` — so the asset directory is named after
 * this UUID and `db:seed:images` uploads it to exactly the referenced key.
 */
const ARTIST_UUID = "00000000-0000-4000-8000-000000000001";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SEED_ASSETS = path.join(REPO_ROOT, "supabase", "seed-assets");
const ASSET_DIR = path.join(SEED_ASSETS, ARTIST_UUID);
const MANIFEST_PATH = path.join(SEED_ASSETS, "corpus.json");

/** Mirrors `artworks_title_length` — 1 to 120 characters. */
const MAX_TITLE_LENGTH = 120;

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * AIC's `classification_titles` families, with the spelling the index actually
 * uses — `ceramics`, not `ceramic`. Counts are public-domain works with an
 * image, measured 2026-09-10: painting 1883, print 24740, drawing 31,
 * photograph 3776, textile 6833, ceramics 4663, sculpture 2053.
 *
 * `drawing` is thin at 31 and is kept anyway: it is the only family that
 * reaches the graphite / charcoal / pastel end of the medium facet.
 */
const FAMILIES = [
  "painting",
  "print",
  "drawing",
  "photograph",
  "textile",
  "ceramics",
  "sculpture",
] as const;

/**
 * Total pieces. Far above the 20-card deck S-02 refills, and large enough that
 * the emergent tag distribution is a real distribution rather than a handful of
 * examples per term.
 *
 * Families cannot simply split this evenly: `drawing` holds 31 pieces in total.
 * Targets are therefore allocated by `allocate`, which caps each family at what
 * it actually has and redistributes the shortfall across the families that have
 * room.
 */
const TARGET_TOTAL = 1000;

/**
 * AIC refuses any request whose offset exceeds 1000 (verified: page 10 at
 * limit 100 is 200, page 11 is 403), so a family of 24,740 prints cannot be
 * paged through. Sampling instead partitions each family by accession id and
 * takes the head of each partition, which reaches the whole id range —
 * 1 to 286,196 across the 59,051 public-domain works with images — using one
 * shallow request per bucket.
 */
const ID_BUCKETS: readonly (readonly [number, number])[] = [
  [0, 25_000],
  [25_000, 50_000],
  [50_000, 90_000],
  [90_000, 140_000],
  [140_000, 200_000],
  [200_000, 300_000],
];

/**
 * Candidate depth per (family, bucket) before the even-spaced pick.
 *
 * AIC caps `limit` at 100 and refuses any offset above 1000, so one bucket can
 * yield at most 10 pages. Three is enough headroom for a 1000-piece corpus
 * (7 families x 6 buckets x 300 = 12,600 candidates) while keeping the sampling
 * run to ~126 requests against a free, unauthenticated API.
 */
const PAGE_SIZE = 100;
const PAGES_PER_BUCKET = 3;

/** Parallel image downloads. Courtesy to a free, unauthenticated API. */
const DOWNLOAD_CONCURRENCY = 6;

/** Progress every N images, so a ~1000-image run is not a silent 15 minutes. */
const PROGRESS_EVERY = 50;

const AIC_FIELDS = [
  "id",
  "title",
  "artist_title",
  "image_id",
  "classification_titles",
  "subject_titles",
  "medium_display",
  "color",
  "thumbnail",
].join(",");

// ---------------------------------------------------------------------------
// Metadata → vocabulary
//
// Three mappers, each emitting only terms from its own facet in
// `src/lib/ai/taxonomy.ts`. Museum metadata knows medium, subject and palette;
// it does not know style or mood — `style_titles` carries art-historical period
// and culture labels (`Post-Impressionism`, `chola`, `19th century`), which is
// why those two facets come from enrichment in the next stage.
//
// Gaps are left as gaps. AIC's two largest print classifications, `engraving`
// and `woodblock print`, have no counterpart in the medium facet, and inventing
// one ("engraving is basically etching") would put a false tag on a real
// artwork. A piece with no medium tag still carries subject, palette, style and
// mood.
// ---------------------------------------------------------------------------

/**
 * Substring, not equality: AIC medium strings are long and compound —
 * "etching and engraving in brown on ivory laid paper". Longest key wins so
 * "oil on canvas" is not shadowed by a shorter one. Every value is asserted to
 * be a member of its facet before it reaches the manifest.
 */
const MEDIUM_SYNONYMS: Record<string, string> = {
  "oil on canvas": "oil painting",
  "oil on panel": "oil painting",
  "oil paintings": "oil painting",
  "oil painting": "oil painting",
  tempera: "oil painting",
  acrylic: "acrylic",
  watercolor: "watercolour",
  watercolour: "watercolour",
  gouache: "gouache",
  "ink on paper": "ink",
  "ink and color": "ink",
  charcoal: "charcoal",
  graphite: "graphite",
  pencil: "graphite",
  pastel: "pastel",
  collage: "collage",
  "mixed media": "mixed media",
  screenprint: "screenprint",
  silkscreen: "screenprint",
  serigraph: "screenprint",
  lithograph: "lithograph",
  etching: "etching",
  linocut: "linocut",
  "linoleum cut": "linocut",
  photograph: "photography",
  photography: "photography",
  "photographic process": "photography",
  "photomechanical process": "photography",
  "albumen print": "photography",
  "albumen silver print": "photography",
  "gelatin silver": "photography",
  "salted paper print": "photography",
  daguerreotype: "photography",
  photogravure: "photography",
  woodburytype: "photography",
  sculpture: "sculpture",
  statuette: "sculpture",
  bronze: "sculpture",
  marble: "sculpture",
  limestone: "sculpture",
  ceramics: "ceramic",
  ceramic: "ceramic",
  earthenware: "ceramic",
  stoneware: "ceramic",
  porcelain: "ceramic",
  terracotta: "ceramic",
  faience: "ceramic",
  faïence: "ceramic",
  maiolica: "ceramic",
  textile: "textile",
  weaving: "textile",
  costume: "textile",
  embroidery: "textile",
  needlework: "textile",
  lace: "textile",
  quilt: "textile",
  bedcover: "textile",
  "plain weave": "textile",
  mural: "mural",
  fresco: "mural",
};

/**
 * Equality against a lowercased `subject_titles` entry — these are controlled
 * AIC terms, not free prose, so exact match is the honest test. Plurals and
 * AIC's own typo (`architechture`) are listed rather than stemmed.
 */
const SUBJECT_SYNONYMS: Record<string, string> = {
  portrait: "portrait",
  portraits: "portrait",
  "portraits: male subject": "portrait",
  "portraits: female subject": "portrait",
  busts: "portrait",
  bust: "portrait",
  "self-portrait": "self portrait",
  "self-portraits": "self portrait",
  figure: "figure study",
  figures: "figure study",
  nude: "nude",
  nudes: "nude",
  landscape: "landscape",
  landscapes: "landscape",
  "rural life": "landscape",
  hills: "landscape",
  seascape: "seascape",
  seascapes: "seascape",
  ocean: "seascape",
  cityscape: "cityscape",
  cityscapes: "cityscape",
  streets: "cityscape",
  architecture: "architecture",
  architectural: "architecture",
  architechture: "architecture",
  "architectural fragment": "architecture",
  "architectural fragments": "architecture",
  building: "architecture",
  buildings: "architecture",
  churches: "architecture",
  cathedrals: "architecture",
  ruins: "architecture",
  "still life": "still life",
  "still lifes": "still life",
  botanical: "botanical",
  plants: "botanical",
  foliage: "botanical",
  trees: "botanical",
  flowers: "floral",
  "floral motifs": "floral",
  wreaths: "floral",
  animal: "animal",
  animals: "animal",
  horse: "animal",
  horses: "animal",
  dog: "animal",
  dogs: "animal",
  cows: "animal",
  sheep: "animal",
  donkeys: "animal",
  monkeys: "animal",
  lions: "animal",
  bird: "bird",
  birds: "bird",
  wildlife: "wildlife",
  interior: "interior",
  interiors: "interior",
  crowd: "crowd",
  crowds: "crowd",
  people: "crowd",
  machinery: "machinery",
  machines: "machinery",
  food: "food",
  fruit: "food",
  celestial: "celestial",
  stars: "celestial",
  moon: "celestial",
  comets: "celestial",
  map: "map",
  maps: "map",
};

/**
 * Thresholds for the palette facet, kept as one named block rather than
 * scattered literals. AIC's `color` is the single dominant colour of the image
 * as HSL: `h` 0-360, `s` and `l` 0-100.
 *
 * Saturation is read first because it decides whether hue means anything at
 * all — the hue of a 4%-saturated grey is noise, so a hue term is only emitted
 * above `HUE_MIN_SATURATION`.
 */
const PALETTE = {
  MONOCHROME_MAX_SATURATION: 8,
  DESATURATED_MAX_SATURATION: 25,
  MUTED_MAX_SATURATION: 50,
  /** Below this a hue reading is noise, not a colour cast. */
  HUE_MIN_SATURATION: 25,
  /** A near-grey that is also very dark or very light reads black and white. */
  BW_MAX_LIGHTNESS: 25,
  BW_MIN_LIGHTNESS: 75,
  HUE_RANGES: [
    { term: "red dominant", from: 330, to: 360 },
    { term: "red dominant", from: 0, to: 30 },
    { term: "green dominant", from: 75, to: 170 },
    { term: "blue dominant", from: 170, to: 260 },
  ],
} as const;

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

export type CorpusPiece = {
  aic_id: number;
  image_id: string;
  piece_uuid: string;
  title: string;
  artist: string | null;
  tags_from_metadata: string[];
  /** The IIIF width actually requested, pinned so a re-download needs no API call. */
  image_width: number;
  /** The deterministic-shuffle rank that becomes the `created_at` offset. */
  slot: number;
  /**
   * Style and mood terms from the enrichment stage. Written once and pinned:
   * its presence — empty array included — is what marks a piece as enriched, so
   * a re-run makes no model call. A piece that has never been through the
   * `enrich` stage has this field absent, not empty.
   */
  tags_from_enrichment?: string[];
  /** The model's own description, or null when enrichment failed. */
  description?: string | null;
  /**
   * Why enrichment produced nothing, present only on failure. Pinned alongside
   * an empty `tags_from_enrichment` so a failure is a recorded outcome rather
   * than an absence indistinguishable from "not yet run".
   */
  enrichment_failed?: EnrichmentFailure;
};

export type CorpusManifest = {
  version: number;
  source: {
    api: string;
    iiif_url: string;
    licence: string;
    query: string;
    sampled_at: string;
  };
  pieces: CorpusPiece[];
};

const MANIFEST_VERSION = 1;

const LICENCE =
  "All fields CC0 1.0 except `description`, which is CC-BY 4.0 and is never copied into this corpus. https://www.artic.edu/open-access/public-api";

const SAMPLING_QUERY = `is_public_domain AND image_id exists AND classification_titles in (${FAMILIES.join(", ")}), partitioned by accession id into ${ID_BUCKETS.length} buckets, ${TARGET_TOTAL} pieces allocated across families by availability`;

// ---------------------------------------------------------------------------
// Pure helpers — exported for `test/build-corpus.test.ts`
// ---------------------------------------------------------------------------

const facetTerms = (facet: Facet): readonly string[] =>
  TAXONOMY_BY_FACET[facet];

/**
 * The vocabulary assertion. A synonym table pointing at a term that has since
 * left `taxonomy.ts` must break the build loudly, not quietly produce a tag no
 * query can ever match.
 */
export function assertFacetMember(term: string, facet: Facet): string {
  if (!facetTerms(facet).includes(term)) {
    throw new Error(
      `"${term}" is not a member of the ${facet} facet in src/lib/ai/taxonomy.ts`,
    );
  }
  return term;
}

/**
 * The AIC boundary, validated rather than asserted.
 *
 * `paletteTags` does arithmetic on `color.h/s/l`, so a cast is the wrong tool:
 * if AIC ever returns those as strings, a cast produces silently wrong tags on
 * every piece, while a parse fails loudly. Per AGENTS.md, external input is
 * validated with Zod at the boundary.
 *
 * Unknown keys are dropped deliberately here — AIC sends fields this script has
 * no use for (`percentage`, `population`, `_score`), and none of them reach the
 * manifest. The manifest schema below is the opposite case.
 */
const AicColorSchema = z.object({
  h: z.number(),
  s: z.number(),
  l: z.number(),
});

const AicArtworkSchema = z.object({
  id: z.number(),
  title: z.string().nullish(),
  artist_title: z.string().nullish(),
  image_id: z.string().nullish(),
  classification_titles: z.array(z.string()).nullish(),
  subject_titles: z.array(z.string()).nullish(),
  medium_display: z.string().nullish(),
  color: AicColorSchema.nullish(),
  thumbnail: z.object({ width: z.number().nullish() }).nullish(),
});

export type AicColor = z.infer<typeof AicColorSchema> | null | undefined;
export type AicArtwork = z.infer<typeof AicArtworkSchema>;

/**
 * Longest key first, so "oil on canvas" wins over a shorter key that also
 * matches. Matching is substring because AIC medium strings are compound
 * prose; classification titles are matched by the same table since they carry
 * the same words in shorter form.
 */
const MEDIUM_KEYS = Object.keys(MEDIUM_SYNONYMS).sort(
  (a, b) => b.length - a.length,
);

export function mediumTags(artwork: AicArtwork): string[] {
  const haystack = [
    ...(artwork.classification_titles ?? []),
    artwork.medium_display ?? "",
  ]
    .join(" | ")
    .toLowerCase();

  const found = new Set<string>();
  for (const key of MEDIUM_KEYS) {
    if (haystack.includes(key)) found.add(MEDIUM_SYNONYMS[key]);
  }

  return [...found].map((term) => assertFacetMember(term, "medium"));
}

export function subjectTags(artwork: AicArtwork): string[] {
  const found = new Set<string>();
  for (const raw of artwork.subject_titles ?? []) {
    const term = SUBJECT_SYNONYMS[raw.trim().toLowerCase()];
    if (term) found.add(term);
  }

  return [...found].map((term) => assertFacetMember(term, "subject"));
}

export function paletteTags(color: AicColor): string[] {
  if (!color) return [];

  const { h, s, l } = color;
  const found = new Set<string>();

  if (s <= PALETTE.MONOCHROME_MAX_SATURATION) {
    found.add("monochrome");
    if (l <= PALETTE.BW_MAX_LIGHTNESS || l >= PALETTE.BW_MIN_LIGHTNESS) {
      found.add("black and white");
    }
  } else if (s <= PALETTE.DESATURATED_MAX_SATURATION) {
    found.add("desaturated");
  } else if (s <= PALETTE.MUTED_MAX_SATURATION) {
    found.add("muted");
  } else {
    found.add("vivid");
  }

  if (s >= PALETTE.HUE_MIN_SATURATION) {
    const hue = ((h % 360) + 360) % 360;
    for (const range of PALETTE.HUE_RANGES) {
      if (hue >= range.from && hue < range.to) found.add(range.term);
    }
  }

  return [...found].map((term) => assertFacetMember(term, "palette"));
}

/**
 * AIC titles run long — plate captions quote whole lines of dialogue — and
 * `artworks_title_length` caps at 120. Truncates on a word boundary so the
 * result reads as a title rather than a severed string.
 */
export function truncateTitle(title: string, max = MAX_TITLE_LENGTH): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  const head = clean.slice(0, max - 1);
  const lastSpace = head.lastIndexOf(" ");
  const body = lastSpace > max / 2 ? head.slice(0, lastSpace) : head;

  return `${body.replace(/[\s.,;:]+$/, "")}…`;
}

/**
 * A UUID derived from the AIC object id rather than drawn at random, so a
 * corpus rebuilt from scratch lands on the same row ids and the same image
 * filenames as the committed manifest. Shaped as a v4 UUID because
 * `image_path_pattern` and the `uuid` column only care about the shape.
 */
export function pieceUuid(aicId: number): string {
  const hex = createHash("sha256")
    .update(`artswipe-corpus:aic:${aicId}`)
    .digest("hex");

  const version = "4";
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version + hex.slice(13, 16),
    variant + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The deterministic shuffle behind `created_at`. Ordering slots by anything
 * correlated with tags — insertion order, family, accession id — would make a
 * broken newest-first ranking look correct, because the groups would already
 * be contiguous. Sorting by the piece UUID, a hash of the object id, decouples
 * slot order from every other property while staying reproducible.
 */
export function assignSlots(pieces: CorpusPiece[]): void {
  const order = [...pieces].sort((a, b) =>
    a.piece_uuid.localeCompare(b.piece_uuid),
  );
  order.forEach((piece, index) => {
    piece.slot = index;
  });
}

/** Evenly spaced pick, always including the first element. */
export function pickEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];

  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

/**
 * Split `total` across buckets that each hold at most `available[i]`.
 *
 * An even split is wrong here: AIC's `drawing` classification holds 31
 * public-domain works while `print` holds 24,740, so a flat share would either
 * cap the whole corpus at 7 x 31 or silently return a short family. Each round
 * offers an equal share to every bucket with room left and hands the remainder
 * to the next round, so small buckets fill up and large ones absorb what they
 * could not take.
 *
 * Terminates because every round with `total` left gives at least one unit away.
 */
export function allocate(available: number[], total: number): number[] {
  const out = available.map(() => 0);
  const capacity = available.reduce((sum, n) => sum + n, 0);
  let remaining = Math.min(total, capacity);

  while (remaining > 0) {
    const withRoom = available
      .map((_, i) => i)
      .filter((i) => out[i] < available[i]);
    if (withRoom.length === 0) break;

    const share = Math.max(1, Math.floor(remaining / withRoom.length));
    for (const i of withRoom) {
      if (remaining === 0) break;
      const give = Math.min(share, available[i] - out[i], remaining);
      out[i] += give;
      remaining -= give;
    }
  }

  return out;
}

/**
 * The two facets enrichment is asked for. Museum metadata supplies the other
 * three, and it supplies them better — `classification_titles` knows the piece
 * is a lithograph, a model looking at a photograph of one is guessing. So the
 * model's medium / subject / palette terms are discarded rather than merged.
 */
const ENRICHED_FACETS: readonly Facet[] = ["style", "mood"];

/** Which facet a term belongs to, or `null` for a term outside the taxonomy. */
export function facetOf(term: string): Facet | null {
  return FACETS.find((facet) => facetTerms(facet).includes(term)) ?? null;
}

/**
 * Keep only what the enrich stage asked the model for.
 *
 * The prompt asks for tags across all five facets and there is no way to ask
 * for two, so the filtering happens here. A term outside the taxonomy cannot
 * occur — `ModelOutputSchema` validates against `ARTWORK_TAGS` — but it is
 * dropped rather than trusted, because this function is also the boundary a
 * hand-edited manifest crosses.
 */
export function enrichedTags(tags: readonly string[]): string[] {
  return tags.filter((tag) => {
    const facet = facetOf(tag);
    return facet !== null && ENRICHED_FACETS.includes(facet);
  });
}

/**
 * Merge the museum's tags with the model's into the array that reaches the
 * database, within `artworks_tags_length`.
 *
 * Under the ceiling this is a plain deduplicated concatenation. Over it, the
 * trim is round-robin across the facets rather than a truncation of the
 * concatenation — and that distinction is the whole point of the function.
 * Metadata leads the concatenation and is medium/subject/palette-heavy, so a
 * flat `slice(0, 20)` would drop mood first and completely: it is the facet
 * with the fewest terms per piece and it sits last. Round-robin costs each
 * facet its own tail instead, so an over-full piece stays spread across five
 * facets — which is what makes `.overlaps("tags", terms)` match on more than
 * one axis. A term outside the taxonomy cannot arrive from this pipeline (both
 * sources are vocabulary-constrained) but is given a bucket of its own, so a
 * hand-edited manifest keeps it rather than losing it without a word.
 */
export function combineTags(
  fromMetadata: readonly string[],
  fromEnrichment: readonly string[],
  max = MAX_TAGS,
): string[] {
  const deduped = Array.from(new Set([...fromMetadata, ...fromEnrichment]));
  if (deduped.length <= max) return deduped;

  // Facet order follows `FACETS`, with a trailing bucket for anything outside
  // the taxonomy so it takes a turn rather than silently vanishing.
  const buckets = new Map<Facet | "other", string[]>();
  for (const facet of FACETS) buckets.set(facet, []);
  buckets.set("other", []);
  for (const tag of deduped) buckets.get(facetOf(tag) ?? "other")!.push(tag);

  const out: string[] = [];
  const lists = [...buckets.values()];
  for (let round = 0; out.length < max; round += 1) {
    let took = 0;
    for (const list of lists) {
      if (out.length === max) break;
      if (round < list.length) {
        out.push(list[round]);
        took += 1;
      }
    }
    // Cannot happen while `deduped.length > max`, but a round that takes
    // nothing would otherwise spin forever.
    if (took === 0) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Manifest IO
// ---------------------------------------------------------------------------

/**
 * Write through a temporary file and rename into place.
 *
 * `rename` is atomic within a filesystem, so an interrupted run leaves either
 * the old file or the new one — never a truncated one. Without it, Ctrl-C
 * during a manifest write corrupts the durable artifact, and during an image
 * write leaves a short `.jpg` that `downloadedUuids` counts as present forever.
 * `package.json`'s `db:types` uses the same idiom for the generated types.
 */
async function writeAtomic(
  destination: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, destination);
}

/**
 * Written with a fixed key order and a trailing newline so a regeneration
 * shows up as a content diff rather than a reshuffle. `corpus.json` is in
 * `.prettierignore` for the same reason: this writer owns its formatting.
 *
 * The spread is load-bearing, not tidiness. Every stage round-trips the whole
 * manifest through this function, so a hardcoded field list would silently
 * delete whatever a later stage had written — `db:seed:fetch`, which reads as
 * a harmless no-op, would erase hours of enrichment. Spreading first means
 * unknown fields survive; the explicit keys still lead, so the order a reviewer
 * reads is unchanged.
 */
async function writeManifest(manifest: CorpusManifest): Promise<void> {
  const ordered: CorpusManifest = {
    version: manifest.version,
    source: manifest.source,
    pieces: [...manifest.pieces]
      .sort((a, b) => a.aic_id - b.aic_id)
      .map((piece) => ({
        ...piece,
        aic_id: piece.aic_id,
        image_id: piece.image_id,
        piece_uuid: piece.piece_uuid,
        title: piece.title,
        artist: piece.artist,
        tags_from_metadata: piece.tags_from_metadata,
        image_width: piece.image_width,
        slot: piece.slot,
        // Optional, and reading them back off the same piece is what makes
        // that safe: an absent field re-assigns `undefined`, which
        // `JSON.stringify` omits, so it pins the key order of the pieces that
        // do carry enrichment without inventing keys on the ones that do not.
        tags_from_enrichment: piece.tags_from_enrichment,
        description: piece.description,
        enrichment_failed: piece.enrichment_failed,
      })),
  };

  await writeAtomic(MANIFEST_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * `looseObject`, not `object`, and that is the whole point.
 *
 * Zod strips unknown keys by default, which would delete every field a later
 * stage had written the moment the manifest was read back — the same data loss
 * `writeManifest` was fixed to avoid, re-introduced one layer up. Loose parsing
 * validates the fields this stage owns and carries the rest through untouched.
 */
const CorpusPieceSchema = z.looseObject({
  aic_id: z.number(),
  image_id: z.string(),
  piece_uuid: z.string().regex(/^[0-9a-f-]{36}$/),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  artist: z.string().nullable(),
  tags_from_metadata: z.array(z.string()),
  image_width: z.number().positive(),
  slot: z.number().int().nonnegative(),
  tags_from_enrichment: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  enrichment_failed: z.string().optional(),
});

const CorpusManifestSchema = z.looseObject({
  version: z.number(),
  source: z.looseObject({
    api: z.string(),
    iiif_url: z.string(),
    licence: z.string(),
    query: z.string(),
    sampled_at: z.string(),
  }),
  pieces: z.array(CorpusPieceSchema),
});

async function readManifest(): Promise<CorpusManifest | null> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const parsed = CorpusManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    // Refusing here protects the manifest: an unreadable one would otherwise
    // look like "no manifest", and the run would sample a fresh corpus over
    // the top of it.
    throw new Error(
      `${path.relative(REPO_ROOT, MANIFEST_PATH)} is malformed: ${z.prettifyError(parsed.error)}`,
    );
  }

  return parsed.data as CorpusManifest;
}

// ---------------------------------------------------------------------------
// AIC access
// ---------------------------------------------------------------------------

async function searchAic(
  family: string,
  bucket: readonly [number, number],
  page: number,
): Promise<AicArtwork[]> {
  const body = {
    query: {
      bool: {
        must: [
          { term: { is_public_domain: true } },
          { exists: { field: "image_id" } },
          { term: { "classification_titles.keyword": family } },
          { range: { id: { gte: bucket[0], lt: bucket[1] } } },
        ],
      },
    },
    // Deterministic ordering. Without it Elasticsearch is free to return the
    // same query in a different order and the sample stops being reproducible.
    sort: [{ id: "asc" }],
  };

  const url = `${AIC_API}/artworks/search?fields=${AIC_FIELDS}&limit=${PAGE_SIZE}&page=${page}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...REQUEST_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `AIC search failed for ${family} ${bucket[0]}-${bucket[1]}: ${response.status} ${response.statusText}`,
    );
  }

  const payload: unknown = await response.json();
  const envelope = z.object({ data: z.array(z.unknown()).optional() });
  const outer = envelope.safeParse(payload);
  if (!outer.success) {
    throw new Error(
      `AIC search returned an unrecognised envelope for ${family} ${bucket[0]}-${bucket[1]}`,
    );
  }

  // Per record, not per page: one malformed artwork among a hundred should cost
  // that artwork, not the whole page. A page that is entirely unparseable still
  // surfaces, as an empty result the caller reports as zero candidates.
  const artworks: AicArtwork[] = [];
  let rejected = 0;
  for (const record of outer.data.data ?? []) {
    const parsedRecord = AicArtworkSchema.safeParse(record);
    if (parsedRecord.success) artworks.push(parsedRecord.data);
    else rejected += 1;
  }

  if (rejected > 0) {
    console.warn(
      `  ${family} ${bucket[0]}-${bucket[1]}: skipped ${rejected} record(s) that did not match the expected AIC shape`,
    );
  }

  return artworks;
}

const iiifUrl = (imageId: string, width: number) =>
  `${IIIF_BASE}/${imageId}/full/${width},/0/default.jpg`;

/**
 * Never above the source width, or the image server 403s the request as an
 * upscale. `full/full` is not the escape hatch it looks like — it is served
 * behind a bot challenge that answers HTML with a 403.
 */
export const requestWidth = (sourceWidth: number | null | undefined) =>
  Math.min(
    IIIF_MAX_WIDTH,
    sourceWidth && sourceWidth > 0 ? sourceWidth : IIIF_MAX_WIDTH,
  );

/**
 * The header omission failure mode is why this asserts on `content-type` and
 * not on the status alone: without a `User-Agent` the IIIF server answers with
 * an HTML block page, which a naive pipeline happily writes to disk as a
 * `.jpg`. A file that is not an image must fail here, loudly.
 */
async function downloadImage(piece: CorpusPiece): Promise<void> {
  const response = await fetch(iiifUrl(piece.image_id, piece.image_width), {
    headers: REQUEST_HEADERS,
  });

  if (!response.ok) {
    throw new Error(
      `IIIF download failed for aic ${piece.aic_id} at ${piece.image_width}px: ${response.status} ${response.statusText}`,
    );
  }

  // Asserted on the content type, not the status: a request missing its
  // `User-Agent` is answered with an HTML block page, which a pipeline that
  // trusts the status happily writes to disk as a `.jpg`.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `IIIF returned "${contentType}" for aic ${piece.aic_id}, not an image — check the request headers`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new Error(`aic ${piece.aic_id} downloaded bytes are not a JPEG`);
  }

  await writeAtomic(path.join(ASSET_DIR, `${piece.piece_uuid}.jpg`), bytes);
}

/** Bounded parallelism, so a free unauthenticated API is not hammered. */
async function inBatches<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(worker));
  }
}

// ---------------------------------------------------------------------------
// Stage: fetch
// ---------------------------------------------------------------------------

function toPiece(artwork: AicArtwork): CorpusPiece | null {
  const title = artwork.title?.trim();
  if (!title || !artwork.image_id) return null;

  return {
    aic_id: artwork.id,
    image_id: artwork.image_id,
    piece_uuid: pieceUuid(artwork.id),
    title: truncateTitle(title),
    artist: artwork.artist_title?.trim() || null,
    tags_from_metadata: [
      ...mediumTags(artwork),
      ...subjectTags(artwork),
      ...paletteTags(artwork.color),
    ],
    image_width: requestWidth(artwork.thumbnail?.width),
    slot: 0,
  };
}

/**
 * One family's sample plus the candidates it did not need. The reserve exists
 * because a piece can only be proved usable by downloading it: a minority of
 * `is_public_domain` records have no servable IIIF derivative at all, and
 * dropping those would quietly unbalance the families.
 */
type FamilySample = {
  family: string;
  picked: CorpusPiece[];
  reserve: CorpusPiece[];
};

/**
 * Every usable candidate in one family, kept split by id bucket so the
 * allocation can spread a family's target across the whole accession range
 * instead of taking it all from whichever bucket happens to be largest.
 */
async function gatherCandidates(
  family: string,
  seen: Set<number>,
): Promise<CorpusPiece[][]> {
  const byBucket: CorpusPiece[][] = [];

  for (const bucket of ID_BUCKETS) {
    const candidates: CorpusPiece[] = [];

    for (let page = 1; page <= PAGES_PER_BUCKET; page += 1) {
      const batch = await searchAic(family, bucket, page);
      if (batch.length === 0) break;

      for (const artwork of batch) {
        const piece = toPiece(artwork);
        if (!piece || seen.has(piece.aic_id)) continue;
        seen.add(piece.aic_id);
        candidates.push(piece);
      }

      // A short page is the last page; asking for the next one only burns a
      // request against an API that caps offset at 1000 anyway.
      if (batch.length < PAGE_SIZE) break;
    }

    byBucket.push(candidates);
  }

  return byBucket;
}

/**
 * @param target how many pieces to pick in total.
 * @param exclude AIC object ids already pinned in the manifest. Seeding the
 * `seen` set with them is what makes a top-up additive rather than a re-sample:
 * a pinned piece can never be offered again, so the shortfall is filled with
 * pieces the corpus does not already have.
 */
async function selectPieces(
  target: number,
  exclude: ReadonlySet<number>,
): Promise<FamilySample[]> {
  const seen = new Set<number>(exclude);
  const gathered: CorpusPiece[][][] = [];

  for (const family of FAMILIES) {
    const byBucket = await gatherCandidates(family, seen);
    gathered.push(byBucket);
    console.log(
      `  ${family.padEnd(11)} ${String(
        byBucket.reduce((n, b) => n + b.length, 0),
      ).padStart(5)} candidates across ${byBucket.length} id buckets`,
    );
  }

  // On a top-up the shortfall is spread by remaining availability rather than
  // by each family's original share: the manifest does not record which family
  // a piece came from, so there is nothing to restore a balance against. The
  // first, full sample is the balanced one; a repair run trades a little skew
  // for not discarding what is already on disk.
  const familyTargets = allocate(
    gathered.map((byBucket) => byBucket.reduce((n, b) => n + b.length, 0)),
    target,
  );

  return FAMILIES.map((family, familyIndex) => {
    const byBucket = gathered[familyIndex];
    const bucketTargets = allocate(
      byBucket.map((b) => b.length),
      familyTargets[familyIndex],
    );

    const picked: CorpusPiece[] = [];
    const reserve: CorpusPiece[] = [];

    byBucket.forEach((candidates, bucketIndex) => {
      const fromBucket = pickEvenly(candidates, bucketTargets[bucketIndex]);
      const takenIds = new Set(fromBucket.map((p) => p.aic_id));
      picked.push(...fromBucket);
      reserve.push(...candidates.filter((c) => !takenIds.has(c.aic_id)));
    });

    console.log(
      `  ${family.padEnd(11)} ${String(picked.length).padStart(4)} picked, ${reserve.length} in reserve`,
    );

    return { family, picked, reserve };
  });
}

/**
 * Download a family's sample, swapping in a reserve piece for anything the
 * IIIF server will not serve. Failures are reported rather than swallowed —
 * a family that burns through its whole reserve is a signal about AIC, not
 * something to paper over.
 */
async function downloadFamily(sample: FamilySample): Promise<CorpusPiece[]> {
  const queue = [...sample.picked];
  const reserve = [...sample.reserve];
  const kept: CorpusPiece[] = [];

  while (queue.length > 0) {
    const batch = queue.splice(0, DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (piece) => {
        try {
          await downloadImage(piece);
          return piece;
        } catch (error) {
          console.warn(
            `  skipped ${sample.family} aic ${piece.aic_id}: ${
              error instanceof Error ? error.message : error
            }`,
          );
          return null;
        }
      }),
    );

    for (const piece of results) {
      if (piece) kept.push(piece);
      else if (reserve.length > 0) queue.push(reserve.shift()!);
    }

    if (kept.length % PROGRESS_EVERY < DOWNLOAD_CONCURRENCY) {
      process.stdout.write(`\r    ${sample.family}: ${kept.length} …`);
    }
  }

  process.stdout.write("\r");

  return kept;
}

async function downloadedUuids(): Promise<Set<string>> {
  let files: string[];
  try {
    files = await readdir(ASSET_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }

  const present = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".jpg")) continue;

    // Presence by name alone would count a zero-byte file as done, and it would
    // then never be re-fetched — it would just be uploaded broken. A leftover
    // `.tmp` is skipped by the extension filter and replaced on the next write.
    const { size } = await stat(path.join(ASSET_DIR, file));
    if (size > 0) present.add(file.replace(/\.jpg$/, ""));
  }

  return present;
}

async function runFetch(): Promise<void> {
  await mkdir(ASSET_DIR, { recursive: true });

  // Everything already in the manifest is pinned. It is never re-sampled, its
  // slots are never reassigned, and its images are never re-downloaded — the
  // manifest is the durable artifact, and a run that discards it to start over
  // would throw away hours of network work and, once Phase 2 lands, hours of
  // model work. A short manifest is topped up, not replaced.
  const existing = await readManifest();
  const pinned = existing?.pieces ?? [];
  const shortfall = TARGET_TOTAL - pinned.length;

  // Per-piece resume: only images actually absent from disk are fetched. A
  // piece whose image will not download stays pinned and is retried next run,
  // rather than aborting the whole batch.
  const already = await downloadedUuids();
  const missing = pinned.filter((p) => !already.has(p.piece_uuid));
  if (pinned.length > 0) {
    console.log(
      `Manifest holds ${pinned.length} pinned pieces; images: ${
        pinned.length - missing.length
      } present, ${missing.length} to download.`,
    );
  }

  let repaired = 0;
  let unreachable = 0;
  await inBatches(missing, DOWNLOAD_CONCURRENCY, async (piece) => {
    try {
      await downloadImage(piece);
      repaired += 1;
      if (repaired % PROGRESS_EVERY === 0) {
        console.log(`  ${repaired}/${missing.length}`);
      }
    } catch (error) {
      unreachable += 1;
      console.warn(
        `  image still missing for aic ${piece.aic_id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  });

  const pieces = [...pinned];

  if (shortfall > 0) {
    console.log(
      `Sampling ${FAMILIES.length} families from AIC for ${shortfall} more piece(s)…`,
    );
    const samples = await selectPieces(
      shortfall,
      new Set(pinned.map((p) => p.aic_id)),
    );

    console.log(`Downloading ${shortfall} image(s)…`);
    for (const sample of samples) {
      const kept = await downloadFamily(sample);
      console.log(
        `  ${sample.family.padEnd(11)} ${String(kept.length).padStart(4)} downloaded`,
      );
      pieces.push(...kept);
    }

    // Only when the piece set actually changed. Leaving slots alone on a no-op
    // run is what keeps the manifest byte-identical across re-runs.
    assignSlots(pieces);
  }

  await writeManifest({
    version: MANIFEST_VERSION,
    source: {
      api: AIC_API,
      iiif_url: IIIF_BASE,
      licence: LICENCE,
      query: SAMPLING_QUERY,
      // The date the corpus was FIRST sampled, carried forward for the life of
      // the manifest. Since resume is additive, pieces pinned on day one really
      // were sampled on this date; pieces added by a later top-up were not, and
      // the manifest does not record their date separately. That imprecision is
      // deliberate — the field exists to say which AIC index generation the
      // corpus came from, not to timestamp each row.
      sampled_at:
        existing?.source.sampled_at ?? new Date().toISOString().slice(0, 10),
    },
    pieces,
  });

  const tagTotal = pieces.reduce((n, p) => n + p.tags_from_metadata.length, 0);
  const untagged = pieces.filter((p) => p.tags_from_metadata.length === 0);

  console.log(
    `\nManifest: ${pieces.length} pieces at ${path.relative(REPO_ROOT, MANIFEST_PATH)}`,
  );
  console.log(
    `Metadata tags: ${tagTotal} total, ${(tagTotal / pieces.length).toFixed(1)} per piece, ${untagged.length} pieces with none.`,
  );

  // Say so out loud. A short run used to be invisible — it exited 0 and the
  // next invocation silently started over. Now the manifest keeps what it has
  // and the shortfall is named, so re-running is a top-up that converges.
  if (pieces.length < TARGET_TOTAL) {
    console.warn(
      `\nShort of the ${TARGET_TOTAL}-piece target by ${TARGET_TOTAL - pieces.length}. ` +
        `Re-run to top up — pinned pieces are kept.`,
    );
  }
  if (unreachable > 0) {
    console.warn(
      `${unreachable} pinned piece(s) still have no image on disk; re-run to retry them.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage: enrich
// ---------------------------------------------------------------------------

/**
 * Parallel model calls.
 *
 * The plan said four. Four is measurably too many: OpenRouter caps `:free`
 * models at roughly 20 requests per minute, and a measured ~10s per call means
 * four in flight is `60 * 4 / 10` = ~24 requests a minute. A 500-piece run
 * proved it — clean for ~120 pieces on burst allowance, then 429s, and because
 * a pinned failure is never retried those pieces would have been permanently
 * metadata-only. Two in flight is ~12 a minute, under the cap with room for the
 * fallback chain to spend a second and third request on a struggling piece.
 *
 * Halving this halves throughput to ~24 pieces a minute; that is the trade, and
 * the stage is resumable precisely so a slower run costs nothing but wall-clock.
 */
const ENRICH_CONCURRENCY = 2;

/** Progress every N pieces, so a run measured in tens of minutes is not silent. */
const ENRICH_PROGRESS_EVERY = 25;

type EnrichOutcome = { ok: true } | { ok: false; reason: EnrichmentFailure };

/**
 * Enrich one piece and write the result onto it in place.
 *
 * The image goes in as a `data:` URL rather than its IIIF URL on purpose: an
 * https source is fetched by the model provider, and the provider hits the same
 * `403 text/html` block page a bare `curl` does. The bytes are already on disk
 * from the fetch stage, so they are read and inlined.
 */
async function enrichPiece(piece: CorpusPiece): Promise<EnrichOutcome> {
  const bytes = await readFile(path.join(ASSET_DIR, `${piece.piece_uuid}.jpg`));
  const result = await enrichFromImage(
    `data:image/jpeg;base64,${bytes.toString("base64")}`,
  );

  if (!result.ok) {
    // Recorded, not thrown. An empty array plus a reason is a pinned outcome:
    // the piece is skipped by the next run rather than retried forever, and it
    // reaches Phase 3 as part of the untagged tail rather than as a hole.
    piece.tags_from_enrichment = [];
    piece.description = null;
    piece.enrichment_failed = result.reason;
    return { ok: false, reason: result.reason };
  }

  piece.tags_from_enrichment = enrichedTags(result.data.tags);
  piece.description = result.data.description;
  delete piece.enrichment_failed;
  return { ok: true };
}

/**
 * `--limit N` / `--limit=N`, bounding how many pieces this run enriches.
 *
 * It exists so the full run can be sized by trial rather than by estimate:
 * enrich 25, measure latency and tag quality, then decide the real number. It
 * composes with resume — a limited run pins what it produced, and the next run
 * picks up from there.
 */
export function parseLimit(argv: readonly string[]): number | null {
  const index = argv.findIndex(
    (arg) => arg === "--limit" || arg.startsWith("--limit="),
  );
  if (index === -1) return null;

  const raw = argv[index].startsWith("--limit=")
    ? argv[index].slice("--limit=".length)
    : argv[index + 1];

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `--limit needs a positive whole number, got "${raw ?? ""}".`,
    );
  }
  return value;
}

/**
 * Which pieces this run should call the model for, in the order it should do it.
 *
 * Resume is the default and needs no flag: a piece is done once it carries a
 * `tags_from_enrichment` field, so a plain re-run picks up exactly where the
 * last one stopped and makes zero calls for anything already pinned.
 *
 * `--retry-failed` is the opt-in that reopens pinned failures. It has to be
 * opt-in: a pinned failure counts as done, which is what lets a re-run over a
 * finished manifest be a true no-op, and quietly retrying would spend model
 * calls every time anyone re-ran the stage. Retries lead the queue so
 * `--retry-failed --limit N` is a way to clear the failures and nothing else.
 */
export function selectPending(
  pieces: readonly CorpusPiece[],
  options: { retryFailed?: boolean; limit?: number | null } = {},
): CorpusPiece[] {
  const retries = options.retryFailed
    ? pieces.filter((piece) => piece.enrichment_failed !== undefined)
    : [];
  const fresh = pieces.filter(
    (piece) => piece.tags_from_enrichment === undefined,
  );

  const queue = [...retries, ...fresh];
  const limit = options.limit ?? null;
  return limit === null ? queue : queue.slice(0, limit);
}

/**
 * Assert the invariants the enriched manifest is supposed to hold, over the
 * whole file rather than over this run's slice.
 *
 * `enrichedTags` and `combineTags` already guarantee both by construction, so
 * this can only fire on a hand-edited manifest, a taxonomy term that has since
 * been renamed, or a regression in either function. That is the point: the
 * manifest is the durable artifact and is meant to be reviewed and occasionally
 * edited by hand, and the next stage to read it writes SQL against a table with
 * a `CHECK` constraint. Failing here is cheaper than failing in `db reset`.
 */
function verifyEnrichment(manifest: CorpusManifest): void {
  const problems: string[] = [];

  for (const piece of manifest.pieces) {
    if (piece.tags_from_enrichment === undefined) continue;

    for (const tag of piece.tags_from_enrichment) {
      const facet = facetOf(tag);
      if (facet !== "style" && facet !== "mood") {
        problems.push(
          `aic ${piece.aic_id}: "${tag}" is ${facet ?? "outside the taxonomy"}, not style or mood`,
        );
      }
    }

    const combined = combineTags(
      piece.tags_from_metadata,
      piece.tags_from_enrichment,
    );
    if (combined.length > MAX_TAGS) {
      problems.push(
        `aic ${piece.aic_id}: ${combined.length} combined tags exceeds the ${MAX_TAGS} ceiling`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Manifest invariants violated:\n  ${problems.join("\n  ")}`,
    );
  }
}

async function runEnrich(): Promise<void> {
  // Up front, not per piece: without the key `enrichFromImage` returns
  // `unconfigured` for every call, and the run would pin a thousand failures
  // in seconds and look like it had done its job.
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. The enrich stage needs it — put it in .env.local, which `npm run db:seed:enrich` loads.",
    );
  }

  const manifest = await readManifest();
  if (!manifest) {
    throw new Error(
      `No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run \`npm run db:seed:fetch\` first.`,
    );
  }

  // Up front too, not just at the end: this validates what is already pinned,
  // so a hand-edited manifest is caught on a no-op re-run rather than silently
  // carried into the generate stage.
  verifyEnrichment(manifest);

  const args = process.argv.slice(3);
  const limit = parseLimit(args);
  const retryFailed = args.includes("--retry-failed");

  const fresh = manifest.pieces.filter(
    (piece) => piece.tags_from_enrichment === undefined,
  ).length;
  const pinnedFailures = manifest.pieces.filter(
    (piece) => piece.enrichment_failed !== undefined,
  ).length;
  const todo = selectPending(manifest.pieces, { retryFailed, limit });

  console.log(
    `${manifest.pieces.length} pieces in the manifest; ${fresh} never enriched, ${pinnedFailures} pinned as failed` +
      `${retryFailed ? " (retrying)" : " (use --retry-failed to reopen)"}; ` +
      `enriching ${todo.length}${limit === null ? "" : ` (--limit ${limit})`}.`,
  );

  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const started = Date.now();
  const failures = new Map<EnrichmentFailure, number>();
  let done = 0;
  let missingImage = 0;

  // Batched rather than a free-running pool so the manifest can be flushed
  // between batches. A run measured in tens of minutes must survive Ctrl-C
  // with everything finished so far already pinned — at most one batch of
  // model work is ever lost.
  for (let i = 0; i < todo.length; i += ENRICH_CONCURRENCY) {
    const batch = todo.slice(i, i + ENRICH_CONCURRENCY);

    await Promise.all(
      batch.map(async (piece) => {
        try {
          const outcome = await enrichPiece(piece);
          if (!outcome.ok) {
            failures.set(
              outcome.reason,
              (failures.get(outcome.reason) ?? 0) + 1,
            );
          }
        } catch (error) {
          // A missing or unreadable JPEG is a fetch-stage problem, not a model
          // one. Left unpinned so `db:seed:fetch` can repair it and a later
          // enrich run picks the piece up.
          missingImage += 1;
          console.warn(
            `  aic ${piece.aic_id}: image unreadable, left unenriched — ${
              error instanceof Error ? error.message : error
            }`,
          );
        }
        done += 1;
      }),
    );

    await writeManifest(manifest);

    if (done % ENRICH_PROGRESS_EVERY < ENRICH_CONCURRENCY) {
      const elapsed = (Date.now() - started) / 1000;
      console.log(
        `  ${done}/${todo.length} — ${elapsed.toFixed(0)}s elapsed, ` +
          `${(elapsed / done).toFixed(1)}s per piece`,
      );
    }
  }

  verifyEnrichment(manifest);

  const elapsed = (Date.now() - started) / 1000;
  const enriched = todo.filter(
    (piece) => piece.tags_from_enrichment !== undefined,
  );
  const succeeded = enriched.filter(
    (piece) => piece.enrichment_failed === undefined,
  );
  const failed = enriched.length - succeeded.length;

  console.log(
    `\nEnriched ${enriched.length} piece(s) in ${elapsed.toFixed(0)}s ` +
      `(${(elapsed / Math.max(1, enriched.length)).toFixed(1)}s per piece): ` +
      `${succeeded.length} tagged, ${failed} failed.`,
  );

  if (failures.size > 0) {
    console.warn("Failure reasons:");
    for (const [reason, count] of [...failures].sort((a, b) => b[1] - a[1])) {
      console.warn(`  ${reason.padEnd(17)} ${count}`);
    }
  }
  if (missingImage > 0) {
    console.warn(
      `${missingImage} piece(s) had no readable image; run \`npm run db:seed:fetch\` to repair, then re-run.`,
    );
  }

  const tagTotal = succeeded.reduce(
    (n, p) => n + (p.tags_from_enrichment?.length ?? 0),
    0,
  );
  if (succeeded.length > 0) {
    console.log(
      `Style/mood tags: ${tagTotal} total, ${(tagTotal / succeeded.length).toFixed(1)} per tagged piece.`,
    );
  }

  // The closing state of the whole manifest, not of this run, so an operator
  // coming back to a half-finished corpus days later is told what to type.
  const remaining = manifest.pieces.filter(
    (piece) => piece.tags_from_enrichment === undefined,
  ).length;
  const stillFailed = manifest.pieces.filter(
    (piece) => piece.enrichment_failed !== undefined,
  ).length;

  if (remaining > 0) {
    console.log(
      `${remaining} piece(s) still unenriched — \`npm run db:seed:enrich:resume\` continues; pinned pieces are never re-called.`,
    );
  }
  if (stillFailed > 0) {
    console.log(
      `${stillFailed} piece(s) pinned as failed — \`npm run db:seed:enrich:retry\` reopens them.`,
    );
  }

  // Exit non-zero only when nothing at all worked. A minority of failures is
  // an expected free-tier outcome and becomes part of the untagged tail; a
  // total failure means the model roster has churned and `MODELS` in
  // `src/lib/ai/enrich.ts` needs re-checking before the run is repeated.
  if (enriched.length > 0 && succeeded.length === 0) {
    throw new Error(
      "Every piece failed enrichment — re-check the free model roster in src/lib/ai/enrich.ts before re-running.",
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const STAGES: Record<string, () => Promise<void>> = {
  fetch: runFetch,
  enrich: runEnrich,
};

/** Stages the npm scripts expose that later phases of this change still owe. */
const PLANNED_STAGES: Record<string, string> = {
  coverage: "phase 3",
  generate: "phase 4",
};

async function main(): Promise<void> {
  const stage = process.argv[2];

  const run = stage ? STAGES[stage] : undefined;
  if (run) {
    await run();
    return;
  }

  if (stage && stage in PLANNED_STAGES) {
    throw new Error(
      `Stage "${stage}" is not implemented yet — it lands in ${PLANNED_STAGES[stage]} of the real-artwork-corpus change.`,
    );
  }

  throw new Error(
    `Unknown stage "${stage ?? ""}". Known stages: ${Object.keys(STAGES).join(", ")}.`,
  );
}

/**
 * Only when run as the script, never on import.
 *
 * `test/build-corpus.test.ts` imports the pure helpers from this file. Without
 * the guard that import would run `main()`, which sees vitest's argv, fails on
 * an unknown stage and sets a non-zero exit code on a passing suite.
 */
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
