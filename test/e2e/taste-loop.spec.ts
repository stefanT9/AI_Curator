/**
 * Risk #7 (`context/foundation/test-plan.md` §2): a collector completes
 * onboarding and likes pieces, but the deck that follows is not ordered toward
 * what they liked — the product's central promise silently fails.
 *
 * The only lane that can answer this. Taste is computed in SQL
 * (`swipe_deck`, `supabase/migrations/20260910180000_rank_swipe_deck.sql`), but
 * between that ordering and the collector's eye sit a signup, the proxy's
 * session refresh, the `(app)` layout's onboarding gate, RLS on `interactions`
 * and `artworks`, a Server Action per verdict, and the card component that
 * decides what of an artwork reaches the page at all. `swipe-deck.int.ts`
 * proves the RPC orders correctly; nothing but a browser proves the collector
 * sees that order.
 *
 * Nothing is mocked. Real auth, real RLS, real Storage, real `swipe_deck`,
 * against the seeded 1000-row corpus.
 */

import { expect, test, type Page } from "@playwright/test";
import { ONBOARDING_LIKE_TARGET } from "@/lib/onboarding/config";
import { POPULATED_STYLE_TERMS, uniqueEmail, uniquePassword } from "./helpers";

/**
 * How far down `/discover` the spec walks.
 *
 * Every step costs a Server Action round trip and a re-render of a
 * `force-dynamic` page over the whole corpus, so this is a sample of the head
 * of the deck, not a traversal of it. Six is where the seeded corpus gives the
 * ranking room to actually discriminate: measured against a collector who
 * likes the five newest `figurative`/`realism` pieces, the first six cards
 * score 8, 7, 6, 6, 6, 6 overlapping tags — a strict drop across the window,
 * and far enough from the unranked baseline (0, 2, 2, 1, 1, 0) that neither
 * assertion below can pass by accident.
 */
const SAMPLE_SIZE = 6;

/**
 * Signup, onboarding and six ranked cards are each a round trip against a real
 * Postgres; the default 30s is not enough and a failure against it would read
 * as a hung app rather than a slow one. This is the budget for the whole
 * journey, not for any one step — every wait below is still a condition, never
 * a duration.
 */
const JOURNEY_TIMEOUT_MS = 180_000;

/**
 * The tags rendered on the card currently on top of a deck.
 *
 * `ArtCard` renders `TagList` — a `ul` of `li` — whenever the artwork has tags,
 * which is what makes the ranking's input observable from the page instead of
 * only from the database. An untagged card renders no list at all and yields
 * `[]`, which is a real answer here: a zero-overlap card at the head of the
 * deck is the failure this spec is looking for.
 */
const visibleCardTags = (page: Page): Promise<string[]> =>
  page.getByRole("article").getByRole("listitem").allTextContents();

/** How many of `tags` the collector's demonstrated taste already contains. */
const overlapWith = (taste: ReadonlySet<string>, tags: string[]): number =>
  tags.filter((tag) => taste.has(tag)).length;

test.describe("Risk #7 — the deck follows demonstrated taste", () => {
  test("a collector who likes five pieces gets a deck ordered by tag overlap with them", async ({
    page,
  }) => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);

    const email = uniqueEmail();
    const password = uniquePassword();

    // --- Sign up a fresh collector ------------------------------------------
    //
    // A new account every run, because the thing under test is what the ranking
    // does with *this* collector's likes. `supabase/config.toml` disables email
    // confirmation locally, so `signup` gets a session back and redirects to
    // `/app`; the role router there sends a collector to `/discover`, and the
    // `(app)` layout's `requireOnboarded` gate bounces them into the flow. The
    // spec asserts the destination rather than the hops.
    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await page.waitForURL("**/onboarding");

    // --- Pick the style terms ------------------------------------------------
    //
    // The chips are toggle buttons carrying `aria-pressed`, so selection is
    // assertable as state — and asserting it is what guarantees the submit
    // below is not clicked while the form still holds fewer than
    // `ONBOARDING_TERM_MIN` hidden inputs.
    for (const term of POPULATED_STYLE_TERMS) {
      const chip = page.getByRole("button", { name: term, exact: true });
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    }

    await page.getByRole("button", { name: "Show me some art" }).click();

    // The picker is a GET form back to `/onboarding`, so both steps live on one
    // route and only the query string changes. Waiting for a route change here
    // would hang; the heading is the state that actually differs.
    await expect(
      page.getByRole("heading", { name: "Like a few to get started" }),
    ).toBeVisible();

    // --- Like the starter pool ----------------------------------------------
    //
    // The taste set is read from the page, not from the database: these are the
    // same tags the collector could see when they decided, which keeps the
    // assertion at the end a statement about what was shown rather than about
    // what was stored.
    const taste = new Set<string>();

    for (let liked = 0; liked < ONBOARDING_LIKE_TARGET; liked += 1) {
      // `StarterDeck`'s own progress line, and the gate that makes each read
      // below belong to the like that follows it. It reads "Saving…" while a
      // verdict is in flight, so its settled text is the deck's statement that
      // the previous card is durable and the next one is on screen.
      await expect(
        page.getByText(`${liked} of ${ONBOARDING_LIKE_TARGET} liked`),
      ).toBeVisible();

      for (const tag of await visibleCardTags(page)) taste.add(tag);

      await page.getByRole("button", { name: "Like" }).click();
    }

    // The fifth like ends the flow: `OnboardingHandoff` stamps `onboarded_at`
    // and redirects. Reaching `/discover` is therefore also the proof that all
    // five verdicts were written — a rolled-back like would leave the counter
    // short and the loop above would have failed waiting for it.
    await page.waitForURL("**/discover");
    await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();

    expect(
      taste.size,
      "the five liked pieces rendered no tags, so there is no taste to rank against",
    ).toBeGreaterThan(0);

    // --- Walk the head of the ranked deck ------------------------------------
    //
    // `SwipeDeck` shows one card at a time, so the ordering is observed by
    // skipping down it. Skips are never taste input (`swipe_deck` reads only
    // likes) and a skipped piece is demoted below everything unseen, so each
    // step reveals the next-best match rather than perturbing the ranking.
    const overlaps: number[] = [];

    for (let seen = 0; seen < SAMPLE_SIZE; seen += 1) {
      const details = page.getByRole("link", { name: "View details" });
      await expect(details).toBeVisible();

      // The card's identity, used below to wait for the deck to advance. The
      // href carries the artwork id; titles are not unique in the corpus.
      const href = await details.getAttribute("href");

      overlaps.push(overlapWith(taste, await visibleCardTags(page)));

      if (seen === SAMPLE_SIZE - 1) break;

      await page.getByRole("button", { name: "Skip" }).click();
      await expect(details).not.toHaveAttribute("href", href ?? "");
    }

    // --- The ranking, as the collector sees it -------------------------------
    //
    // Two properties, both consequences of `order by overlap desc` and neither
    // satisfiable by an arbitrary non-empty deck.

    // Directed: every card at the head shares vocabulary with what was liked.
    // Unranked, the same corpus puts zero-overlap pieces at positions 1 and 6.
    expect(
      overlaps,
      "a card at the head of the deck shares no tag with anything the collector liked",
    ).not.toContain(0);

    // Ordered: the strongest matches come first, and the window is not flat —
    // a constant sequence would satisfy the sort without demonstrating that the
    // ranking discriminates at all.
    expect(
      overlaps,
      "the head of the deck is not sorted by tag overlap",
    ).toEqual([...overlaps].sort((a, b) => b - a));
    expect(
      overlaps[0],
      "the best match in the window is no better than the worst — the ordering is not discriminating",
    ).toBeGreaterThan(overlaps[overlaps.length - 1]);
  });
});
