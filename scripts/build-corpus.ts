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
 *   npm run db:seed:fetch
 *
 * which is `tsx --conditions=react-server`. Both halves are load-bearing. `tsx`
 * resolves the extensionless relative imports inside `src/lib/**` that Node ESM
 * rejects, and `--conditions=react-server` maps `import "server-only"` onto its
 * empty stub instead of the bare `throw` its default export is.
 *
 * LOCAL DEVELOPMENT ONLY. This writes seed data for `supabase db reset`.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TAXONOMY_BY_FACET, type Facet } from "@/lib/ai/taxonomy";

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

/** AIC's `color`, as returned by the search API. */
export type AicColor = { h: number; s: number; l: number } | null | undefined;

export type AicArtwork = {
  id: number;
  title?: string | null;
  artist_title?: string | null;
  image_id?: string | null;
  classification_titles?: string[] | null;
  subject_titles?: string[] | null;
  medium_display?: string | null;
  color?: AicColor;
  thumbnail?: { width?: number | null } | null;
};

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

// ---------------------------------------------------------------------------
// Manifest IO
// ---------------------------------------------------------------------------

/**
 * Written with a fixed key order and a trailing newline so a regeneration
 * shows up as a content diff rather than a reshuffle. `corpus.json` is in
 * `.prettierignore` for the same reason: this writer owns its formatting.
 */
async function writeManifest(manifest: CorpusManifest): Promise<void> {
  const ordered: CorpusManifest = {
    version: manifest.version,
    source: manifest.source,
    pieces: [...manifest.pieces]
      .sort((a, b) => a.aic_id - b.aic_id)
      .map((piece) => ({
        aic_id: piece.aic_id,
        image_id: piece.image_id,
        piece_uuid: piece.piece_uuid,
        title: piece.title,
        artist: piece.artist,
        tags_from_metadata: piece.tags_from_metadata,
        image_width: piece.image_width,
        slot: piece.slot,
      })),
  };

  await writeFile(MANIFEST_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
}

async function readManifest(): Promise<CorpusManifest | null> {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as CorpusManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

  const payload = (await response.json()) as { data?: AicArtwork[] };
  return payload.data ?? [];
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

  await writeFile(path.join(ASSET_DIR, `${piece.piece_uuid}.jpg`), bytes);
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

async function selectPieces(): Promise<FamilySample[]> {
  const seen = new Set<number>();
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

  const familyTargets = allocate(
    gathered.map((byBucket) => byBucket.reduce((n, b) => n + b.length, 0)),
    TARGET_TOTAL,
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
  try {
    const files = await readdir(ASSET_DIR);
    return new Set(
      files
        .filter((f) => f.endsWith(".jpg"))
        .map((f) => f.replace(/\.jpg$/, "")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

async function runFetch(): Promise<void> {
  await mkdir(ASSET_DIR, { recursive: true });

  const existing = await readManifest();
  const complete = existing !== null && existing.pieces.length >= TARGET_TOTAL;

  let pieces: CorpusPiece[];

  if (complete) {
    // The manifest is the source of truth once it is populated. Re-running is
    // a no-op that only replaces missing image files, so it never reshuffles a
    // corpus other stages have already enriched, overridden or generated from.
    console.log(
      `Manifest already holds ${existing.pieces.length} pieces — skipping AIC sampling.`,
    );
    pieces = existing.pieces;

    const already = await downloadedUuids();
    const missing = pieces.filter((p) => !already.has(p.piece_uuid));
    console.log(
      `Images: ${pieces.length - missing.length} present, ${missing.length} to download.`,
    );
    let done = 0;
    await inBatches(missing, DOWNLOAD_CONCURRENCY, async (piece) => {
      await downloadImage(piece);
      done += 1;
      if (done % PROGRESS_EVERY === 0) {
        console.log(`  ${done}/${missing.length}`);
      }
    });
  } else {
    console.log(`Sampling ${FAMILIES.length} families from AIC…`);
    const samples = await selectPieces();

    console.log(`Downloading ${TARGET_TOTAL} images…`);
    pieces = [];
    for (const sample of samples) {
      const kept = await downloadFamily(sample);
      console.log(
        `  ${sample.family.padEnd(11)} ${String(kept.length).padStart(4)} downloaded (${pieces.length + kept.length} total)`,
      );
      pieces.push(...kept);
    }

    assignSlots(pieces);
  }

  await writeManifest({
    version: MANIFEST_VERSION,
    source: {
      api: AIC_API,
      iiif_url: IIIF_BASE,
      licence: LICENCE,
      query: SAMPLING_QUERY,
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
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const STAGES: Record<string, () => Promise<void>> = {
  fetch: runFetch,
};

/** Stages the npm scripts expose that later phases of this change still owe. */
const PLANNED_STAGES: Record<string, string> = {
  enrich: "phase 2",
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
