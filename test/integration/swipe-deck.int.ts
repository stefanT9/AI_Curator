/**
 * S-01: the deck is ordered per collector by tag overlap against their own likes.
 *
 * Only this lane can assert any of it. `npm run test` mocks Supabase, so a unit
 * test would assert the mock rather than the `order by` — and the four-key sort
 * in `20260910180000_rank_swipe_deck.sql` has a failure mode that looks
 * plausible while being backwards (see the skip-tier test below). CI runs the
 * default gate only, so a green badge on this change says nothing about the
 * ranking; running `npm run test:integration` locally is the proof.
 *
 * The fixture catalogue is built so **recency alone would produce the exact
 * reverse** of the expected warm ordering. A sort that quietly fell back to
 * `created_at desc` cannot pass by coincidence.
 *
 * Two properties make the assertions robust against whatever else is in the
 * local database (the 54-row `seed.sql` corpus, leftovers from a previous run,
 * another spec file inserting concurrently — Vitest runs files in parallel):
 *
 * 1. Fixture tags carry a per-run unique prefix, so nothing outside this file
 *    can contribute to a fixture's overlap score.
 * 2. Assertions filter the returned deck down to fixture rows and check their
 *    *relative* order. `swipe_deck` clamps at 50 rows, which a seeded database
 *    already exceeds, so absolute positions are not assertable.
 *
 * The warm collector additionally likes every non-fixture artwork, which the
 * narrowed exclusion predicate removes from its deck entirely. That is what
 * makes the demoted tail (the skipped piece, the untagged piece) reachable
 * within the 50-row clamp rather than sitting behind 48 seeded rows.
 *
 * Run with `npm run test:integration` against a running local stack.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireLocalRunningStack } from "./setup";
import {
  createTestArtist,
  createTestCollector,
  TINY_PNG,
  type TestArtist,
  type TestCollector,
} from "./helpers";

/** Per-run tag namespace: nothing else in the database can score against it. */
const RUN = crypto.randomUUID().slice(0, 8);
const tag = (name: string) => `s01-${RUN}-${name}`;

const A = tag("alpha");
const B = tag("beta");
const C = tag("gamma");
const D = tag("delta");
const E = tag("epsilon");

type FixtureKey = "liked" | "strong" | "weak" | "zero" | "skipped" | "untagged";

/**
 * `offsetMinutes` ascends in the same order the *warm* expectation descends, so
 * a deck ordered by recency alone comes out exactly reversed. `seed.sql` dates
 * its corpus to January 2026, so every fixture here is newer than the whole
 * seeded catalogue — which is what puts the tagged fixtures at the head of a
 * cold collector's deck.
 */
const FIXTURES: { key: FixtureKey; tags: string[]; offsetMinutes: number }[] = [
  // Establishes taste: {A, B, C}. Liked, so it must never come back (FR-006).
  { key: "liked", tags: [A, B, C], offsetMinutes: 1 },
  // Overlap 2 — the strongest unseen match, and the *oldest* fixture but one.
  { key: "strong", tags: [A, B], offsetMinutes: 2 },
  // Overlap 1.
  { key: "weak", tags: [A, D], offsetMinutes: 3 },
  // Overlap 0 but still tagged and unseen: the plan serves these rather than
  // filtering them out, so it must outrank both demoted tiers.
  { key: "zero", tags: [D, E], offsetMinutes: 4 },
  // Overlap 3 — the highest score in the set. Skipped, so it must still land
  // below `zero`. If the score outranked the skip tier, this would be first.
  { key: "skipped", tags: [A, B, C], offsetMinutes: 5 },
  // Untagged and unseen, and the newest row of all: last on both the outermost
  // key and the recency floor's opposite.
  { key: "untagged", tags: [], offsetMinutes: 6 },
];

const BASE_MS = Date.now() - 60 * 60 * 1000;

const createdAtFor = (offsetMinutes: number) =>
  new Date(BASE_MS + offsetMinutes * 60_000).toISOString();

let artist: TestArtist;
let warm: TestCollector;
let cold: TestCollector;

/** Fixture artwork id by key, and the reverse map for readable assertions. */
const ids = new Map<FixtureKey, string>();
const keyById = new Map<string, FixtureKey>();

const id = (key: FixtureKey) => {
  const value = ids.get(key);
  if (!value) throw new Error(`Fixture ${key} was not created`);
  return value;
};

/** The fixture rows of a deck, in deck order, named by fixture key. */
const fixtureOrder = (deck: { id: string }[]): FixtureKey[] =>
  deck.map((row) => keyById.get(row.id)).filter((k): k is FixtureKey => !!k);

const fetchDeck = async (collector: TestCollector) => {
  const { data, error } = await collector.client.rpc("swipe_deck", {
    p_limit: 50,
  });

  if (error) {
    throw new Error(`swipe_deck failed: ${error.message}`);
  }

  return data ?? [];
};

let warmDeck: FixtureKey[];
let coldDeckIds: string[];

beforeAll(async () => {
  const stack = await requireLocalRunningStack();

  artist = await createTestArtist(stack);
  warm = await createTestCollector(stack);
  cold = await createTestCollector(stack);

  // One object, reused by every fixture row — the same shortcut `seed.sql`
  // takes. `image_path` has no unique constraint, and this spec asserts
  // ordering, not rendering.
  const imagePath = await artist.upload(TINY_PNG);

  const { data: rows, error } = await artist.client
    .from("artworks")
    .insert(
      FIXTURES.map(({ key, tags, offsetMinutes }) => ({
        artist_id: artist.userId,
        title: `S-01 ${key}`,
        description: `Deck ordering fixture: ${key}`,
        tags,
        image_path: imagePath,
        created_at: createdAtFor(offsetMinutes),
      })),
    )
    .select("id, title, created_at");

  if (error || !rows) {
    throw new Error(`Could not insert deck fixtures: ${error?.message}`);
  }

  for (const row of rows) {
    const key = row.title.replace("S-01 ", "") as FixtureKey;
    ids.set(key, row.id);
    keyById.set(row.id, key);
  }

  // The assumption the ordering assertions rest on: a client-side insert keeps
  // the supplied `created_at` rather than overwriting it with the `now()`
  // default. There is no BEFORE INSERT trigger on `artworks` (only
  // `artworks_set_updated_at`, which is BEFORE UPDATE), so it should hold —
  // verified here so a schema change that breaks it fails loudly in setup
  // instead of silently invalidating every ordering expectation below.
  for (const row of rows) {
    const key = row.title.replace("S-01 ", "") as FixtureKey;
    const expected = FIXTURES.find((f) => f.key === key)?.offsetMinutes;
    expect(new Date(row.created_at).toISOString()).toBe(
      createdAtFor(expected as number),
    );
  }

  // Everything the *warm* collector will not judge itself is marked liked, so
  // the narrowed exclusion predicate drops it from that collector's deck. Its
  // tags do enter the taste aggregate, which is harmless: fixture tags are
  // namespaced per run, so no outside tag can score against a fixture.
  const { data: catalogue, error: catalogueError } = await warm.client
    .from("artworks")
    .select("id");

  if (catalogueError || !catalogue) {
    throw new Error(`Could not read the catalogue: ${catalogueError?.message}`);
  }

  const fixtureIds = new Set(ids.values());
  const neutralised = catalogue
    .map((row) => row.id)
    .filter((rowId) => !fixtureIds.has(rowId));

  const { error: interactionsError } = await warm.client
    .from("interactions")
    .insert([
      ...neutralised.map((artworkId) => ({
        user_id: warm.userId,
        artwork_id: artworkId,
        action: "like" as const,
      })),
      {
        user_id: warm.userId,
        artwork_id: id("liked"),
        action: "like" as const,
      },
      {
        user_id: warm.userId,
        artwork_id: id("skipped"),
        action: "skip" as const,
      },
    ]);

  if (interactionsError) {
    throw new Error(
      `Could not record the warm collector's swipes: ${interactionsError.message}`,
    );
  }

  warmDeck = fixtureOrder(await fetchDeck(warm));
  coldDeckIds = (await fetchDeck(cold)).map((row) => row.id);
});

afterAll(async () => {
  // Interactions first: `artworks.id` cascades, but the collectors' rows over
  // the seeded corpus have no such parent to take them out.
  await warm?.cleanup();
  await cold?.cleanup();
  await artist?.cleanup();
});

describe("swipe_deck ordering for a collector with likes", () => {
  it("never serves back an artwork the collector liked (FR-006)", () => {
    expect(warmDeck).not.toContain("liked");
  });

  it("ranks unseen tagged pieces by tag overlap, descending", () => {
    // strong (2 shared tags) before weak (1) before zero (0). Recency says the
    // opposite, so a fallback to `created_at desc` fails here.
    expect(
      warmDeck.filter((k) => k === "strong" || k === "weak" || k === "zero"),
    ).toEqual(["strong", "weak", "zero"]);
  });

  it("demotes a skipped piece below every unseen tagged piece", () => {
    // `skipped` carries the highest overlap in the set (3). If the skip tier
    // were dropped, or expressed as a bare `(i.action = 'skip')::int` — null
    // for unseen rows, which sorts LAST under ASC and inverts the tier — this
    // piece would lead the deck instead of trailing the unseen ones.
    const skippedAt = warmDeck.indexOf("skipped");
    expect(skippedAt).toBeGreaterThan(-1);

    for (const unseen of ["strong", "weak", "zero"] as const) {
      expect(
        warmDeck.indexOf(unseen),
        `${unseen} (unseen, tagged) must outrank the skipped piece`,
      ).toBeLessThan(skippedAt);
    }
  });

  it("sinks an untagged piece below even the skipped piece", () => {
    expect(warmDeck.indexOf("untagged")).toBeGreaterThan(
      warmDeck.indexOf("skipped"),
    );
  });

  it("resolves all four ordering keys in one deck", () => {
    expect(warmDeck).toEqual([
      "strong", // overlap 2, unseen, tagged
      "weak", // overlap 1
      "zero", // overlap 0 — still ahead of both demoted tiers
      "skipped", // overlap 3, but demoted by the skip tier
      "untagged", // demoted by the outermost key
    ]);
  });
});

describe("swipe_deck ordering for a collector with no likes", () => {
  it("falls back to newest-first among tagged pieces", () => {
    // Taste is an empty array, so every piece scores 0 and the recency floor
    // decides. These fixtures are the newest tagged rows in the catalogue, so
    // they lead the deck; the expected order here is the reverse of the warm
    // collector's, which is the personalization itself.
    const coldOrder = fixtureOrder(coldDeckIds.map((rowId) => ({ id: rowId })));

    expect(coldOrder.filter((k) => k !== "untagged")).toEqual([
      "skipped",
      "zero",
      "weak",
      "strong",
      "liked",
    ]);
  });

  it("never places the untagged piece ahead of a tagged one", () => {
    // Absent rather than last: the untagged tier sits behind ~48 seeded tagged
    // rows, past the function's 50-row clamp. Treating absence as "infinitely
    // far back" is the honest assertion — untagged-last is proved outright in
    // the warm collector's deck, where the clamp is not in the way.
    const coldOrder = fixtureOrder(coldDeckIds.map((rowId) => ({ id: rowId })));
    const untaggedAt = coldOrder.indexOf("untagged");
    const position = untaggedAt === -1 ? Number.POSITIVE_INFINITY : untaggedAt;

    for (const tagged of [
      "skipped",
      "zero",
      "weak",
      "strong",
      "liked",
    ] as const) {
      expect(
        coldOrder.indexOf(tagged),
        `${tagged} (tagged) must outrank the untagged piece`,
      ).toBeLessThan(position);
    }
  });
});
