/**
 * Builds the local ranking-evaluation corpus from the Art Institute of Chicago's
 * public-domain collection.
 *
 * Five stages over one file, `supabase/seed-assets/corpus.json`:
 *
 *   fetch     network  → manifest + gitignored JPEGs
 *   enrich    images   → manifest (style / mood / description)
 *   coverage  manifest → onboarding style-term report
 *   generate  manifest → the generated region of `supabase/seed.sql`
 *   push      manifest → rows + objects on a target Supabase project
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
 *   npm run db:seed:coverage         report per-facet vocabulary coverage
 *   npm run db:seed:generate         write the generated region of seed.sql
 *   npm run db:push                  dry-run against .env.push.local's target
 *   npm run db:push -- --apply       write the rows and objects
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
 * `fetch`, `enrich`, `coverage` and `generate` are LOCAL DEVELOPMENT ONLY —
 * they write seed data for `supabase db reset`. `push` is the exception: it
 * writes to whatever project `.env.push.local` names, local or hosted, and is
 * dry-run unless invoked with `--apply`. See supabase/seed-assets/README.md.
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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as z from "zod";
import { enrichFromImage, type EnrichmentFailure } from "@/lib/ai";
import { FACETS, TAXONOMY_BY_FACET, type Facet } from "@/lib/ai/taxonomy";
import { ARTWORKS_BUCKET } from "@/lib/artworks/images";
import { MAX_TAGS } from "@/lib/artworks/tags";
import type { Database } from "@/types/database";

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
export const ARTIST_UUID = "00000000-0000-4000-8000-000000000001";

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
  /**
   * Part of the deliberate untagged tail. The generator emits `'{}'` for these
   * pieces' tags and drops their description, whatever the earlier stages
   * produced — this is a choice about the corpus, not a gap in it.
   */
  untagged?: boolean;
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
  /**
   * The tag group the warm collector's seeded likes sit in, pinned by the
   * generate stage. Written into the manifest rather than left implicit in the
   * SQL so the judgment walkthrough can name the group it is watching for
   * instead of rediscovering it by reading a thousand insert rows.
   */
  like_history?: LikeHistory;
};

export type LikeHistory = {
  /** The style term the likes concentrate on. */
  tag: string;
  /** The liked pieces, in slot order. */
  piece_uuids: string[];
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
    // Same reason as the per-piece spread below: a hardcoded top-level key
    // list would delete whatever a later stage had written — `like_history`
    // today, anything else tomorrow — the moment an earlier stage re-ran.
    ...manifest,
    version: manifest.version,
    source: manifest.source,
    like_history: manifest.like_history,
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
        untagged: piece.untagged,
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
  untagged: z.boolean().optional(),
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
  like_history: z
    .looseObject({
      tag: z.string(),
      piece_uuids: z.array(z.string()),
    })
    .optional(),
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
  items: readonly T[],
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
 * Share of the corpus held back as a deliberate untagged tail.
 *
 * Not a gap — a fixture. S-01's outermost sort key demotes untagged pieces
 * below every tagged one, including pieces the collector has already passed on,
 * and that ordering is unobservable unless untagged pieces actually exist. It
 * also mirrors production, where artworks published before enrichment existed
 * carry no tags and no backfill is planned.
 */
const UNTAGGED_TAIL_FRACTION = 0.05;

/**
 * The untagged tail, spread evenly across the slot range.
 *
 * Even spacing by `slot` rather than a random sample, because `slot` becomes
 * the `created_at` offset: a tail clustered at one end would sit entirely
 * outside the first deck a collector sees, and the sort key it exists to make
 * visible would go unobserved. Fifty pieces over a thousand slots is one every
 * twentieth, which puts a piece in both the first and last twenty whichever end
 * the deck calls newest.
 *
 * Deterministic and re-derivable: sorted by slot, picked evenly, no randomness.
 */
export function selectUntagged(
  pieces: readonly CorpusPiece[],
  fraction = UNTAGGED_TAIL_FRACTION,
): CorpusPiece[] {
  const bySlot = [...pieces].sort((a, b) => a.slot - b.slot);
  return pickEvenly(bySlot, Math.round(pieces.length * fraction));
}

/**
 * The tags a piece actually reaches the database with.
 *
 * One function so the coverage report and the generator cannot disagree about
 * what the corpus serves. An untagged piece contributes nothing — counting its
 * museum tags here would report coverage the `getStarterDeck` overlap will
 * never find.
 */
export function effectiveTags(piece: CorpusPiece): string[] {
  if (piece.untagged) return [];
  return combineTags(
    piece.tags_from_metadata,
    piece.tags_from_enrichment ?? [],
  );
}

export type FacetCoverage = {
  facet: Facet;
  counts: { term: string; pieces: number }[];
  covered: number;
  total: number;
};

/**
 * How many pieces each vocabulary term can serve.
 *
 * The threshold for "covered" is one piece, matching the query rather than a
 * taste judgment: `getStarterDeck` runs an `.overlaps("tags", terms)` that
 * either returns rows or does not, and `ONBOARDING_POOL_SIZE` is only a ceiling
 * on how many it takes.
 */
export function coverageReport(
  pieces: readonly CorpusPiece[],
): FacetCoverage[] {
  const tally = new Map<string, number>();
  for (const piece of pieces) {
    for (const tag of effectiveTags(piece)) {
      tally.set(tag, (tally.get(tag) ?? 0) + 1);
    }
  }

  return FACETS.map((facet) => {
    const counts = facetTerms(facet).map((term) => ({
      term,
      pieces: tally.get(term) ?? 0,
    }));
    return {
      facet,
      counts,
      covered: counts.filter((entry) => entry.pieces > 0).length,
      total: counts.length,
    };
  });
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
// Stage: coverage
// ---------------------------------------------------------------------------

/**
 * Pin the untagged tail if it is not pinned already.
 *
 * Idempotent by construction: the selection is a pure function of the slots, so
 * re-running re-derives the same fifty pieces. It is written into the manifest
 * anyway rather than derived at generate time, because the tail is a curatorial
 * decision about this corpus and belongs in the artifact a reviewer reads.
 */
function pinUntaggedTail(manifest: CorpusManifest): number {
  const chosen = new Set(
    selectUntagged(manifest.pieces).map((piece) => piece.piece_uuid),
  );

  for (const piece of manifest.pieces) {
    if (chosen.has(piece.piece_uuid)) {
      piece.untagged = true;
    } else {
      delete piece.untagged;
    }
  }

  return chosen.size;
}

/** A bar cheap enough to read at a glance, scaled to the busiest term. */
const bar = (count: number, max: number, width = 24) =>
  "█".repeat(max === 0 ? 0 : Math.round((count / max) * width));

async function runCoverage(): Promise<void> {
  const manifest = await readManifest();
  if (!manifest) {
    throw new Error(
      `No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run \`npm run db:seed:fetch\` first.`,
    );
  }

  const tail = pinUntaggedTail(manifest);
  await writeManifest(manifest);

  const report = coverageReport(manifest.pieces);
  const enriched = manifest.pieces.filter(
    (piece) => piece.tags_from_enrichment !== undefined,
  ).length;

  console.log(
    `${manifest.pieces.length} pieces — ${enriched} enriched, ${tail} held back as the untagged tail.\n`,
  );

  const gaps: string[] = [];

  for (const facet of report) {
    const max = Math.max(...facet.counts.map((entry) => entry.pieces));
    console.log(
      `${facet.facet}  ${facet.covered}/${facet.total} terms covered`,
    );

    for (const { term, pieces } of [...facet.counts].sort(
      (a, b) => b.pieces - a.pieces,
    )) {
      const mark = pieces === 0 ? "·" : " ";
      console.log(
        `  ${mark} ${term.padEnd(18)} ${String(pieces).padStart(4)}  ${bar(pieces, max)}`,
      );
      if (pieces === 0) gaps.push(`${facet.facet}/${term}`);
    }
    console.log("");
  }

  const covered = report.reduce((n, facet) => n + facet.covered, 0);
  const total = report.reduce((n, facet) => n + facet.total, 0);
  console.log(
    `Overall: ${covered}/${total} vocabulary terms have at least one piece.`,
  );

  if (gaps.length > 0) {
    // Recorded, never closed. A public-domain corpus that cannot serve
    // `street art` is a fact about public-domain art; tagging a 19th-century
    // etching `street art` to reach a number would put a false tag on a real
    // artwork. The onboarding picker is what stops a collector meeting an empty
    // pool, by offering only terms the catalogue can actually serve.
    console.log(
      `\n${gaps.length} term(s) with no pieces — findings, not failures:`,
    );
    console.log(`  ${gaps.join(", ")}`);
  }

  if (enriched < manifest.pieces.length) {
    console.log(
      `\nNote: ${manifest.pieces.length - enriched} piece(s) are not yet enriched, so style and ` +
        `mood coverage will grow as \`npm run db:seed:enrich:resume\` continues.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Stage: generate
// ---------------------------------------------------------------------------

const SEED_SQL_PATH = path.join(REPO_ROOT, "supabase", "seed.sql");

/**
 * The line that divides `seed.sql` in two.
 *
 * Everything above it is hand-authored and must stay that way — it encodes the
 * GoTrue requirement that every text token column on `auth.users` be an empty
 * string rather than NULL, which is not re-derivable from anything and cost
 * real time to discover. Everything below it is rewritten wholesale on every
 * `db:seed:generate`, so a hand edit there survives exactly until the next run.
 */
const GENERATED_MARKER =
  "-- === GENERATED BY scripts/build-corpus.ts — DO NOT HAND-EDIT ===";

/** The warm collector from the hand-authored identities section. */
const WARM_COLLECTOR_UUID = "00000000-0000-4000-8000-000000000002";

/** Base instant for the `created_at` stagger; slot N lands N+1 hours after it. */
const CORPUS_EPOCH = "2026-01-01 00:00:00+00";

/** Matches `artworks_description_length`. */
const MAX_DESCRIPTION_LENGTH = 2000;

/** Matches `image_path_pattern` in 20260910000100_constrain_artwork_image_path.sql. */
const IMAGE_PATH_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

const LIKE_COUNT = 8;

/**
 * A single-quoted SQL literal. AIC titles are full of apostrophes — "Marie
 * Antoinette's Fan", "L'Arlésienne" — so this is not a formality.
 */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A `text[]` literal.
 *
 * Every element is double-quoted rather than only the ones that need it: over
 * half the vocabulary is multi-word (`oil painting`, `black and white`), and a
 * rule with an exception is a rule someone eventually gets wrong. Backslashes
 * and double quotes are escaped for the array parser, then the whole literal
 * goes through `sqlString` for the SQL parser — two nested syntaxes, two
 * escapes.
 */
export function sqlTagArray(tags: readonly string[]): string {
  const elements = tags.map(
    (tag) => `"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return sqlString(`{${elements.join(",")}}`);
}

/**
 * The storage key the fetch stage downloaded to, derived not stored.
 *
 * Defaults to the local seeded artist so `runGenerate` and `artworkRow` are
 * untouched; the push stage passes the target artist's own uid instead, since
 * a key built from the local `ARTIST_UUID` would fail `image_path_pattern`'s
 * `<artist_id>/…` requirement against any other account.
 */
export function imagePathOf(
  piece: CorpusPiece,
  artistUuid: string = ARTIST_UUID,
): string {
  return `${artistUuid}/${piece.piece_uuid}.jpg`;
}

/**
 * What the `description` column carries.
 *
 * The enrichment paragraph plus an attribution line naming the artist and the
 * AIC object. AIC's own `description` field is CC-BY and is never copied — the
 * paragraph here is the model's, written from the image. CC0 asks for no
 * attribution at all; the line is a courtesy and a provenance trail back to the
 * object a reviewer can open.
 *
 * An untagged-tail piece gets null. That is the point of the tail: it stands in
 * for the artworks published before enrichment existed, which carry neither
 * tags nor a description, and a piece that kept its description would not
 * exercise the same rendering path.
 */
export function descriptionFor(piece: CorpusPiece): string | null {
  if (piece.untagged) return null;

  const attribution = `${piece.artist ?? "Unknown artist"} — Art Institute of Chicago, object ${piece.aic_id}. Public domain (CC0).`;
  const paragraph = piece.description?.trim();
  if (!paragraph) return attribution;

  // The attribution line, the blank line before it, and the ellipsis that
  // marks a trim all have to fit inside the same 2000 characters.
  const room = MAX_DESCRIPTION_LENGTH - attribution.length - 2;
  const body =
    paragraph.length <= room
      ? paragraph
      : `${paragraph.slice(0, room - 1).trimEnd()}…`;

  return `${body}\n\n${attribution}`;
}

/**
 * The warm collector's like history, derived from the corpus rather than
 * designed into it.
 *
 * F-01 could name its cluster up front because it authored the clusters. Here
 * the groups are emergent, so the group worth liking is whichever style term
 * the collection actually produced most of — that is the one with enough
 * unliked members left for a ranked deck to visibly concentrate on.
 *
 * Style, not any facet: `getStarterDeck` and the onboarding picker both work in
 * the style facet, and a like history in `oil painting` would say nothing about
 * taste. Ties break on the term, so the choice does not depend on tally order.
 *
 * The likes take the *oldest* qualifying pieces. Every corpus piece is equally
 * likeable, but the newest-first deck serves high slots first, so liking the
 * low ones leaves the group's newest members unseen and available — the deck
 * has something to concentrate on rather than a group it has exhausted.
 */
export function selectLikeHistory(
  pieces: readonly CorpusPiece[],
  count = LIKE_COUNT,
): LikeHistory | null {
  const tally = new Map<string, CorpusPiece[]>();
  for (const piece of pieces) {
    for (const tag of effectiveTags(piece)) {
      if (facetOf(tag) !== "style") continue;
      const bucket = tally.get(tag);
      if (bucket) bucket.push(piece);
      else tally.set(tag, [piece]);
    }
  }
  if (tally.size === 0) return null;

  const [tag, members] = [...tally].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )[0];

  return {
    tag,
    piece_uuids: [...members]
      .sort((a, b) => a.slot - b.slot)
      .slice(0, count)
      .map((piece) => piece.piece_uuid),
  };
}

/**
 * Everything the database would reject, checked before the database sees it.
 *
 * `db reset` reports a constraint violation as one failed statement out of a
 * thousand-row insert with no piece named, and the whole seed is rolled back —
 * so a single bad title costs a reset and a bisect. These are the four
 * constraints on `public.artworks` that corpus data can actually violate.
 *
 * Defaults to the local seeded artist so `runGenerate` is untouched; the push
 * stage calls this against the target artist's own uid before its first
 * write, for the same reason — a bad title or a malformed key should cost
 * nothing, not a partial push.
 */
export function verifyGeneratable(
  manifest: CorpusManifest,
  artistUuid: string = ARTIST_UUID,
): void {
  const problems: string[] = [];
  const slots = new Set<number>();

  for (const piece of manifest.pieces) {
    const where = `aic ${piece.aic_id}`;

    if (piece.title.length < 1 || piece.title.length > MAX_TITLE_LENGTH) {
      problems.push(
        `${where}: title is ${piece.title.length} chars, outside 1–${MAX_TITLE_LENGTH}`,
      );
    }

    const tags = effectiveTags(piece);
    if (tags.length > MAX_TAGS) {
      problems.push(
        `${where}: ${tags.length} tags exceeds the ${MAX_TAGS} ceiling`,
      );
    }

    const description = descriptionFor(piece);
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      problems.push(
        `${where}: description is ${description.length} chars, over ${MAX_DESCRIPTION_LENGTH}`,
      );
    }

    const imagePath = imagePathOf(piece, artistUuid);
    if (!IMAGE_PATH_PATTERN.test(imagePath)) {
      problems.push(
        `${where}: image_path "${imagePath}" fails image_path_pattern`,
      );
    }

    if (slots.has(piece.slot)) {
      // Two pieces on one slot is a duplicate created_at, which makes the
      // newest-first deck order non-deterministic — the one property the
      // stagger exists to give it.
      problems.push(`${where}: slot ${piece.slot} is used twice`);
    }
    slots.add(piece.slot);
  }

  if (problems.length > 0) {
    throw new Error(
      `Manifest cannot be generated into SQL:\n  ${problems.join("\n  ")}`,
    );
  }
}

/** One `values` row for `public.artworks`, in column order. */
export function artworkRow(piece: CorpusPiece): string {
  const description = descriptionFor(piece);
  return (
    `  (${sqlString(piece.piece_uuid)}, ${sqlString(ARTIST_UUID)}, ` +
    `${sqlString(piece.title)}, ` +
    `${description === null ? "null" : sqlString(description)}, ` +
    `${sqlTagArray(effectiveTags(piece))}, ` +
    `${sqlString(imagePathOf(piece))}, ` +
    `timestamptz '${CORPUS_EPOCH}' + interval '${piece.slot + 1} hour')`
  );
}

/**
 * The generated region, as text.
 *
 * Pure and total over the manifest, so the byte-identical re-run criterion is a
 * property of this function rather than a hope about the filesystem: rows come
 * out in slot order, tags in `combineTags` order, likes in slot order, and
 * nothing reads the clock.
 */
export function renderGeneratedRegion(manifest: CorpusManifest): string {
  const bySlot = [...manifest.pieces].sort((a, b) => a.slot - b.slot);
  const untagged = bySlot.filter((piece) => piece.untagged).length;
  const enriched = bySlot.filter(
    (piece) => piece.tags_from_enrichment !== undefined,
  ).length;
  const likes = manifest.like_history;

  const out: string[] = [
    GENERATED_MARKER,
    "--",
    "-- Do not hand-edit below this line. Change the corpus in",
    "-- `supabase/seed-assets/corpus.json` and re-run `npm run db:seed:generate`;",
    "-- anything typed here is overwritten by the next run.",
    "--",
    `-- ${bySlot.length} public-domain artworks from the Art Institute of Chicago`,
    `-- (${enriched} enriched, ${untagged} held back untagged), all owned by the seeded`,
    "-- artist. Images upload separately — see supabase/seed-assets/README.md.",
    "--",
    "-- Tags are emergent, not designed: museum metadata supplies medium, subject",
    "-- and palette; the enrichment pipeline supplies style and mood. `created_at`",
    `-- is staggered one hour per slot from ${CORPUS_EPOCH}, where slot order is a`,
    "-- deterministic shuffle of the piece UUIDs. Higher slot = newer = nearer the",
    "-- front of the deck. The shuffle is what stops tag groups being contiguous by",
    "-- insertion order, which would make a broken ranking look like a working one.",
    "",
    "insert into public.artworks (id, artist_id, title, description, tags, image_path, created_at)",
    "values",
    bySlot.map(artworkRow).join(",\n"),
    "on conflict (id) do nothing;",
    "",
  ];

  if (likes && likes.piece_uuids.length > 0) {
    out.push(
      "-- Like history — warm collector only.",
      "--",
      `-- ${likes.piece_uuids.length} likes, all on pieces tagged \`${likes.tag}\` — the most populous`,
      "-- style term this corpus produced. They are the oldest members of that group,",
      "-- so its newest pieces stay unseen and a ranked deck has something to",
      "-- concentrate on. The cold collector gets no rows at all, so both the ranked",
      "-- and cold-start paths are observable without a single click.",
      "insert into public.interactions (user_id, artwork_id, action)",
      "values",
      likes.piece_uuids
        .map(
          (uuid) =>
            `  (${sqlString(WARM_COLLECTOR_UUID)}, ${sqlString(uuid)}, 'like')`,
        )
        .join(",\n"),
      "on conflict (user_id, artwork_id) do nothing;",
      "",
    );
  }

  return out.join("\n");
}

async function runGenerate(): Promise<void> {
  const manifest = await readManifest();
  if (!manifest) {
    throw new Error(
      `No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run \`npm run db:seed:fetch\` first.`,
    );
  }

  // Re-pinned here as well as in `coverage` on purpose. The selection is a pure
  // function of the slots, so this either changes nothing or repairs a manifest
  // that never went through the coverage stage — and `generate` emitting a
  // corpus with no untagged tail would be a silent hole in what the seed is for.
  const tail = pinUntaggedTail(manifest);

  const likes = selectLikeHistory(manifest.pieces);
  if (!likes) {
    throw new Error(
      "No piece carries a style tag, so the warm collector has no group to like — run `npm run db:seed:enrich` first.",
    );
  }
  manifest.like_history = likes;

  verifyGeneratable(manifest);
  await writeManifest(manifest);

  let existing: string;
  try {
    existing = await readFile(SEED_SQL_PATH, "utf8");
  } catch {
    throw new Error(
      `No ${path.relative(REPO_ROOT, SEED_SQL_PATH)} to write into.`,
    );
  }

  const markerAt = existing.indexOf(GENERATED_MARKER);
  if (markerAt === -1) {
    // Never appended blindly: without the marker the file is either a
    // pre-generator seed still holding the F-01 corpus, or hand-edited into a
    // shape this stage does not understand. Appending would double the corpus.
    throw new Error(
      `${path.relative(REPO_ROOT, SEED_SQL_PATH)} has no generated-region marker.\n` +
        `Add this line below the hand-authored identities section, then re-run:\n\n${GENERATED_MARKER}`,
    );
  }

  const preserved = existing.slice(0, markerAt);
  await writeAtomic(SEED_SQL_PATH, preserved + renderGeneratedRegion(manifest));

  console.log(
    `Wrote ${manifest.pieces.length} artworks (${tail} untagged) and ` +
      `${likes.piece_uuids.length} \`${likes.tag}\` likes into ` +
      `${path.relative(REPO_ROOT, SEED_SQL_PATH)}, below the generated marker.`,
  );
  console.log(
    "The hand-authored identities section above the marker was left untouched.",
  );
}

// ---------------------------------------------------------------------------
// Stage: push
//
// A second sink on the same manifest — dry-run by default, `--apply` writes.
// Reads its target from variables nothing else in this repo defines, so a
// `.env.local` swapped between the local and remote pairs cannot redirect it.
// ---------------------------------------------------------------------------

type PushTarget = {
  url: string;
  publishableKey: string;
  artistEmail: string;
  artistPassword: string;
};

const PUSH_ENV_SETUP = `
  Create .env.push.local (never .env.local — see supabase/seed-assets/README.md) with:
    PUSH_SUPABASE_URL=...
    PUSH_SUPABASE_PUBLISHABLE_KEY=...
    PUSH_ARTIST_EMAIL=...
    PUSH_ARTIST_PASSWORD=...
`;

/**
 * Read the push target from its own, deliberately non-`NEXT_PUBLIC_` variable
 * names. No fallback to `NEXT_PUBLIC_SUPABASE_URL` or any service-role /
 * secret key under any name — if one is set in the process environment, it is
 * ignored, not consulted.
 */
function requirePushTarget(): PushTarget {
  const url = process.env.PUSH_SUPABASE_URL;
  const publishableKey = process.env.PUSH_SUPABASE_PUBLISHABLE_KEY;
  const artistEmail = process.env.PUSH_ARTIST_EMAIL;
  const artistPassword = process.env.PUSH_ARTIST_PASSWORD;

  if (!url || !publishableKey || !artistEmail || !artistPassword) {
    throw new Error(
      "The push stage needs PUSH_SUPABASE_URL, PUSH_SUPABASE_PUBLISHABLE_KEY, " +
        `PUSH_ARTIST_EMAIL and PUSH_ARTIST_PASSWORD.\n${PUSH_ENV_SETUP}`,
    );
  }

  return { url, publishableKey, artistEmail, artistPassword };
}

/**
 * Sign in as the demo artist over the publishable key and assert the account
 * can actually write.
 *
 * Failing here names the email and host explicitly: a failed
 * `private.is_artist()` would otherwise surface as 1000 opaque RLS rejections
 * on the first insert.
 */
async function signInPushArtist(
  target: PushTarget,
): Promise<{ client: SupabaseClient<Database>; artistUuid: string }> {
  // Not the `@supabase/ssr` browser factory — there is no cookie jar or
  // document here. `autoRefreshToken` stays on (the default): a 1000-object
  // upload runs for many minutes and the session must outlive its own token.
  const client = createClient<Database>(target.url, target.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: true },
  });

  const { data: signIn, error: signInError } =
    await client.auth.signInWithPassword({
      email: target.artistEmail,
      password: target.artistPassword,
    });

  if (signInError || !signIn.user) {
    throw new Error(
      `Could not sign in as ${target.artistEmail} at ${target.url}: ` +
        `${signInError?.message ?? "no user returned"}`,
    );
  }

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("role")
    .eq("id", signIn.user.id)
    .single();

  if (profileError || !profile || profile.role !== "artist") {
    throw new Error(
      `${target.artistEmail} at ${target.url} is not an artist ` +
        `(role: ${profile?.role ?? "unknown"}). Promote it through the account ` +
        'page\'s "Become an artist" form before pushing.',
    );
  }

  return { client, artistUuid: signIn.user.id };
}

/** What the push would write for one piece, under the target artist's uid. */
type DesiredRow = {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  image_path: string;
  created_at: string;
};

/** The comparable columns of a row already on the target. */
export type ExistingRow = {
  id: string;
  title: string;
  description: string | null;
  tags: string[];
  image_path: string;
  created_at: string;
};

/**
 * The ISO instant `artworkRow`'s SQL writes as
 * `timestamptz '2026-01-01 00:00:00+00' + interval 'N hour'` — computed here
 * instead of parsed from `CORPUS_EPOCH`, so the push and the SQL generator
 * agree on the value without one reading the other's string format.
 */
const CORPUS_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export function createdAtOf(piece: CorpusPiece): string {
  return new Date(
    CORPUS_EPOCH_MS + (piece.slot + 1) * 60 * 60 * 1000,
  ).toISOString();
}

function desiredRow(piece: CorpusPiece, artistUuid: string): DesiredRow {
  return {
    id: piece.piece_uuid,
    title: piece.title,
    description: descriptionFor(piece),
    tags: effectiveTags(piece),
    image_path: imagePathOf(piece, artistUuid),
    created_at: createdAtOf(piece),
  };
}

/** Which comparable columns differ, empty when the row is already correct. */
function staleFields(desired: DesiredRow, existing: ExistingRow): string[] {
  const fields: string[] = [];
  if (desired.title !== existing.title) fields.push("title");
  if (desired.description !== existing.description) fields.push("description");
  if (JSON.stringify(desired.tags) !== JSON.stringify(existing.tags)) {
    fields.push("tags");
  }
  if (desired.image_path !== existing.image_path) fields.push("image_path");
  // By instant, not by string: PostgREST renders a timestamptz as
  // "2026-01-01T01:00:00+00:00", while `createdAtOf`'s `toISOString()`
  // produces "2026-01-01T01:00:00.000Z" — the same instant, two spellings.
  // Comparing the raw strings flagged every row as stale.
  if (
    new Date(desired.created_at).getTime() !==
    new Date(existing.created_at).getTime()
  ) {
    fields.push("created_at");
  }
  return fields;
}

export type PushPlan = {
  artistUuid: string;
  toCreate: CorpusPiece[];
  toReplace: { piece: CorpusPiece; staleFields: string[] }[];
  toUpload: CorpusPiece[];
};

/**
 * The diff between the manifest and the target, across the four states a
 * piece can be in: row and object both present (nothing to do unless the row
 * has drifted), row only, object only, or neither.
 *
 * Pure and network-free so it is the part the unit tests actually exercise —
 * `runPush` is the thin network shell around it.
 */
export function buildPushPlan(
  pieces: readonly CorpusPiece[],
  artistUuid: string,
  existingRows: ReadonlyMap<string, ExistingRow>,
  existingObjectUuids: ReadonlySet<string>,
): PushPlan {
  const toCreate: CorpusPiece[] = [];
  const toReplace: { piece: CorpusPiece; staleFields: string[] }[] = [];
  const toUpload: CorpusPiece[] = [];

  for (const piece of pieces) {
    const existing = existingRows.get(piece.piece_uuid);

    if (!existing) {
      toCreate.push(piece);
    } else {
      const stale = staleFields(desiredRow(piece, artistUuid), existing);
      if (stale.length > 0) toReplace.push({ piece, staleFields: stale });
    }

    if (!existingObjectUuids.has(piece.piece_uuid)) {
      toUpload.push(piece);
    }
  }

  return { artistUuid, toCreate, toReplace, toUpload };
}

/** A 1000-element `in` filter is a URL-length hazard, so this chunks. */
const RECONCILE_ROW_CHUNK = 200;

async function fetchExistingRows(
  client: SupabaseClient<Database>,
  pieceUuids: readonly string[],
): Promise<Map<string, ExistingRow>> {
  const rows = new Map<string, ExistingRow>();

  for (let i = 0; i < pieceUuids.length; i += RECONCILE_ROW_CHUNK) {
    const chunk = pieceUuids.slice(i, i + RECONCILE_ROW_CHUNK);
    const { data, error } = await client
      .from("artworks")
      .select("id, title, description, tags, image_path, created_at")
      .in("id", chunk);

    if (error) {
      throw new Error(`Could not read existing artworks: ${error.message}`);
    }
    for (const row of data ?? []) {
      rows.set(row.id, row);
    }
  }

  return rows;
}

/** The storage API caps a page; the corpus is exactly 1000, so this paginates. */
const RECONCILE_OBJECT_PAGE = 1000;

async function fetchExistingObjectUuids(
  client: SupabaseClient<Database>,
  artistUuid: string,
): Promise<Set<string>> {
  const uuids = new Set<string>();
  let offset = 0;

  for (;;) {
    const { data, error } = await client.storage
      .from(ARTWORKS_BUCKET)
      .list(artistUuid, { limit: RECONCILE_OBJECT_PAGE, offset });

    if (error) {
      throw new Error(`Could not list existing objects: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const object of data) uuids.add(object.name.replace(/\.jpg$/, ""));

    if (data.length < RECONCILE_OBJECT_PAGE) break;
    offset += RECONCILE_OBJECT_PAGE;
  }

  return uuids;
}

/** One piece's upsert row, including the column `desiredRow` leaves out for the diff. */
export function artworkInsertRow(
  piece: CorpusPiece,
  artistUuid: string,
): DesiredRow & { artist_id: string } {
  return { artist_id: artistUuid, ...desiredRow(piece, artistUuid) };
}

export type PushFailure = {
  aic_id: number;
  piece_uuid: string;
  stage: "object" | "row";
  reason: string;
};

/**
 * Parallel object uploads. Kept small on the `ENRICH_CONCURRENCY` precedent —
 * this is a courtesy to the project's storage endpoint, not a throughput goal.
 */
const PUSH_UPLOAD_CONCURRENCY = 4;

/** Row writes chunked so one rejected batch fails at most this many pieces. */
const PUSH_ROW_CHUNK = 200;

/**
 * Upload every missing object under the artist's session, exactly the call
 * the browser makes. A missing local file is collected as a failure naming
 * the repair command, never a crash; everything else collected verbatim.
 */
async function uploadObjects(
  client: SupabaseClient<Database>,
  pieces: readonly CorpusPiece[],
  artistUuid: string,
  failures: PushFailure[],
): Promise<Set<string>> {
  const failed = new Set<string>();
  let done = 0;

  await inBatches(pieces, PUSH_UPLOAD_CONCURRENCY, async (piece) => {
    try {
      const bytes = await readFile(
        path.join(ASSET_DIR, `${piece.piece_uuid}.jpg`),
      );
      const { error } = await client.storage
        .from(ARTWORKS_BUCKET)
        .upload(imagePathOf(piece, artistUuid), bytes, {
          contentType: "image/jpeg",
          upsert: false,
        });
      if (error) throw new Error(error.message);
    } catch (error) {
      failed.add(piece.piece_uuid);
      const missingImage =
        error instanceof Error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      failures.push({
        aic_id: piece.aic_id,
        piece_uuid: piece.piece_uuid,
        stage: "object",
        reason: missingImage
          ? "image missing on disk — run `npm run db:seed:fetch` to repair it"
          : error instanceof Error
            ? error.message
            : String(error),
      });
    }

    done += 1;
    if (done % PROGRESS_EVERY === 0) {
      console.log(`  uploaded ${done}/${pieces.length}`);
    }
  });

  return failed;
}

/**
 * Upsert the given pieces' rows, chunked. The manifest is the source of
 * truth, so every comparable column is replaced on conflict — a re-push after
 * more enrichment is how corrected tags and descriptions reach production.
 */
async function writeRows(
  client: SupabaseClient<Database>,
  pieces: readonly CorpusPiece[],
  artistUuid: string,
  failures: PushFailure[],
): Promise<void> {
  for (let i = 0; i < pieces.length; i += PUSH_ROW_CHUNK) {
    const chunk = pieces.slice(i, i + PUSH_ROW_CHUNK);
    const rows = chunk.map((piece) => artworkInsertRow(piece, artistUuid));

    const { error } = await client
      .from("artworks")
      .upsert(rows, { onConflict: "id" });

    if (error) {
      for (const piece of chunk) {
        failures.push({
          aic_id: piece.aic_id,
          piece_uuid: piece.piece_uuid,
          stage: "row",
          reason: error.message,
        });
      }
    }
  }
}

async function runPush(): Promise<void> {
  const apply = process.argv.slice(3).includes("--apply");

  const target = requirePushTarget();

  const manifest = await readManifest();
  if (!manifest) {
    throw new Error(
      `No manifest at ${path.relative(REPO_ROOT, MANIFEST_PATH)} — run \`npm run db:seed:fetch\` first.`,
    );
  }

  const { client, artistUuid } = await signInPushArtist(target);
  const host = new URL(target.url).host;

  console.log(`Target: ${host}`);
  console.log(`Artist: ${target.artistEmail} (${artistUuid})`);

  const pieceUuids = manifest.pieces.map((piece) => piece.piece_uuid);
  const [existingRows, existingObjectUuids] = await Promise.all([
    fetchExistingRows(client, pieceUuids),
    fetchExistingObjectUuids(client, artistUuid),
  ]);

  const plan = buildPushPlan(
    manifest.pieces,
    artistUuid,
    existingRows,
    existingObjectUuids,
  );

  console.log(`Rows to create: ${plan.toCreate.length}`);
  console.log(`Rows to replace: ${plan.toReplace.length}`);
  console.log(`Objects to upload: ${plan.toUpload.length}`);

  const nothingToDo =
    plan.toCreate.length === 0 &&
    plan.toReplace.length === 0 &&
    plan.toUpload.length === 0;
  if (nothingToDo) {
    console.log("\nNothing to do.");
  }

  if (!apply) {
    console.log(
      "\nDry run — nothing written. Re-run as `npm run db:push -- --apply` to write.",
    );
    return;
  }

  if (nothingToDo) {
    console.log("\nNothing to apply.");
    return;
  }

  // Before the first write: a bad title or a malformed key should cost
  // nothing, not a partial push.
  verifyGeneratable(manifest, artistUuid);

  const failures: PushFailure[] = [];

  console.log(`\nUploading ${plan.toUpload.length} object(s)…`);
  const uploadFailed = await uploadObjects(
    client,
    plan.toUpload,
    artistUuid,
    failures,
  );

  // Object-then-row, per piece: a piece whose upload failed gets no row, so a
  // partial run never leaves a row pointing at nothing.
  const toWrite = [
    ...plan.toCreate,
    ...plan.toReplace.map(({ piece }) => piece),
  ].filter((piece) => !uploadFailed.has(piece.piece_uuid));

  console.log(`Writing ${toWrite.length} row(s)…`);
  await writeRows(client, toWrite, artistUuid, failures);

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`);
    for (const failure of failures) {
      console.log(
        `  ${failure.stage} — aic ${failure.aic_id} (${failure.piece_uuid}): ${failure.reason}`,
      );
    }
    console.log(
      "\nRe-run to retry only the failures — everything that landed is skipped by reconciliation.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nDone. Re-run the dry run to verify nothing is left to do.");
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const STAGES: Record<string, () => Promise<void>> = {
  fetch: runFetch,
  enrich: runEnrich,
  coverage: runCoverage,
  generate: runGenerate,
  push: runPush,
};

async function main(): Promise<void> {
  const stage = process.argv[2];

  const run = stage ? STAGES[stage] : undefined;
  if (run) {
    await run();
    return;
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
