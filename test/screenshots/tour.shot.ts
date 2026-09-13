/**
 * The README's screenshot tour.
 *
 * **Not a test.** Nothing here asserts a product property — every `expect` is a
 * wait condition, there to make sure the page is in the state the shot is meant
 * to show before the shutter opens. The product's one browser-level assertion
 * lives in `test/e2e/taste-loop.spec.ts` and is deliberately kept alone there.
 *
 * It drives the real app end to end anyway, because a screenshot of a mocked
 * surface documents something that does not exist: a real signup, real
 * onboarding, a real ranked deck, a real upload through Storage, a real
 * auction, and a real sealed-bid form belonging to a second collector.
 *
 * Run with `npm run docs:screenshots`. Output lands in `docs/screenshots/` and
 * is committed — that is the point of it.
 */

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ONBOARDING_LIKE_TARGET } from "@/lib/onboarding/config";
// Resolvable here only because `npm run docs:screenshots` sets
// `--conditions=react-server`, which maps this module's `import "server-only"`
// onto the empty stub. Importing the real minter rather than restating its HMAC
// keeps one implementation of the token format — see `src/lib/email/unsubscribe.ts`.
import { createUnsubscribeToken } from "@/lib/email/unsubscribe";
import { POPULATED_STYLE_TERMS, uniquePassword } from "../e2e/helpers";

/**
 * Serial, and sharing one module-scoped variable: the artist's tour creates the
 * auction the second collector's tour photographs. Splitting them into separate
 * tests is what gives the bidder a fresh browser context, which is the only way
 * to be a different person.
 */
test.describe.configure({ mode: "serial" });

const SHOT_DIR = "docs/screenshots";

/**
 * The title the artist gives the uploaded piece — and the handle every later
 * step uses to find it again, so the tour never picks up an artwork a previous
 * run left behind.
 */
const PIECE_TITLE = "Low Meadow, After Rain";

/**
 * The corpus image the artist uploads, pinned rather than picked.
 *
 * Constable's *Stoke-by-Nayland* — a landscape, which is what an upload
 * screenshot should show. Taking "the first file in the directory" instead gave
 * a photograph of a bronze medal: a perfectly valid corpus row, and a poor
 * advertisement for a form whose whole point is putting a painting in front of
 * collectors. Any other `piece_uuid` from `supabase/seed-assets/corpus.json`
 * works if this one ever goes missing.
 */
const SEED_IMAGE = path.join(
  "supabase/seed-assets/00000000-0000-4000-8000-000000000001",
  "5f83ee0c-b23b-40a4-a573-1be3e9766b9a.jpg",
);

const seedImage = (): string => {
  if (!existsSync(SEED_IMAGE)) {
    throw new Error(
      `Missing ${SEED_IMAGE}. Run \`npm run db:seed:fetch\` once, then \`npm run db:reset\`.`,
    );
  }

  return SEED_IMAGE;
};

/**
 * Hold the shutter until the page has stopped moving.
 *
 * Every wait is a condition, never a duration — the same rule the browser lane
 * keeps. Images matter more here than anywhere else in the repo: a shot taken
 * while a card is still decoding documents an empty grey rectangle.
 */
const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState("load");
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            }),
        ),
    );
    await document.fonts.ready;
  });
};

/**
 * `fullPage`, always. The viewport is a frame for driving the app, not for
 * cropping the documentation: a swipe card clipped at 800px hides the `TagList`
 * underneath it, which is the one part of the deck that shows *why* the card is
 * there. Heights therefore vary between shots, and that is the right trade.
 */
const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(SHOT_DIR, { recursive: true });
  await settle(page);
  await page.screenshot({
    path: path.join(SHOT_DIR, `${name}.png`),
    fullPage: true,
  });
};

/**
 * A readable address, because this one is photographed.
 *
 * `uniqueEmail` from the browser lane mints `artswipe-e2e-<uuid>@example.test`,
 * and the uuid is deliberate there — a stray account in Supabase Studio names
 * the lane that left it. Here the address is rendered into the app header of
 * every shot, where a uuid reads as scaffolding. This keeps both properties
 * that matter: `.test` is reserved by RFC 2606 and can never resolve, and the
 * suffix keeps repeat runs from colliding.
 */
const shotEmail = (person: string): string =>
  `${person}-shot-${crypto.randomUUID().slice(0, 6)}@example.test`;

/** Signup plus the full onboarding flow, which the `(app)` layout gates on. */
const signUpAndOnboard = async (
  page: Page,
  person: string,
  onPicker?: (page: Page) => Promise<void>,
  onStarterDeck?: (page: Page) => Promise<void>,
): Promise<void> => {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(shotEmail(person));
  await page.getByLabel("Password").fill(uniquePassword());
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");

  for (const term of POPULATED_STYLE_TERMS) {
    const chip = page.getByRole("button", { name: term, exact: true });
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
  }

  await onPicker?.(page);

  await page.getByRole("button", { name: "Show me some art" }).click();
  await expect(
    page.getByRole("heading", { name: "Like a few to get started" }),
  ).toBeVisible();

  await onStarterDeck?.(page);

  for (let liked = 0; liked < ONBOARDING_LIKE_TARGET; liked += 1) {
    await expect(
      page.getByText(`${liked} of ${ONBOARDING_LIKE_TARGET} liked`),
    ).toBeVisible();
    await page.getByRole("button", { name: "Like" }).click();
  }

  await page.waitForURL("**/discover");
};

let auctionPath: string | null = null;

test("the collector loop, and the artist studio behind it", async ({
  page,
}) => {
  await signUpAndOnboard(
    page,
    "mira",
    // 01 — the picker, with two terms already chosen, so the shot shows the
    // selection rule (`ONBOARDING_TERM_MIN` is 2) rather than an inert grid.
    (p) => shot(p, "01-onboarding-picker"),
    // 02 — the starter deck the picked terms produced.
    (p) => shot(p, "02-starter-deck"),
  );

  // 03 — the payoff: a deck ordered by overlap with the five pieces just liked.
  await expect(page.getByRole("heading", { name: "Discover" })).toBeVisible();
  await shot(page, "03-discover-ranked");

  // 04 — what the collector kept.
  await page.goto("/liked");
  await expect(page.getByRole("heading", { name: "Liked" })).toBeVisible();
  await shot(page, "04-liked");

  // 05 — account, including the auction-notification preference (FR-005).
  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Account", exact: true }),
  ).toBeVisible();
  await shot(page, "05-account-notifications");

  // --- the same person becomes an artist ------------------------------------
  await page.getByLabel("Artist name").fill("Mira Hollowell");
  await page.getByRole("button", { name: "Become an artist" }).click();
  await expect(
    page.getByRole("link", { name: "Studio" }).first(),
  ).toBeVisible();

  // Upload a piece. Deliberately **not** photographed.
  //
  // The obvious shot here is the upload form with AI enrichment having filled
  // description and tags from the image — and it is not taken, because on
  // 2026-09-13 enrichment cannot do that. OpenRouter's free vision roster has
  // regressed to 26-70s per call against a 25s budget, and the pinned lead
  // model now rejects the request outright, so the form reliably renders "The
  // suggestion took too long". A screenshot of that documents an outage, not a
  // feature. Measurements and the decision are in
  // `context/changes/ai-enrichment-budget/`.
  //
  // Restore this shot when that change lands; the fields below are exactly what
  // enrichment would otherwise have supplied.
  await page.goto("/studio/new");
  await page.getByLabel("Image").setInputFiles(seedImage());
  await expect(page.getByRole("img", { name: /Preview/ })).toBeVisible();

  await page.getByLabel("Title").fill(PIECE_TITLE);
  await page
    .getByLabel("Description")
    .fill(
      "Oil on board, painted over three wet mornings after the storms came " +
        "through. I was after the moment the light comes back and the ground " +
        "is still holding water.",
    );
  // Tags matter beyond this form: they are what the deck ranks on, so a piece
  // uploaded without them would sink to the untagged tier of every collector's
  // `swipe_deck`.
  await page
    .getByLabel("Tags")
    .fill("landscape, oil painting, botanical, muted, realism");

  await page.getByRole("button", { name: "Upload artwork" }).click();
  await page.waitForURL("**/studio");

  // 06 — the studio, now holding the piece.
  await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();
  await shot(page, "06-studio");

  // 07 — listing it: starting price and one of three preset durations.
  //
  // Scoped to the piece this run just uploaded, never `.first()`. The tour is
  // additive — it leaves an account, an artwork and an auction behind — so on a
  // second run against the same database `.first()` picks up the *previous*
  // run's artwork, and every shot after this one documents the wrong piece.
  // Observed exactly that way.
  const uploaded = page
    .getByRole("listitem")
    .filter({ hasText: PIECE_TITLE })
    .first();
  await expect(uploaded).toBeVisible();
  await uploaded.getByRole("link", { name: "List for auction" }).click();

  await page.getByLabel("Starting price").fill("420");
  await shot(page, "07-auction-listing");

  await page.getByRole("button", { name: "List for auction" }).click();

  // `createAuction` redirects to `/auctions` on success, so that destination —
  // and nothing looser — is what proves the write landed.
  //
  // An earlier version waited on `/\/(auctions|studio)/`, which also matches
  // the form's own URL (`/studio/<id>/auction`). It therefore resolved
  // instantly, and the `page.goto` that followed cancelled the Server Action
  // mid-flight: no auction row, and an empty browse page two shots later. It
  // passed the first time and failed the second, which is how a race announces
  // itself.
  await page.waitForURL("**/auctions");

  // 08 — the browse surface every signed-in user sees.
  await expect(page.getByRole("heading", { name: "Auctions" })).toBeVisible();
  await shot(page, "08-auctions-browse");

  // Same reasoning as above: this run's auction, found by its own title.
  const listed = page
    .getByRole("listitem")
    .filter({ hasText: PIECE_TITLE })
    .first();
  const link = listed.locator('a[href^="/auctions/"]').first();
  await expect(link).toBeVisible();
  auctionPath = await link.getAttribute("href");
});

test("a second collector, and the sealed-bid form", async ({ page }) => {
  expect(
    auctionPath,
    "the artist tour did not produce an auction",
  ).toBeTruthy();

  // A different person, because an artist cannot bid on their own auction —
  // which is exactly why this needs its own browser context.
  await signUpAndOnboard(page, "collector");

  // 09 — the detail page. The bid form is visible; no other bidder's amount is,
  // and that absence is the product guarantee ("sealed means sealed").
  await page.goto(auctionPath!);
  await expect(page.getByLabel(/Your bid|Raise your bid/)).toBeVisible();
  await shot(page, "09-auction-sealed-bid");
});

test("the unsubscribe link, opened from an inbox with no session", async ({
  page,
}) => {
  // Signed over the throwaway secret the config generated and handed to the
  // server. `verifyUnsubscribeToken` performs no database lookup, so a token
  // over any well-formed uuid renders the real page — and a documentation
  // script never touches the developer's own signing secret, which could mint a
  // valid token for any user forever.
  const secret = process.env.SHOT_UNSUBSCRIBE_TOKEN_SECRET;
  expect(secret, "the config did not generate a signing secret").toBeTruthy();
  process.env.UNSUBSCRIBE_TOKEN_SECRET = secret;

  const token = createUnsubscribeToken(crypto.randomUUID());
  expect(token, "could not mint an unsubscribe token").toBeTruthy();

  // No signup, no login, no cookie — the whole point of the route.
  await page.goto(`/unsubscribe?token=${token}`);
  await expect(
    page.getByRole("heading", { name: "Auction emails" }),
  ).toBeVisible();
  await shot(page, "10-unsubscribe");
});
