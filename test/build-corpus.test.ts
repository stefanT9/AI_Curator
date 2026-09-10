import { describe, expect, it } from "vitest";

import {
  ARTIST_UUID,
  artworkInsertRow,
  artworkRow,
  buildPushPlan,
  combineTags,
  coverageReport,
  createdAtOf,
  descriptionFor,
  effectiveTags,
  enrichedTags,
  facetOf,
  imagePathOf,
  mediumTags,
  paletteTags,
  parseLimit,
  renderGeneratedRegion,
  selectLikeHistory,
  selectPending,
  selectUntagged,
  sqlString,
  sqlTagArray,
  subjectTags,
  truncateTitle,
  type AicArtwork,
  type CorpusManifest,
  type CorpusPiece,
  type ExistingRow,
} from "../scripts/build-corpus";
import { ARTWORK_TAGS, TAXONOMY_BY_FACET } from "@/lib/ai/taxonomy";
import { MAX_TAGS } from "@/lib/artworks/tags";

/**
 * An ordinary corpus of `n` pieces: slot `i`, a UUID that sorts the same way,
 * one metadata tag and one style/mood pair. Shared by every suite below that
 * needs a manifest rather than a hand-built edge case.
 */
const corpusPieces = (n: number): CorpusPiece[] =>
  Array.from({ length: n }, (_, i) => ({
    aic_id: i,
    image_id: `image-${i}`,
    piece_uuid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    title: `Piece ${i}`,
    artist: null,
    tags_from_metadata: ["oil painting"],
    image_width: 843,
    slot: i,
    tags_from_enrichment: ["abstract", "serene"],
  }));

/**
 * The pure decisions inside `scripts/build-corpus.ts`.
 *
 * No network and no model: the mappers are fed a pinned payload and the
 * combiner is fed arrays. The stages themselves — which talk to AIC and
 * OpenRouter — are exercised by hand, per the plan's testing strategy.
 */

/**
 * Van Gogh's *The Bedroom*, exactly as `GET /artworks/28560` returned it on
 * 2026-09-10 with the fields this script requests. Pinned rather than fetched:
 * the default lane never leaves the machine, and a real payload is the only
 * thing that proves the mappers survive AIC's actual shapes — a compound
 * `medium_display`, a 6-entry `classification_titles`, and a `subject_titles`
 * of 20 entries of which exactly one is in our vocabulary.
 */
const BEDROOM: AicArtwork = {
  id: 28560,
  title: "The Bedroom",
  artist_title: "Vincent van Gogh",
  image_id: "6644829f-f292-c5c4-a73c-0356a6fdbf0d",
  medium_display: "Oil on canvas",
  classification_titles: [
    "oil on canvas",
    "dutch",
    "oil paintings (visual works)",
    "paint",
    "painting",
    "european painting",
  ],
  subject_titles: [
    "interiors",
    "basin",
    "blue (color)",
    "chair",
    "chairs",
    "doors",
    "France",
    "green (color)",
    "mirror",
    "painting",
    "pitcher",
    "red (color)",
    "table",
    "window",
    "domestic scenes",
    "Century of Progress",
    "world's fairs",
    "Chicago World's Fairs",
    "beds",
    "bedrooms",
  ],
  color: { h: 40, l: 34, s: 65 },
  thumbnail: { width: 12614 },
};

describe("mediumTags", () => {
  it("maps a real AIC payload onto medium taxonomy terms", () => {
    expect(mediumTags(BEDROOM)).toEqual(["oil painting"]);
  });

  it("emits only members of the medium facet", () => {
    for (const tag of mediumTags(BEDROOM)) {
      expect(TAXONOMY_BY_FACET.medium).toContain(tag);
    }
  });

  it("leaves a family with no counterpart untagged rather than guessing", () => {
    // `engraving` and `woodblock print` are AIC's two largest print
    // classifications and have no term in the medium facet. Inventing one
    // would put a false tag on a real artwork.
    const engraving: AicArtwork = {
      ...BEDROOM,
      classification_titles: ["engraving", "print"],
      medium_display: "Engraving on ivory laid paper",
    };
    expect(mediumTags(engraving)).toEqual([]);
  });

  it("returns nothing when AIC supplies no medium fields at all", () => {
    expect(
      mediumTags({
        ...BEDROOM,
        classification_titles: null,
        medium_display: null,
      }),
    ).toEqual([]);
  });
});

describe("subjectTags", () => {
  it("keeps the one vocabulary term out of twenty subject titles", () => {
    expect(subjectTags(BEDROOM)).toEqual(["interior"]);
  });

  it("emits only members of the subject facet", () => {
    for (const tag of subjectTags(BEDROOM)) {
      expect(TAXONOMY_BY_FACET.subject).toContain(tag);
    }
  });

  it("dedupes two AIC titles that map onto one term", () => {
    expect(
      subjectTags({ ...BEDROOM, subject_titles: ["interior", "interiors"] }),
    ).toEqual(["interior"]);
  });
});

describe("paletteTags", () => {
  it("classifies a real colour reading", () => {
    // h 40 sits between the red range (ends at 30) and the green one (starts
    // at 75), so saturation alone speaks: s 65 is above the muted ceiling.
    expect(paletteTags(BEDROOM.color)).toEqual(["vivid"]);
  });

  it("returns nothing when AIC has no colour reading", () => {
    expect(paletteTags(null)).toEqual([]);
    expect(paletteTags(undefined)).toEqual([]);
  });

  describe("saturation bands at their boundaries", () => {
    // Each band is closed at the top: `s <= limit` belongs to the band, and
    // one point above it belongs to the next one up.
    const band = (s: number) => paletteTags({ h: 200, s, l: 50 })[0];

    it("8 is monochrome and 9 is desaturated", () => {
      expect(band(8)).toBe("monochrome");
      expect(band(9)).toBe("desaturated");
    });

    it("25 is desaturated and 26 is muted", () => {
      expect(band(25)).toBe("desaturated");
      expect(band(26)).toBe("muted");
    });

    it("50 is muted and 51 is vivid", () => {
      expect(band(50)).toBe("muted");
      expect(band(51)).toBe("vivid");
    });
  });

  describe("black and white at the lightness boundaries", () => {
    const at = (l: number) => paletteTags({ h: 0, s: 4, l });

    it("adds black and white only at the dark and light extremes", () => {
      expect(at(25)).toContain("black and white");
      expect(at(26)).not.toContain("black and white");
      expect(at(75)).toContain("black and white");
      expect(at(74)).not.toContain("black and white");
    });
  });

  describe("hue only above the noise floor", () => {
    it("reads a hue at 25 saturation but not at 24", () => {
      expect(paletteTags({ h: 200, s: 25, l: 50 })).toContain("blue dominant");
      expect(paletteTags({ h: 200, s: 24, l: 50 })).not.toContain(
        "blue dominant",
      );
    });

    it("wraps red across the 360/0 seam", () => {
      expect(paletteTags({ h: 350, s: 80, l: 50 })).toContain("red dominant");
      expect(paletteTags({ h: 10, s: 80, l: 50 })).toContain("red dominant");
      expect(paletteTags({ h: 45, s: 80, l: 50 })).not.toContain(
        "red dominant",
      );
    });
  });

  it("emits only members of the palette facet", () => {
    for (const s of [0, 8, 20, 40, 90]) {
      for (const h of [0, 100, 200, 340]) {
        for (const tag of paletteTags({ h, s, l: 50 })) {
          expect(TAXONOMY_BY_FACET.palette).toContain(tag);
        }
      }
    }
  });
});

describe("truncateTitle", () => {
  const MAX = 120;

  it("leaves a title of exactly the ceiling untouched", () => {
    const exact = "a".repeat(MAX);
    expect(truncateTitle(exact)).toBe(exact);
    expect(truncateTitle(exact)).toHaveLength(MAX);
  });

  it("truncates one character over the ceiling to within it", () => {
    const over = "a".repeat(MAX + 1);
    const out = truncateTitle(over);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  it("breaks on a word boundary rather than mid-word", () => {
    const long = `${"word ".repeat(30)}tail`;
    const out = truncateTitle(long);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out).toBe(`${"word ".repeat(23).trim()}…`);
  });

  it("keeps a single unbroken word rather than emitting an ellipsis alone", () => {
    // No space past the halfway mark, so a word break would throw the title
    // away. A hard cut is the lesser evil.
    const out = truncateTitle("z".repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out).toBe(`${"z".repeat(MAX - 1)}…`);
  });

  it("collapses whitespace before measuring", () => {
    expect(truncateTitle("  The   Bedroom \n")).toBe("The Bedroom");
  });
});

describe("facetOf", () => {
  it("places every taxonomy term in exactly one facet", () => {
    for (const tag of ARTWORK_TAGS) {
      expect(facetOf(tag)).not.toBeNull();
    }
  });

  it("returns null for a term outside the vocabulary", () => {
    expect(facetOf("neon street")).toBeNull();
  });
});

describe("enrichedTags", () => {
  it("keeps style and mood and discards the facets the museum supplies", () => {
    expect(
      enrichedTags([
        "oil painting",
        "expressionist",
        "interior",
        "serene",
        "vivid",
      ]),
    ).toEqual(["expressionist", "serene"]);
  });

  it("drops a term outside the vocabulary", () => {
    expect(enrichedTags(["expressionist", "post-impressionist"])).toEqual([
      "expressionist",
    ]);
  });
});

describe("combineTags", () => {
  it("concatenates and dedupes when under the ceiling", () => {
    expect(
      combineTags(["oil painting", "interior"], ["serene", "interior"]),
    ).toEqual(["oil painting", "interior", "serene"]);
  });

  it("leaves a set of exactly the ceiling untouched and in order", () => {
    const metadata = TAXONOMY_BY_FACET.medium.slice(0, MAX_TAGS);
    expect(combineTags(metadata, [])).toEqual([...metadata]);
  });

  it("caps an over-full set at the ceiling", () => {
    const out = combineTags(
      [
        ...TAXONOMY_BY_FACET.medium.slice(0, 10),
        ...TAXONOMY_BY_FACET.subject.slice(0, 10),
        ...TAXONOMY_BY_FACET.palette.slice(0, 10),
      ],
      [
        ...TAXONOMY_BY_FACET.style.slice(0, 6),
        ...TAXONOMY_BY_FACET.mood.slice(0, 6),
      ],
    );

    expect(out).toHaveLength(MAX_TAGS);
    expect(new Set(out).size).toBe(MAX_TAGS);
  });

  it("trims round-robin so the smallest facet is not the one that vanishes", () => {
    // The failure this guards: metadata leads the concatenation and is
    // medium/subject/palette-heavy, so a flat truncation drops mood entirely.
    const metadata = [
      ...TAXONOMY_BY_FACET.medium.slice(0, 10),
      ...TAXONOMY_BY_FACET.subject.slice(0, 10),
      ...TAXONOMY_BY_FACET.palette.slice(0, 10),
    ];
    const enrichment = [
      ...TAXONOMY_BY_FACET.style.slice(0, 3),
      ...TAXONOMY_BY_FACET.mood.slice(0, 3),
    ];

    const flat = [...metadata, ...enrichment].slice(0, MAX_TAGS);
    expect(flat.filter((t) => facetOf(t) === "mood")).toHaveLength(0);

    const out = combineTags(metadata, enrichment);
    for (const facet of [
      "medium",
      "subject",
      "palette",
      "style",
      "mood",
    ] as const) {
      expect(out.filter((t) => facetOf(t) === facet).length).toBeGreaterThan(0);
    }
  });

  it("gives a facet with few terms all of them before spreading the rest", () => {
    const out = combineTags(TAXONOMY_BY_FACET.medium.slice(0, 18), [
      "abstract",
      "serene",
      "dramatic",
    ]);

    expect(out).toHaveLength(MAX_TAGS);
    expect(out).toContain("abstract");
    expect(out).toContain("serene");
    expect(out).toContain("dramatic");
  });

  it("gives a term outside the vocabulary its own round-robin turn", () => {
    // Artist-typed tags are free text by design, so an unknown term is not a
    // bug. It gets a bucket of its own and takes a turn like any facet, rather
    // than being crowded out by twenty terms from one facet.
    const out = combineTags(
      [...TAXONOMY_BY_FACET.medium.slice(0, 20), "artist's own tag"],
      [],
    );
    expect(out).toHaveLength(MAX_TAGS);
    expect(out).toContain("artist's own tag");
  });
});

describe("parseLimit", () => {
  it("returns null when no limit is given", () => {
    expect(parseLimit([])).toBeNull();
    expect(parseLimit(["--verbose"])).toBeNull();
  });

  it("accepts both spellings", () => {
    expect(parseLimit(["--limit", "25"])).toBe(25);
    expect(parseLimit(["--limit=25"])).toBe(25);
  });

  it("rejects anything that is not a positive whole number", () => {
    // A silently-ignored bad limit would run all 1000 pieces against a paid
    // daily cap when the caller asked for a 25-piece trial.
    expect(() => parseLimit(["--limit", "0"])).toThrow(/positive whole number/);
    expect(() => parseLimit(["--limit", "-5"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseLimit(["--limit", "2.5"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseLimit(["--limit", "all"])).toThrow(
      /positive whole number/,
    );
    expect(() => parseLimit(["--limit"])).toThrow(/positive whole number/);
  });
});

describe("selectPending", () => {
  const piece = (
    aic_id: number,
    extra: Partial<CorpusPiece> = {},
  ): CorpusPiece => ({
    aic_id,
    image_id: `image-${aic_id}`,
    piece_uuid: `00000000-0000-4000-8000-${String(aic_id).padStart(12, "0")}`,
    title: `Piece ${aic_id}`,
    artist: null,
    tags_from_metadata: [],
    image_width: 843,
    slot: aic_id,
    ...extra,
  });

  const fresh = piece(1);
  const tagged = piece(2, {
    tags_from_enrichment: ["abstract"],
    description: "…",
  });
  const failed = piece(3, {
    tags_from_enrichment: [],
    description: null,
    enrichment_failed: "rate_limited",
  });
  const all = [fresh, tagged, failed];

  it("resumes: only never-enriched pieces, by default", () => {
    expect(selectPending(all)).toEqual([fresh]);
  });

  it("makes no work at all over a finished manifest", () => {
    // This is criterion 2.9's substance: a re-run over a manifest where every
    // piece is pinned must call the model zero times.
    expect(selectPending([tagged, failed])).toEqual([]);
  });

  it("leaves a pinned failure alone unless asked", () => {
    expect(selectPending(all)).not.toContain(failed);
  });

  it("reopens pinned failures with retryFailed, and puts them first", () => {
    expect(selectPending(all, { retryFailed: true })).toEqual([failed, fresh]);
  });

  it("never reopens a piece that succeeded", () => {
    expect(selectPending(all, { retryFailed: true })).not.toContain(tagged);
  });

  it("applies the limit across the queue, retries first", () => {
    // `--retry-failed --limit 1` is the way to clear failures and nothing else.
    expect(selectPending(all, { retryFailed: true, limit: 1 })).toEqual([
      failed,
    ]);
  });

  it("treats a null limit as no limit", () => {
    expect(selectPending(all, { limit: null })).toEqual([fresh]);
  });
});

describe("the untagged tail", () => {
  const corpus = corpusPieces;

  describe("selectUntagged", () => {
    it("holds back five percent of the corpus", () => {
      expect(selectUntagged(corpus(1000))).toHaveLength(50);
      expect(selectUntagged(corpus(200))).toHaveLength(10);
    });

    it("spreads the tail evenly across the slot range", () => {
      const slots = selectUntagged(corpus(1000))
        .map((piece) => piece.slot)
        .sort((a, b) => a - b);
      const gaps = new Set(slots.slice(1).map((slot, i) => slot - slots[i]));
      expect(gaps).toEqual(new Set([20]));
    });

    it("puts a piece in the first and last twenty slots either way round", () => {
      // `slot` becomes the created_at offset, and which end counts as newest is
      // the generator's business. A tail that missed one end would leave the
      // untagged sort key unobservable in the first deck a collector sees.
      const slots = selectUntagged(corpus(1000)).map((piece) => piece.slot);
      expect(slots.some((slot) => slot < 20)).toBe(true);
      expect(slots.some((slot) => slot >= 980)).toBe(true);
    });

    it("is deterministic — same pieces every time", () => {
      const once = selectUntagged(corpus(1000)).map((p) => p.piece_uuid);
      const twice = selectUntagged(corpus(1000)).map((p) => p.piece_uuid);
      expect(once).toEqual(twice);
    });

    it("selects by slot, not by array order", () => {
      const shuffled = [...corpus(100)].reverse();
      const slots = selectUntagged(shuffled).map((piece) => piece.slot);
      expect(slots).toEqual([...slots].sort((a, b) => a - b));
    });
  });

  describe("effectiveTags", () => {
    const [piece] = corpus(1);

    it("combines metadata and enrichment for an ordinary piece", () => {
      expect(effectiveTags(piece)).toEqual([
        "oil painting",
        "abstract",
        "serene",
      ]);
    });

    it("gives an untagged piece nothing at all", () => {
      // Counting its museum tags would report coverage the getStarterDeck
      // overlap can never find, because the generator emits '{}' for it.
      expect(effectiveTags({ ...piece, untagged: true })).toEqual([]);
    });

    it("handles a piece that has never been enriched", () => {
      const bare: CorpusPiece = { ...piece };
      delete bare.tags_from_enrichment;
      expect(effectiveTags(bare)).toEqual(["oil painting"]);
    });
  });
});

describe("coverageReport", () => {
  const piece = (
    slot: number,
    tags: string[],
    extra: Partial<CorpusPiece> = {},
  ): CorpusPiece => ({
    aic_id: slot,
    image_id: `image-${slot}`,
    piece_uuid: `00000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
    title: `Piece ${slot}`,
    artist: null,
    tags_from_metadata: tags,
    image_width: 843,
    slot,
    ...extra,
  });

  it("reports every facet and every term, covered or not", () => {
    const report = coverageReport([piece(0, ["oil painting"])]);
    expect(report.map((facet) => facet.facet)).toEqual([
      "medium",
      "style",
      "subject",
      "palette",
      "mood",
    ]);
    for (const facet of report) {
      expect(facet.counts).toHaveLength(20);
      expect(facet.total).toBe(20);
    }
  });

  it("counts pieces per term", () => {
    const report = coverageReport([
      piece(0, ["oil painting"]),
      piece(1, ["oil painting"]),
      piece(2, ["etching"]),
    ]);
    const medium = report.find((facet) => facet.facet === "medium")!;
    expect(medium.counts.find((c) => c.term === "oil painting")?.pieces).toBe(
      2,
    );
    expect(medium.counts.find((c) => c.term === "etching")?.pieces).toBe(1);
    expect(medium.counts.find((c) => c.term === "acrylic")?.pieces).toBe(0);
    expect(medium.covered).toBe(2);
  });

  it("treats one piece as covered — the threshold the query uses", () => {
    // getStarterDeck's .overlaps either returns rows or it does not;
    // ONBOARDING_POOL_SIZE is only a ceiling on how many it takes.
    const report = coverageReport([piece(0, ["etching"])]);
    const medium = report.find((facet) => facet.facet === "medium")!;
    expect(medium.covered).toBe(1);
  });

  it("does not count an untagged piece towards any term", () => {
    const report = coverageReport([
      piece(0, ["oil painting"], { untagged: true }),
    ]);
    expect(report.every((facet) => facet.covered === 0)).toBe(true);
  });

  it("counts style and mood terms that came from enrichment", () => {
    const report = coverageReport([
      piece(0, ["oil painting"], {
        tags_from_enrichment: ["abstract", "serene"],
      }),
    ]);
    expect(report.find((f) => f.facet === "style")!.covered).toBe(1);
    expect(report.find((f) => f.facet === "mood")!.covered).toBe(1);
  });
});

describe("SQL literals", () => {
  it("doubles apostrophes — AIC titles are full of them", () => {
    expect(sqlString("L'Arlésienne")).toBe("'L''Arlésienne'");
    expect(sqlString("D'Apres Les Maitres d'Art")).toBe(
      "'D''Apres Les Maitres d''Art'",
    );
  });

  it("leaves an ordinary string alone but for the quotes", () => {
    expect(sqlString("Sauce Boat")).toBe("'Sauce Boat'");
  });

  it("double-quotes every array element, multi-word or not", () => {
    // Over half the vocabulary is multi-word, so quoting only when needed is a
    // rule with an exception — and the exception is what breaks.
    expect(sqlTagArray(["oil painting", "muted"])).toBe(
      '\'{"oil painting","muted"}\'',
    );
  });

  it("emits an empty array for the untagged tail", () => {
    expect(sqlTagArray([])).toBe("'{}'");
  });

  it("escapes for the array parser and then for SQL", () => {
    // No taxonomy term needs this today; a hand-edited manifest might.
    expect(sqlTagArray(['a"b', "c\\d", "e'f"])).toBe(
      '\'{"a\\"b","c\\\\d","e\'\'f"}\'',
    );
  });
});

describe("imagePathOf", () => {
  const [piece] = corpusPieces(1);

  it("satisfies image_path_pattern", () => {
    expect(imagePathOf(piece)).toMatch(
      /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/,
    );
  });

  it("files the piece under the seeded artist, which is what db:seed:images uploads", () => {
    expect(imagePathOf(piece)).toBe(
      `00000000-0000-4000-8000-000000000001/${piece.piece_uuid}.jpg`,
    );
  });

  it("files under a non-default artist uid and still satisfies the pattern", () => {
    const target = "11111111-2222-4333-8444-555555555555";
    const path = imagePathOf(piece, target);
    expect(path).toBe(`${target}/${piece.piece_uuid}.jpg`);
    expect(path).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/);
  });
});

describe("descriptionFor", () => {
  const [base] = corpusPieces(1);

  it("appends an attribution line to the model's paragraph", () => {
    const text = descriptionFor({
      ...base,
      artist: "Vincent van Gogh",
      description: "I painted the room as I remembered sleeping in it.",
    });
    expect(text).toBe(
      "I painted the room as I remembered sleeping in it.\n\n" +
        "Vincent van Gogh — Art Institute of Chicago, object 0. Public domain (CC0).",
    );
  });

  it("names an anonymous artist rather than leaving a dangling dash", () => {
    expect(
      descriptionFor({ ...base, artist: null, description: "A study." }),
    ).toContain("Unknown artist — Art Institute of Chicago");
  });

  it("carries attribution alone when enrichment produced nothing", () => {
    const bare: CorpusPiece = { ...base, artist: "Anon" };
    delete bare.description;
    expect(descriptionFor(bare)).toBe(
      "Anon — Art Institute of Chicago, object 0. Public domain (CC0).",
    );
  });

  it("drops the description entirely for an untagged-tail piece", () => {
    // The tail stands in for artworks published before enrichment existed:
    // no tags and no description, so the same rendering path is exercised.
    expect(
      descriptionFor({ ...base, description: "A study.", untagged: true }),
    ).toBeNull();
  });

  it("stays inside artworks_description_length", () => {
    const text = descriptionFor({
      ...base,
      artist: "A".repeat(200),
      description: "x".repeat(5000),
    })!;
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("Public domain (CC0).");
  });
});

describe("selectLikeHistory", () => {
  const styled = (slot: number, style: string[]): CorpusPiece => ({
    aic_id: slot,
    image_id: `image-${slot}`,
    piece_uuid: `00000000-0000-4000-8000-${String(slot).padStart(12, "0")}`,
    title: `Piece ${slot}`,
    artist: null,
    tags_from_metadata: ["oil painting"],
    image_width: 843,
    slot,
    tags_from_enrichment: style,
  });

  it("picks the most populous style term", () => {
    const pieces = [
      ...Array.from({ length: 10 }, (_, i) => styled(i, ["figurative"])),
      ...Array.from({ length: 3 }, (_, i) => styled(100 + i, ["abstract"])),
    ];
    expect(selectLikeHistory(pieces)?.tag).toBe("figurative");
  });

  it("ignores non-style terms however populous", () => {
    // `oil painting` is on every piece; a like history there would say nothing
    // about taste, and the onboarding picker works in the style facet.
    const pieces = Array.from({ length: 10 }, (_, i) =>
      styled(i, ["abstract"]),
    );
    expect(selectLikeHistory(pieces)?.tag).toBe("abstract");
  });

  it("takes the oldest members, leaving the group's newest unseen", () => {
    const pieces = Array.from({ length: 20 }, (_, i) =>
      styled(i, ["figurative"]),
    );
    const history = selectLikeHistory(pieces)!;
    expect(history.piece_uuids).toHaveLength(8);
    expect(history.piece_uuids).toEqual(
      pieces.slice(0, 8).map((piece) => piece.piece_uuid),
    );
  });

  it("skips untagged pieces — they reach the database with no tags at all", () => {
    const pieces = [
      ...Array.from({ length: 4 }, (_, i) => styled(i, ["figurative"])),
      ...Array.from({ length: 4 }, (_, i) => ({
        ...styled(50 + i, ["figurative"]),
        untagged: true,
      })),
    ];
    expect(selectLikeHistory(pieces)!.piece_uuids).toHaveLength(4);
  });

  it("breaks a tie on the term, not on tally order", () => {
    const forwards = [styled(0, ["abstract"]), styled(1, ["figurative"])];
    const backwards = [...forwards].reverse();
    expect(selectLikeHistory(forwards)?.tag).toBe("abstract");
    expect(selectLikeHistory(backwards)?.tag).toBe("abstract");
  });

  it("returns null when nothing has been enriched yet", () => {
    const bare = corpusPieces(3).map((piece) => {
      const copy: CorpusPiece = { ...piece };
      delete copy.tags_from_enrichment;
      return copy;
    });
    expect(selectLikeHistory(bare)).toBeNull();
  });
});

describe("renderGeneratedRegion", () => {
  const manifest = (pieces: CorpusPiece[]): CorpusManifest => ({
    version: 1,
    source: {
      api: "https://api.artic.edu/api/v1",
      iiif_url: "https://www.artic.edu/iiif/2",
      licence: "CC0",
      query: "test",
      sampled_at: "2026-01-01T00:00:00.000Z",
    },
    pieces,
    like_history: selectLikeHistory(pieces) ?? undefined,
  });

  it("opens with the marker so the stage can find its own region again", () => {
    const sql = renderGeneratedRegion(manifest(corpusPieces(3)));
    expect(sql.startsWith("-- === GENERATED BY scripts/build-corpus.ts")).toBe(
      true,
    );
  });

  it("emits one artworks row per piece, in slot order", () => {
    const sql = renderGeneratedRegion(manifest([...corpusPieces(5)].reverse()));
    const hours = [...sql.matchAll(/interval '(\d+) hour'/g)].map((m) =>
      Number(m[1]),
    );
    expect(hours).toEqual([1, 2, 3, 4, 5]);
  });

  it("is byte-identical across runs — the regeneration contract", () => {
    const pieces = corpusPieces(20);
    expect(renderGeneratedRegion(manifest(pieces))).toBe(
      renderGeneratedRegion(manifest(pieces)),
    );
  });

  it("guards both inserts with on conflict do nothing", () => {
    const sql = renderGeneratedRegion(manifest(corpusPieces(10)));
    expect(sql).toContain("on conflict (id) do nothing;");
    expect(sql).toContain("on conflict (user_id, artwork_id) do nothing;");
  });

  it("likes only for the warm collector", () => {
    const sql = renderGeneratedRegion(manifest(corpusPieces(10)));
    const rows = sql
      .slice(sql.indexOf("insert into public.interactions"))
      .split("\n")
      .filter((line) => line.startsWith("  ("));
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((line) =>
        line.startsWith("  ('00000000-0000-4000-8000-000000000002', "),
      ),
    ).toBe(true);
  });

  it("omits the interactions insert when there is no like history", () => {
    const bare = corpusPieces(3).map((piece) => {
      const copy: CorpusPiece = { ...piece };
      delete copy.tags_from_enrichment;
      return copy;
    });
    const sql = renderGeneratedRegion(manifest(bare));
    expect(sql).not.toContain("insert into public.interactions");
  });

  it("gives untagged pieces an empty tag array and a null description", () => {
    const [piece] = corpusPieces(1);
    const sql = renderGeneratedRegion(
      manifest([{ ...piece, untagged: true, description: "dropped" }]),
    );
    expect(sql).toContain(", null, '{}', ");
    expect(sql).not.toContain("dropped");
  });
});

describe("createdAtOf", () => {
  it("matches the SQL generator's stagger — slot N lands N+1 hours after the epoch", () => {
    const [piece] = corpusPieces(1);
    expect(createdAtOf({ ...piece, slot: 0 })).toBe("2026-01-01T01:00:00.000Z");
    expect(createdAtOf({ ...piece, slot: 4 })).toBe("2026-01-01T05:00:00.000Z");
  });
});

describe("buildPushPlan", () => {
  const artistUuid = "11111111-2222-4333-8444-555555555555";

  /** The exact row `runPush` would write for this piece against `artistUuid`. */
  const rowFor = (piece: CorpusPiece): ExistingRow => ({
    id: piece.piece_uuid,
    title: piece.title,
    description: descriptionFor(piece),
    tags: effectiveTags(piece),
    image_path: imagePathOf(piece, artistUuid),
    created_at: createdAtOf(piece),
  });

  it("covers the four presence states a piece can be in", () => {
    const [both, rowOnly, objectOnly, neither] = corpusPieces(4);

    const existingRows = new Map<string, ExistingRow>([
      [both.piece_uuid, rowFor(both)],
      [rowOnly.piece_uuid, rowFor(rowOnly)],
    ]);
    const existingObjectUuids = new Set([
      both.piece_uuid,
      objectOnly.piece_uuid,
    ]);

    const plan = buildPushPlan(
      [both, rowOnly, objectOnly, neither],
      artistUuid,
      existingRows,
      existingObjectUuids,
    );

    expect(plan.toCreate.map((p) => p.piece_uuid)).toEqual([
      objectOnly.piece_uuid,
      neither.piece_uuid,
    ]);
    expect(plan.toReplace).toEqual([]);
    expect(plan.toUpload.map((p) => p.piece_uuid)).toEqual([
      rowOnly.piece_uuid,
      neither.piece_uuid,
    ]);
  });

  it("reports nothing to do once every row and every object already match", () => {
    const pieces = corpusPieces(3);
    const existingRows = new Map(
      pieces.map((piece) => [piece.piece_uuid, rowFor(piece)]),
    );
    const existingObjectUuids = new Set(
      pieces.map((piece) => piece.piece_uuid),
    );

    const plan = buildPushPlan(
      pieces,
      artistUuid,
      existingRows,
      existingObjectUuids,
    );

    expect(plan.toCreate).toEqual([]);
    expect(plan.toReplace).toEqual([]);
    expect(plan.toUpload).toEqual([]);
  });

  it("flags a row whose description has drifted from the manifest, naming the field", () => {
    const [piece] = corpusPieces(1);
    const stale = { ...rowFor(piece), description: "an old description" };
    const existingRows = new Map([[piece.piece_uuid, stale]]);
    const existingObjectUuids = new Set([piece.piece_uuid]);

    const plan = buildPushPlan(
      [piece],
      artistUuid,
      existingRows,
      existingObjectUuids,
    );

    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpload).toEqual([]);
    expect(plan.toReplace).toHaveLength(1);
    expect(plan.toReplace[0].piece.piece_uuid).toBe(piece.piece_uuid);
    expect(plan.toReplace[0].staleFields).toEqual(["description"]);
  });

  it("flags drifted tags separately from a drifted description", () => {
    const [piece] = corpusPieces(1);
    const stale = { ...rowFor(piece), tags: ["monochrome"] };
    const plan = buildPushPlan(
      [piece],
      artistUuid,
      new Map([[piece.piece_uuid, stale]]),
      new Set([piece.piece_uuid]),
    );

    expect(plan.toReplace[0].staleFields).toEqual(["tags"]);
  });

  it("treats PostgREST's +00:00 rendering as the same instant as toISOString's Z", () => {
    // PostgREST renders a timestamptz as "…T01:00:00+00:00"; `createdAtOf`
    // produces "…T01:00:00.000Z" for the same instant. Comparing the raw
    // strings would flag every untouched row as stale.
    const [piece] = corpusPieces(1);
    const row = rowFor(piece);
    const rendered = { ...row, created_at: "2026-01-01T01:00:00+00:00" };
    expect(row.created_at).toBe("2026-01-01T01:00:00.000Z");

    const plan = buildPushPlan(
      [piece],
      artistUuid,
      new Map([[piece.piece_uuid, rendered]]),
      new Set([piece.piece_uuid]),
    );

    expect(plan.toReplace).toEqual([]);
  });

  it("still flags a created_at that is a genuinely different instant", () => {
    const [piece] = corpusPieces(1);
    const stale = { ...rowFor(piece), created_at: "2026-01-02T01:00:00+00:00" };
    const plan = buildPushPlan(
      [piece],
      artistUuid,
      new Map([[piece.piece_uuid, stale]]),
      new Set([piece.piece_uuid]),
    );

    expect(plan.toReplace[0].staleFields).toEqual(["created_at"]);
  });
});

describe("artworkInsertRow", () => {
  it("agrees with artworkRow's SQL on id, title, description, tags and image_path", () => {
    const [piece] = corpusPieces(1);
    const insertRow = artworkInsertRow(piece, ARTIST_UUID);
    const sql = artworkRow(piece);

    expect(sql).toContain(sqlString(insertRow.id));
    expect(sql).toContain(sqlString(ARTIST_UUID));
    expect(sql).toContain(sqlString(insertRow.title));
    expect(insertRow.description).not.toBeNull();
    expect(sql).toContain(sqlString(insertRow.description as string));
    expect(sql).toContain(sqlTagArray(insertRow.tags));
    expect(sql).toContain(sqlString(insertRow.image_path));

    // The row and the SQL generator must agree on the instant too, not just
    // its two different spellings — see `createdAtOf`'s own coverage of that.
    const hour = Number(sql.match(/interval '(\d+) hour'/)?.[1]);
    expect(hour).toBe(piece.slot + 1);
  });

  it("agrees for an untagged-tail piece — empty tags and a null description in both", () => {
    const [piece] = corpusPieces(1);
    const untagged: CorpusPiece = { ...piece, untagged: true };
    const insertRow = artworkInsertRow(untagged, ARTIST_UUID);
    const sql = artworkRow(untagged);

    expect(insertRow.tags).toEqual([]);
    expect(insertRow.description).toBeNull();
    expect(sql).toContain(", null, '{}', ");
  });

  it("derives image_path against the given artist uid, not the local default", () => {
    const [piece] = corpusPieces(1);
    const target = "11111111-2222-4333-8444-555555555555";
    const insertRow = artworkInsertRow(piece, target);
    expect(insertRow.image_path).toBe(`${target}/${piece.piece_uuid}.jpg`);
    expect(insertRow.artist_id).toBe(target);
  });
});
