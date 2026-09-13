-- The fifth outbox kind: the notification a liker gets when a piece they liked
-- goes up for auction (FR-003).
--
-- S-04 built the outbox general rather than close-specific, and the drain
-- proves it: `src/lib/email/outbox.ts` passes `row.kind` straight to the
-- compose dispatch and branches on nothing itself. So a new kind of
-- transactional mail is a widened check constraint, a template and a dispatch
-- branch -- and no drain change at all. `email_sends.kind` is free text
-- (`check (char_length(kind) between 1 and 64)`,
-- 20260912140000_add_email_sends.sql:37), so the ledger needs nothing either.
--
-- **Why a new migration rather than an edit.** 20260913120000 is applied
-- everywhere this schema exists. Never edit an already-applied migration --
-- add one.
--
-- **The payload decision this migration records, for the trigger that Phase 4
-- will add.** An `auction_opened` body carries an unsubscribe link, and the
-- HMAC behind that link is minted in Node, never here. `UNSUBSCRIBE_TOKEN_SECRET`
-- can mint a valid token for any user forever, so it stays in the Node process:
-- it is never sent to Postgres and never put in the Vault
-- (20260913130100_add_unsubscribe_write.sql says the same from the other side,
-- and AGENTS.md records it as a project rule). The alternative -- minting the
-- token here with `pgcrypto` over a vault-held key -- is therefore foreclosed.
--
-- What the payload carries instead is the recipient's **user id**, and the
-- template builds the link at render time. That discloses nothing the drain did
-- not already hold: `claim_pending_emails` hands back `recipient_email`, so a
-- caller that can see the row can already see the person. A user id next to it
-- adds no reader and no secret.
--
-- The payload shape the template enforces (`src/lib/email/templates.ts`,
-- `auctionOpenedPayloadSchema`) is strict, for the same reason `auction_lost`'s
-- is: this message reaches a collector who has not bid and may never bid, so
-- there is nothing about anyone's bidding it may carry. A payload that smuggled
-- an amount or a bidder in fails to compose rather than rendering a body that
-- quietly dropped it.

alter table public.email_outbox
  drop constraint email_outbox_kind_check;

alter table public.email_outbox
  add constraint email_outbox_kind_check check (
    kind in (
      'auction_won',
      'auction_sold',
      'auction_lost',
      'auction_unsold',
      'auction_opened'
    )
  );

comment on column public.email_outbox.kind is
  'Which message this row is. The four close outcomes are written by enqueue_close_emails; auction_opened is written when an auction is created, to every collector who liked the piece and has not turned auction emails off. The constraint is the list the compose dispatch in src/lib/email/templates.ts knows -- widening one without the other leaves rows that can never render, which the drain retires as `unrenderable`.';
