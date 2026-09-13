import * as z from "zod";
import { formatCents } from "@/lib/auctions/price";
import type { EmailMessage } from "./send";

/**
 * The whole of what each of the four people an auction close concerns is told.
 *
 * Pure functions, no I/O, no database and no `server-only` — which is what
 * makes the entire disclosure boundary reviewable as prose and assertable in
 * the default lane. Nothing here can reach a recipient it was not handed.
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
 *
 * Plain text only. HTML mail is explicitly out of scope for this slice, and a
 * text body is the one form no client can mangle.
 */

/** The four variants the outbox's `kind` check constraint admits. */
export const OUTBOX_KINDS = [
  "auction_won",
  "auction_sold",
  "auction_lost",
  "auction_unsold",
] as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * `EmailMessage` minus the recipient. The outbox row already holds the address
 * — resolved from `auth.users` at enqueue time — and a template that could
 * choose a recipient would be a template that could misdirect one.
 */
export type ComposedMessage = Omit<EmailMessage, "to">;

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

export type AuctionWonPayload = z.infer<typeof auctionWonPayloadSchema>;
export type AuctionSoldPayload = z.infer<typeof auctionSoldPayloadSchema>;
export type AuctionLostPayload = z.infer<typeof auctionLostPayloadSchema>;
export type AuctionUnsoldPayload = z.infer<typeof auctionUnsoldPayloadSchema>;

/**
 * No address, no link, no footer. Anything appended here would be appended to
 * the `auction_lost` body too, where an `@` is a §Access Control failure.
 */
const SIGNATURE = "— ArtSwipe";

const body = (...paragraphs: string[]): string =>
  paragraphs.concat(SIGNATURE).join("\n\n") + "\n";

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
 * `kind` → message, with the payload validated on the way through.
 *
 * Returns `null` rather than throwing, for two different situations the drain
 * treats identically: a `kind` this build does not recognise (a newer migration
 * against an older deploy) and a payload that fails its schema. Either way the
 * row cannot be rendered, and the drain marks it failed with a reason rather
 * than aborting the batch — one unrenderable row must not hold up the "you won"
 * notice queued behind it.
 */
export function composeCloseEmail(
  kind: string,
  payload: unknown,
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
    default:
      return null;
  }
}
