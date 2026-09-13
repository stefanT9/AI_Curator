import { describe, expect, it } from "vitest";
import {
  auctionLostPayloadSchema,
  auctionUnsoldPayloadSchema,
  auctionWonPayloadSchema,
  composeCloseEmail,
} from "@/lib/email/templates";

/**
 * What each of the four people is told, and — for the two who are told least —
 * what they are provably not told.
 *
 * The negative assertions are the point of this file. §Access Control permits
 * exactly one new disclosure, the winner and the seller learning each other's
 * address, and a losing bidder is not part of it. That boundary is held twice:
 * once in the database, where the enqueue trigger never stores an amount or a
 * counterparty on an `auction_lost` row (`test/integration/email-outbox.int.ts`
 * asserts that against real Postgres), and once here, where the schema has no
 * field to put one in. This file owns the second half — the half that would
 * still hold if someone widened the payload.
 */

const TITLE = "Harbour at Dusk";
const AMOUNT_CENTS = 42_000;
const COUNTERPARTY = "other.party@example.test";

const won = {
  artwork_title: TITLE,
  amount_cents: AMOUNT_CENTS,
  counterparty_email: COUNTERPARTY,
};

const compose = (kind: string, payload: unknown) => {
  const message = composeCloseEmail(kind, payload);
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
      composeCloseEmail("auction_lost", {
        artwork_title: TITLE,
        counterparty_email: COUNTERPARTY,
      }),
    ).toBeNull();

    expect(
      composeCloseEmail("auction_lost", {
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

describe("the dispatcher", () => {
  it("returns null for a kind this build does not know", () => {
    // A newer migration against an older deploy. Null rather than a throw: the
    // drain marks that one row failed and the rest of the batch still goes out.
    expect(
      composeCloseEmail("auction_relisted", { artwork_title: TITLE }),
    ).toBe(null);
    expect(composeCloseEmail("", {})).toBeNull();
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
    expect(composeCloseEmail("auction_won", payload)).toBeNull();
  });

  it("ignores an unknown key on a contact-exchange payload", () => {
    // These two are deliberately non-strict: their contract is what they carry,
    // and a field added by a later migration must not make an in-flight "you
    // won" notice unsendable mid-deploy.
    const message = composeCloseEmail("auction_won", {
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
