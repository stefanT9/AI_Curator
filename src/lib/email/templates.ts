import * as z from "zod";
import { formatCents } from "@/lib/auctions/price";
import type { EmailMessage } from "./send";

/**
 * The whole of what each person an auction concerns is told.
 *
 * Pure functions, no I/O, no database and no `server-only` — which is what
 * makes the entire disclosure boundary reviewable as prose and assertable in
 * the default lane. Nothing here can reach a recipient it was not handed, and
 * nothing here reads the environment: the one message that carries links takes
 * them as an argument (see `OutboxLinks`) rather than building them from a
 * secret, so its body is as assertable as the four that carry none.
 *
 * **The payload is external input.** It arrives as `jsonb` off an
 * `email_outbox` row, so it is Zod-parsed at this boundary like every other
 * boundary in the project. The schemas are not ceremony: they are the second
 * half of the §Access Control guarantee. The first half is that the enqueue
 * trigger never *stores* an amount or a counterparty on an `auction_lost` row
 * (20260913120000_add_email_outbox.sql); the second is that `auction_lost`'s
 * schema has no field to put one in, so a row that somehow carried one still
 * could not render it.
 *
 * | kind | may name | must never name |
 * | --- | --- | --- |
 * | `auction_won` | title, winning amount, seller's email | any other bidder, the bid count |
 * | `auction_sold` | title, winning amount, winner's email | any other bidder, the bid count, losing amounts |
 * | `auction_lost` | title | the amount, the winner, the seller's email, the bid count |
 * | `auction_unsold` | title, that it is free to relist | that nobody bid, in those words |
 * | `auction_opened` | title, the starting price, when it closes, a link to it | any bid, any bidder, any address |
 *
 * Plain text only. HTML mail is explicitly out of scope for this slice, and a
 * text body is the one form no client can mangle.
 */

/** The five variants the outbox's `kind` check constraint admits. */
export const OUTBOX_KINDS = [
  "auction_won",
  "auction_sold",
  "auction_lost",
  "auction_unsold",
  "auction_opened",
] as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * `EmailMessage` minus the recipient. The outbox row already holds the address
 * — resolved from `auth.users` at enqueue time — and a template that could
 * choose a recipient would be a template that could misdirect one.
 */
export type ComposedMessage = Omit<EmailMessage, "to">;

/**
 * The absolute URLs an `auction_opened` body carries, supplied by the caller.
 *
 * Mail has no origin to be relative to and the unsubscribe link is an HMAC over
 * a server-only secret, so both are environment-dependent — and reading the
 * environment here would make every assertion in this file depend on what
 * happened to be set. Injecting them instead keeps the templates pure: the
 * drain hands in the real implementations (`./links`), and a test hands in
 * whatever it means to assert against, including the nulls an unconfigured
 * environment produces.
 *
 * Either function returning null means "this environment cannot build that
 * link", which is a refusal to compose rather than a link left out. See
 * `auctionOpenedMessage`.
 */
export type OutboxLinks = {
  /** The auction's page, absolute. */
  auction: (auctionId: string) => string | null;
  /** The one-click off switch for this recipient, absolute and signed. */
  unsubscribe: (userId: string) => string | null;
};

/** `artworks.title` is `not null` and 1–120 chars (20260909160100:8,15). */
const artworkTitle = z.string().trim().min(1).max(120);

const amountCents = z.number().int().positive();

/**
 * The two contact-exchange payloads. Plain `z.object` rather than
 * `z.strictObject`: their contract is what they *carry*, and an unknown key
 * added by a later migration should be ignored rather than turned into an
 * unsendable row mid-deploy.
 */
const contactExchangePayload = z.object({
  artwork_title: artworkTitle,
  amount_cents: amountCents,
  counterparty_email: z.email(),
});

export const auctionWonPayloadSchema = contactExchangePayload;
export const auctionSoldPayloadSchema = contactExchangePayload;

/**
 * The two payloads whose contract is an *absence*, and therefore the two that
 * are strict: an extra key here is not a harmless addition, it is the failure
 * this slice is most afraid of. `z.strictObject` rejects rather than strips, so
 * a payload carrying a counterparty under any name at all fails to compose and
 * is marked failed with a reason, instead of quietly rendering a body that
 * silently dropped it.
 */
export const auctionLostPayloadSchema = z.strictObject({
  artwork_title: artworkTitle,
});

export const auctionUnsoldPayloadSchema = z.strictObject({
  artwork_title: artworkTitle,
});

/**
 * The third payload whose contract is an absence, and strict for the same
 * reason — more so, if anything. This message reaches a collector who has not
 * bid and may never bid: they liked a piece once, which the PRD is explicit was
 * never consent to be told anything else. Nothing about anyone's bidding
 * belongs in it, and a strict schema is what makes "belongs in it" a fact about
 * the row rather than a promise about the trigger.
 *
 * `recipient_id` is the *recipient's own* user id, and it is here so the
 * unsubscribe link can be minted in Node at render time — the signing secret
 * never reaches SQL (see 20260913130200_add_auction_opened_outbox_kind.sql).
 * It discloses nothing new: the row beside it already holds this person's
 * address.
 *
 * `ends_at` arrives as whatever `to_json(timestamptz)` produced, which is ISO
 * 8601 with an offset rather than a `Z`.
 */
export const auctionOpenedPayloadSchema = z.strictObject({
  artwork_title: artworkTitle,
  starting_price_cents: amountCents,
  ends_at: z.iso.datetime({ offset: true }),
  auction_id: z.uuid(),
  recipient_id: z.uuid(),
});

export type AuctionWonPayload = z.infer<typeof auctionWonPayloadSchema>;
export type AuctionSoldPayload = z.infer<typeof auctionSoldPayloadSchema>;
export type AuctionLostPayload = z.infer<typeof auctionLostPayloadSchema>;
export type AuctionUnsoldPayload = z.infer<typeof auctionUnsoldPayloadSchema>;
export type AuctionOpenedPayload = z.infer<typeof auctionOpenedPayloadSchema>;

/**
 * No address, no link, no footer. Anything appended here would be appended to
 * the `auction_lost` body too, where an `@` is a §Access Control failure.
 */
const SIGNATURE = "— ArtSwipe";

const body = (...paragraphs: string[]): string =>
  paragraphs.concat(SIGNATURE).join("\n\n") + "\n";

/**
 * When the auction closes, stated in UTC and labelled as such.
 *
 * The app renders `ends_at` in the reader's own zone, which mail cannot do —
 * this runs on a server whose zone is an accident of where it is deployed. An
 * unlabelled local time would be wrong for almost every recipient in a way that
 * looks right; UTC is at least unambiguous. The in-app countdown
 * (`AuctionCountdown`) remains the authority on how long is left.
 */
const closingDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const closingTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/** "Sep 15, 2026 at 2:00 PM UTC". */
const formatClosing = (isoTimestamp: string): string => {
  const at = new Date(isoTimestamp);
  return `${closingDateFormatter.format(at)} at ${closingTimeFormatter.format(at)}`;
};

/**
 * FR-009, one half of the one new disclosure §Access Control permits: the
 * winner learns they won, at what amount, and how to reach the seller.
 */
export function auctionWonMessage(payload: AuctionWonPayload): ComposedMessage {
  return {
    subject: `You won the auction for "${payload.artwork_title}"`,
    text: body(
      `Congratulations — your bid of ${formatCents(payload.amount_cents)} won the auction for "${payload.artwork_title}".`,
      `To arrange payment and delivery, write to the seller directly at ${payload.counterparty_email}. They have your address too, so either of you can start.`,
      "ArtSwipe does not handle payment or shipping — the two of you settle it between yourselves.",
    ),
  };
}

/**
 * The other half: the seller learns what it sold for and how to reach the
 * person who bought it. No losing amount and no bid count — the seller cannot
 * read `bids` in the app either, and this message must not become the way
 * around that.
 */
export function auctionSoldMessage(
  payload: AuctionSoldPayload,
): ComposedMessage {
  return {
    subject: `"${payload.artwork_title}" sold for ${formatCents(payload.amount_cents)}`,
    text: body(
      `Your auction for "${payload.artwork_title}" has ended. It sold for ${formatCents(payload.amount_cents)}.`,
      `To arrange payment and delivery, write to the buyer directly at ${payload.counterparty_email}. They have your address too, so either of you can start.`,
      "ArtSwipe does not handle payment or shipping — the two of you settle it between yourselves.",
    ),
  };
}

/**
 * Everyone else who bid. They learn which piece it was and that they did not
 * win, and nothing else: not the amount it went for, not who won it, not the
 * seller's address, not how many people were bidding.
 *
 * The same boundary the closed-auction page already holds
 * (`src/app/(app)/auctions/[id]/page.tsx` — `closedOutcome`), held again here
 * because this message reaches someone who is not looking at the page.
 */
export function auctionLostMessage(
  payload: AuctionLostPayload,
): ComposedMessage {
  return {
    subject: `The auction for "${payload.artwork_title}" has ended`,
    text: body(
      `The auction for "${payload.artwork_title}" has ended, and your bid was not the winning one.`,
      "Thanks for bidding. There is more to discover whenever you are ready.",
    ),
  };
}

/**
 * A seller whose auction drew no bids.
 *
 * The framing is a PRD decision, not a style preference. FR-010's Socrates note
 * records that _"'nobody bid on your work' is a discouraging message"_ and
 * resolves it as _"a closing notice with the artwork free to relist, not a
 * failure report."_ Do not "improve" this copy back into a report of what did
 * not happen: it must not count the bids, and it must not say that nobody bid.
 */
export function auctionUnsoldMessage(
  payload: AuctionUnsoldPayload,
): ComposedMessage {
  return {
    subject: `Your auction for "${payload.artwork_title}" has ended`,
    text: body(
      `Your auction for "${payload.artwork_title}" has ended and the piece is yours again.`,
      "You can list it again from your studio whenever you like — there is no limit on how often a piece can go up.",
    ),
  };
}

/**
 * FR-003: a collector who liked a piece is told when it goes up for auction.
 *
 * Three things this body must do, and one it must not.
 *
 * It names the piece, what it opens at and when it closes, and it links
 * straight to the auction — a notification that does not carry the thing it is
 * about is a notification that wastes the recipient's time.
 *
 * It says why they are getting it. "A like was never consent to be emailed" is
 * the PRD's own phrasing for why FR-003 was revised to depend on FR-005; the
 * least this message can do is be honest about which of their own actions
 * produced it.
 *
 * It carries the off switch, in the message itself, because §Guardrails says
 * "off means off — from any path" and the inbox is the path a recipient is
 * actually on.
 *
 * And it says **nothing about bidding**. No amount anyone has offered, no count
 * of how many have, no bidder named or hinted at. The starting price is the
 * seller's own asking figure and the only currency figure permitted here; the
 * sealed guardrail holds on every surface, mail included.
 *
 * Returns null when either link cannot be built, which is the one respect in
 * which it differs from the four above. A mail advertising an unsubscribe link
 * that does not work is worse than a mail not sent — the recipient reads a
 * promise the product then breaks — so an unconfigured environment produces no
 * message at all and the drain retires the row as `unrenderable`.
 */
export function auctionOpenedMessage(
  payload: AuctionOpenedPayload,
  links: OutboxLinks,
): ComposedMessage | null {
  const auctionUrl = links.auction(payload.auction_id);
  const unsubscribeUrl = links.unsubscribe(payload.recipient_id);

  if (!auctionUrl || !unsubscribeUrl) return null;

  return {
    subject: `"${payload.artwork_title}" is up for auction`,
    text: body(
      `A piece you liked on ArtSwipe is up for auction.`,
      `"${payload.artwork_title}" opens at ${formatCents(payload.starting_price_cents)} and closes on ${formatClosing(payload.ends_at)}.`,
      `See it here: ${auctionUrl}`,
      `You are getting this because you liked this piece. To stop receiving auction notifications, open this link: ${unsubscribeUrl}`,
    ),
  };
}

/**
 * `kind` → message, with the payload validated on the way through.
 *
 * Returns `null` rather than throwing, for three situations the drain treats
 * identically: a `kind` this build does not recognise (a newer migration
 * against an older deploy), a payload that fails its schema, and an
 * `auction_opened` row in an environment that cannot build its links. Either
 * way the row cannot be rendered, and the drain marks it failed with a reason
 * rather than aborting the batch — one unrenderable row must not hold up the
 * "you won" notice queued behind it.
 *
 * `links` is required rather than defaulted, for the four kinds that ignore it
 * as much as for the one that does not: a default would make "this build cannot
 * build links" indistinguishable from "this caller forgot to pass them", and
 * the symptom of the second is mail that silently stops going out.
 */
export function composeOutboxEmail(
  kind: string,
  payload: unknown,
  links: OutboxLinks,
): ComposedMessage | null {
  switch (kind) {
    case "auction_won": {
      const parsed = auctionWonPayloadSchema.safeParse(payload);
      return parsed.success ? auctionWonMessage(parsed.data) : null;
    }
    case "auction_sold": {
      const parsed = auctionSoldPayloadSchema.safeParse(payload);
      return parsed.success ? auctionSoldMessage(parsed.data) : null;
    }
    case "auction_lost": {
      const parsed = auctionLostPayloadSchema.safeParse(payload);
      return parsed.success ? auctionLostMessage(parsed.data) : null;
    }
    case "auction_unsold": {
      const parsed = auctionUnsoldPayloadSchema.safeParse(payload);
      return parsed.success ? auctionUnsoldMessage(parsed.data) : null;
    }
    case "auction_opened": {
      const parsed = auctionOpenedPayloadSchema.safeParse(payload);
      return parsed.success ? auctionOpenedMessage(parsed.data, links) : null;
    }
    default:
      return null;
  }
}
