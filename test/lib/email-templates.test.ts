import { describe, expect, it } from "vitest";
import {
  auctionLostPayloadSchema,
  auctionOpenedPayloadSchema,
  auctionUnsoldPayloadSchema,
  auctionWonPayloadSchema,
  composeOutboxEmail,
  type OutboxLinks,
} from "@/lib/email/templates";

/**
 * What each of the five people a message can reach is told, and — for the three
 * who are told least — what they are provably not told.
 *
 * The negative assertions are the point of this file. §Access Control permits
 * exactly one new disclosure, the winner and the seller learning each other's
 * address, and a losing bidder is not part of it. That boundary is held twice:
 * once in the database, where the enqueue trigger never stores an amount or a
 * counterparty on an `auction_lost` row (`test/integration/email-outbox.int.ts`
 * asserts that against real Postgres), and once here, where the schema has no
 * field to put one in. This file owns the second half — the half that would
 * still hold if someone widened the payload.
 *
 * S-05's `auction_opened` is the strictest case of all, because it reaches
 * someone who has not bid and may never bid. It is also the only kind that
 * carries links, which is why `composeOutboxEmail` takes them as an argument:
 * every assertion below holds without a signing secret or a site URL in scope.
 */

const TITLE = "Harbour at Dusk";
const AMOUNT_CENTS = 42_000;
const COUNTERPARTY = "other.party@example.test";

const won = {
  artwork_title: TITLE,
  amount_cents: AMOUNT_CENTS,
  counterparty_email: COUNTERPARTY,
};

/**
 * Stand-ins for `src/lib/email/links.ts`. Deliberately recognisable strings
 * rather than realistic ones: a body is asserted to contain *these*, so a
 * template that built a URL of its own instead of using what it was handed
 * would fail rather than pass on a plausible-looking substitute.
 */
const LINKS: OutboxLinks = {
  auction: (auctionId) => `https://artswipe.test/auctions/${auctionId}`,
  unsubscribe: (userId) =>
    `https://artswipe.test/unsubscribe?token=signed-for-${userId}`,
};

/** An environment with neither SITE_URL nor a signing secret. */
const NO_LINKS: OutboxLinks = { auction: () => null, unsubscribe: () => null };

const composeOutbox = (kind: string, payload: unknown, links = LINKS) =>
  composeOutboxEmail(kind, payload, links);

const compose = (kind: string, payload: unknown) => {
  const message = composeOutbox(kind, payload);
  if (!message) throw new Error(`${kind} failed to compose`);
  return message;
};

/** Subject and body together — a leak in either is a leak. */
const whole = (message: { subject: string; text: string }) =>
  `${message.subject}\n${message.text}`;

describe("auction_won", () => {
  it("names the amount and the seller's address", () => {
    const message = compose("auction_won", won);

    expect(message.subject).toContain(TITLE);
    expect(message.text).toContain("$420.00");
    expect(message.text).toContain(COUNTERPARTY);
  });

  it("names no other bidder and no bid count", () => {
    const message = compose("auction_won", won);

    // The seller's address is the only one permitted; there is nothing here
    // that could carry another, and no number but the winning amount.
    expect(whole(message).match(/@/g)).toHaveLength(1);
    expect(whole(message)).not.toMatch(/\b\d+ (other )?bid/i);
  });
});

describe("auction_sold", () => {
  it("names what it sold for and the buyer's address", () => {
    const message = compose("auction_sold", won);

    expect(message.subject).toContain(TITLE);
    expect(message.subject).toContain("$420.00");
    expect(message.text).toContain(COUNTERPARTY);
  });

  it("names no losing amount and no bid count", () => {
    const message = compose("auction_sold", won);

    // The seller cannot read `bids` in the app either. This message must not
    // become the way around that.
    expect(whole(message).match(/\$[\d,]+\.\d{2}/g)).toEqual([
      "$420.00",
      "$420.00",
    ]);
    expect(whole(message).match(/@/g)).toHaveLength(1);
  });
});

describe("auction_lost", () => {
  const lost = { artwork_title: TITLE };

  it("names the piece and the outcome, and stops there", () => {
    const message = compose("auction_lost", lost);

    expect(message.subject).toContain(TITLE);
    expect(message.text).toContain("was not the winning one");
  });

  // The §Access Control assertion. A losing bidder learns only that they lost.
  it("contains no address at all", () => {
    expect(whole(compose("auction_lost", lost))).not.toContain("@");
  });

  it("contains no currency figure at all", () => {
    const message = whole(compose("auction_lost", lost));

    expect(message).not.toContain("$");
    expect(message).not.toContain(String(AMOUNT_CENTS));
    expect(message).not.toContain("420");
  });

  it("names neither the winner nor the seller", () => {
    const message = whole(compose("auction_lost", lost));

    expect(message).not.toContain(COUNTERPARTY);
    expect(message).not.toMatch(/\bwinner\b/i);
    expect(message).not.toMatch(/\bseller\b/i);
  });

  it("refuses to compose a payload that smuggled a counterparty in", () => {
    // The schema is strict, so this rejects rather than silently stripping.
    // The row is then marked failed with a reason — loudly wrong beats quietly
    // right, because a payload that carries this is a bug in the trigger.
    expect(
      composeOutbox("auction_lost", {
        artwork_title: TITLE,
        counterparty_email: COUNTERPARTY,
      }),
    ).toBeNull();

    expect(
      composeOutbox("auction_lost", {
        artwork_title: TITLE,
        amount_cents: AMOUNT_CENTS,
      }),
    ).toBeNull();
  });
});

describe("auction_unsold", () => {
  const unsold = { artwork_title: TITLE };

  it("is a closing notice with the piece free to relist", () => {
    const message = compose("auction_unsold", unsold);

    expect(message.subject).toContain(TITLE);
    expect(message.text).toContain("list it again");
  });

  /**
   * FR-010's Socrates note: "'nobody bid on your work' is a discouraging
   * message", resolved as "a closing notice with the artwork free to relist,
   * not a failure report". This test is what stops the copy drifting back.
   */
  it("never reports that nobody bid", () => {
    const message = whole(compose("auction_unsold", unsold)).toLowerCase();

    expect(message).not.toContain("nobody");
    expect(message).not.toContain("no one");
    expect(message).not.toContain("no bids");
    expect(message).not.toContain("did not sell");
    expect(message).not.toContain("failed");
  });

  it("carries no amount and no address", () => {
    const message = whole(compose("auction_unsold", unsold));

    expect(message).not.toContain("$");
    expect(message).not.toContain("@");
  });
});

describe("auction_opened", () => {
  const AUCTION_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const RECIPIENT_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const STARTING_PRICE_CENTS = 12_500;

  const opened = {
    artwork_title: TITLE,
    starting_price_cents: STARTING_PRICE_CENTS,
    ends_at: "2026-09-15T14:00:00+00:00",
    auction_id: AUCTION_ID,
    recipient_id: RECIPIENT_ID,
  };

  it("names the piece, the starting price and when it closes", () => {
    const message = compose("auction_opened", opened);

    expect(message.subject).toContain(TITLE);
    expect(message.text).toContain(TITLE);
    expect(message.text).toContain("$125.00");
    // UTC, labelled: the server's zone is an accident of where it is deployed,
    // and an unlabelled local time is wrong for almost every recipient in a way
    // that looks right.
    expect(message.text).toContain("closes on Sep 15, 2026 at 2:00 PM UTC");
  });

  it("links to the auction and to the off switch", () => {
    const message = compose("auction_opened", opened);

    expect(message.text).toContain(
      `https://artswipe.test/auctions/${AUCTION_ID}`,
    );
    expect(message.text).toContain(
      `https://artswipe.test/unsubscribe?token=signed-for-${RECIPIENT_ID}`,
    );
  });

  /**
   * FR-003 was revised to depend on FR-005 because "a like was never consent to
   * be emailed". The least this message can do is name the action that produced
   * it, so the recipient can tell it from a broadcast.
   */
  it("says why the recipient is getting it", () => {
    expect(compose("auction_opened", opened).text).toContain(
      "because you liked this piece",
    );
  });

  // The §Guardrails assertion, in its hardest case: this reaches a collector
  // who has not bid and may never bid.
  it("says nothing about bidding at all", () => {
    const message = whole(compose("auction_opened", opened));

    expect(message).not.toMatch(/\bbid/i);
    expect(message).not.toMatch(/\bbidder/i);
    expect(message).not.toMatch(/\bwinner\b/i);
    expect(message).not.toMatch(/\bhighest\b/i);
    expect(message).not.toMatch(/\b\d+ (other )?bid/i);
  });

  it("carries the seller's asking price and no other figure", () => {
    const message = whole(compose("auction_opened", opened));

    expect(message.match(/\$[\d,]+\.\d{2}/g)).toEqual(["$125.00"]);
  });

  it("contains no address at all", () => {
    // Not the recipient's own, not the seller's, not anybody's. The payload has
    // nowhere to put one and the body has no reason to.
    expect(whole(compose("auction_opened", opened))).not.toContain("@");
  });

  /**
   * A mail advertising an off switch that does not work is worse than a mail
   * not sent — the recipient reads a promise the product then breaks. An
   * environment with no SITE_URL or no signing secret therefore composes
   * nothing, and the drain retires the row as `unrenderable`.
   */
  it("refuses to compose when a link cannot be built", () => {
    expect(composeOutbox("auction_opened", opened, NO_LINKS)).toBeNull();

    expect(
      composeOutbox("auction_opened", opened, {
        ...LINKS,
        unsubscribe: () => null,
      }),
    ).toBeNull();

    expect(
      composeOutbox("auction_opened", opened, {
        ...LINKS,
        auction: () => null,
      }),
    ).toBeNull();
  });

  it("refuses a payload that smuggled anything about bidding in", () => {
    // Strict, like `auction_lost`: a field that was never meant to be here is
    // a bug in the trigger, and a body that quietly dropped it would hide the
    // bug rather than surface it.
    expect(
      composeOutbox("auction_opened", {
        ...opened,
        amount_cents: AMOUNT_CENTS,
      }),
    ).toBeNull();

    expect(
      composeOutbox("auction_opened", {
        ...opened,
        counterparty_email: COUNTERPARTY,
      }),
    ).toBeNull();

    expect(
      composeOutbox("auction_opened", { ...opened, bid_count: 3 }),
    ).toBeNull();
  });

  it.each([
    ["a missing auction id", { ...opened, auction_id: undefined }],
    ["an auction id that is not a uuid", { ...opened, auction_id: "17" }],
    ["a missing recipient id", { ...opened, recipient_id: undefined }],
    ["a recipient id that is not a uuid", { ...opened, recipient_id: "me" }],
    ["a missing closing time", { ...opened, ends_at: undefined }],
    ["a closing time that is not a timestamp", { ...opened, ends_at: "soon" }],
    [
      "a closing time with no timezone",
      { ...opened, ends_at: "2026-09-15T14:00:00" },
    ],
    [
      "a closing time that is only a date",
      { ...opened, ends_at: "2026-09-15" },
    ],
    [
      "a missing starting price",
      { ...opened, starting_price_cents: undefined },
    ],
    ["a zero starting price", { ...opened, starting_price_cents: 0 }],
    ["a fractional starting price", { ...opened, starting_price_cents: 125.5 }],
    ["an empty title", { ...opened, artwork_title: "   " }],
  ])("refuses %s", (_case, payload) => {
    expect(composeOutbox("auction_opened", payload)).toBeNull();
  });
});

describe("the dispatcher", () => {
  it("returns null for a kind this build does not know", () => {
    // A newer migration against an older deploy. Null rather than a throw: the
    // drain marks that one row failed and the rest of the batch still goes out.
    expect(composeOutbox("auction_relisted", { artwork_title: TITLE })).toBe(
      null,
    );
    expect(composeOutbox("", {})).toBeNull();
  });

  it.each([
    [
      "a missing title",
      { amount_cents: AMOUNT_CENTS, counterparty_email: COUNTERPARTY },
    ],
    ["an empty title", { ...won, artwork_title: "   " }],
    [
      "a missing counterparty",
      { artwork_title: TITLE, amount_cents: AMOUNT_CENTS },
    ],
    [
      "a counterparty that is not an address",
      { ...won, counterparty_email: "nope" },
    ],
    [
      "a missing amount",
      { artwork_title: TITLE, counterparty_email: COUNTERPARTY },
    ],
    ["an amount that is not a number", { ...won, amount_cents: "42000" }],
    ["a fractional amount", { ...won, amount_cents: 420.5 }],
    ["a null payload", null],
    ["a string payload", "artwork_title"],
  ])("refuses %s", (_case, payload) => {
    expect(composeOutbox("auction_won", payload)).toBeNull();
  });

  it("ignores an unknown key on a contact-exchange payload", () => {
    // These two are deliberately non-strict: their contract is what they carry,
    // and a field added by a later migration must not make an in-flight "you
    // won" notice unsendable mid-deploy.
    const message = composeOutbox("auction_won", {
      ...won,
      closed_at: "2026-09-13T12:00:00Z",
    });

    expect(message?.text).toContain(COUNTERPARTY);
  });
});

describe("the payload schemas", () => {
  it("accepts what the trigger actually writes", () => {
    expect(auctionWonPayloadSchema.safeParse(won).success).toBe(true);
    expect(
      auctionLostPayloadSchema.safeParse({ artwork_title: TITLE }).success,
    ).toBe(true);
    expect(
      auctionUnsoldPayloadSchema.safeParse({ artwork_title: TITLE }).success,
    ).toBe(true);
    expect(
      auctionOpenedPayloadSchema.safeParse({
        artwork_title: TITLE,
        starting_price_cents: 12_500,
        // What `to_json(timestamptz)` produces: an offset, not a `Z`.
        ends_at: "2026-09-15T14:00:00+00:00",
        auction_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        recipient_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      }).success,
    ).toBe(true);
  });

  it("rejects a title longer than the column allows", () => {
    // `artworks_title_length` caps at 120, so anything longer did not come from
    // an artwork row.
    expect(
      auctionLostPayloadSchema.safeParse({ artwork_title: "x".repeat(121) })
        .success,
    ).toBe(false);
  });
});
