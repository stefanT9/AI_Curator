# Auction Notifications for Likers — Implementation Plan

## Overview

When an auction opens, every collector who liked that artwork and has auction notifications enabled
is told about it (FR-003); every collector has an auction-notification preference, on by default,
which they can turn off from their account page or from a one-click link in any notification
(FR-005).

The two requirements ship together because the PRD revised FR-003 to depend on FR-005 — "a like was
never consent to be emailed". The phase order enforces that dependency structurally: the off-switch
is complete and tested before the first row that could send anything is ever enqueued.

## Current State Analysis

**The send infrastructure exists and is general.** S-04 (`outbound-email-foundation` + the outbox it
grew in `close-outcomes-and-contact-exchange`) left behind a bridge that is not close-specific:

- `email_outbox` holds one row per intended message, RLS on with no policies
  (`supabase/migrations/20260913120000_add_email_outbox.sql:36-75`).
- `claim_pending_emails` / `mark_email_sent` are the only two ways in, both `security definer`,
  both gated on the `email_drain_secret` vault entry, and both granted to `anon` because the drain
  runs with the publishable key.
- `/api/email/drain` runs `drainOutbox`, driven by a per-minute `pg_cron` job.
- `sendEmail` is the single choke point, never throws, returns a closed `SendFailure` union.

**The drain is already kind-agnostic.** `src/lib/email/outbox.ts:195` passes `row.kind` straight to
the compose dispatch and branches on nothing itself. A new message kind therefore needs a widened
CHECK constraint, a template, and a dispatch branch — and no drain change at all.

**Nothing about notification preference exists.** `profiles` carries no such column, and there is no
preferences table. FR-005 is entirely net-new.

**"Who liked this artwork" is not a query any session can run.** `interactions` RLS admits only
`(select auth.uid()) = user_id` (`20260909160200_add_interactions.sql:24-27`). Neither the artist's
session nor a collector's can enumerate likers of a piece. Resolving recipients therefore requires a
`security definer` function, exactly as the close path did.

**`profiles` cannot host the preference cleanly.** The table has two select policies — own-row
(`20260909144939_add_user.sql:15-18`) and artist-profiles-readable-by-any-signed-in-user
(`20260909160400_public_artist_profiles.sql:6-9`) — and column grants are the only thing scoping
either. A column added to the five-column grant would become readable across users for artist rows.

**`create_auction` already returns the auction id** (`20260911120000_add_auctions.sql:73-137`), which
`src/app/actions/auctions.ts:109` currently discards. The trigger topology means we never need it.

**There is no site-URL environment variable anywhere in the project.** The drain's URL lives in the
Supabase vault as `email_drain_url`, which is readable only by `postgres` and is reached over
`pg_net` — a different mechanism entirely, and not reusable for a link embedded in mail.

**Delivery is capped at one address.** `EMAIL_FROM=onboarding@resend.dev` in `.env.local` and
`.env.prod`. Resend's shared sender returns 403 for any recipient but the account owner, which
`outbox.ts:118` treats as terminal (`not_permitted`) rather than retrying. This is pre-existing and
already affects S-04; it is an env change, not a code change, and this plan does not depend on it.

## Desired End State

An artist lists a piece. Within a minute, every collector who liked that piece — except the artist
themselves, and except anyone who has turned auction notifications off — has an `email_outbox` row
addressed to them, which the drain sends and records in `email_sends`. The mail names the artwork,
the starting price and the closing time, links to the auction, and carries an unsubscribe link that
lands on a page explaining what will change, with a button that turns notifications off for good.
A collector who has turned notifications off gets no row — not "a row that fails to send", no row at
all.

Verified by: the integration lane asserting the recipient set and the gate directly against
`email_outbox`; the default lane asserting the template and its negative claims; and one manual send
to the developer's own address confirming the mail renders and the unsubscribe round-trips.

### Key Discoveries:

- The drain branches on nothing — `src/lib/email/outbox.ts:195` — so a fifth kind touches the CHECK
  constraint, the templates module and the dispatch, and stops there.
- `email_sends.kind` is free text, `check (char_length(kind) between 1 and 64)`
  (`20260912140000_add_email_sends.sql:37`) — no ledger migration needed for a new kind.
- `email_outbox.auction_id` is already nullable and FK-to-auctions with `on delete cascade`, so an
  auction-opened row fits the existing shape with no schema change beyond `kind`.
- `after()` precedent exists at `src/app/actions/artworks.ts:185`, but the trigger topology chosen
  here does not need it — the enqueue is a cheap insert inside the transaction that creates the
  auction.
- `enqueue_close_emails` (`20260913120000_add_email_outbox.sql:122+`) is the exact pattern to mirror:
  `security definer`, `set search_path = ''`, addresses resolved from `auth.users.email`.

## What We're NOT Doing

- **FR-004 taste-matched targeting.** That is S-06. This slice targets likers only.
- **A per-collector volume cap.** PRD Open Question 1, deferred to S-06 with reasons below.
- **HTML mail.** Plain text only, as in S-04.
- **A digest.** Rejected against the "notification reaches recipients promptly" guardrail.
- **A seller confirmation mail.** FR-003 names likers; the seller is excluded entirely.
- **Fixing the sending domain.** An env change, tracked separately from this code slice.
- **Notification preferences beyond the single auction on/off switch.** PRD §Non-Goals.
- **Backfilling preference rows.** Absent means enabled; see Phase 1.

## Implementation Approach

Four phases, ordered so that consent is complete before anything can send.

Phase 1 creates the preference and the place a collector changes it. Phase 2 builds the
unauthenticated off-switch — token, page and route — which is fully testable with no mail in
existence. Phase 3 adds the message kind and its template, which can now embed a real unsubscribe
link because Phase 2 built the token. Phase 4 adds the trigger that creates rows, at which point
every consent path it depends on already works.

The consequence worth stating: at no point in this sequence does a code path exist that can send an
auction notification without a working off-switch. The "off means off — from any path" guardrail is
therefore a property of the build order, not only of a test.

## Critical Implementation Details

**The gate belongs inside the enqueue function, not above it.** S-06 will extend recipient selection
to taste-matched collectors. If the preference check sits in the caller, S-06 adds a second recipient
source and the guardrail has two places to fail. Putting the join inside the `security definer`
enqueue function means S-06 widens the recipient query underneath a gate it cannot bypass.

**A gated-out collector gets no row, not a failed row.** `email_outbox` rows hold plaintext
addresses, and `email_sends` records every recipient. Enqueueing a row for someone who has opted out
and failing it later would write their address into both tables on account of a message they refused.
The filter is a join condition, not a post-send check.

**The unsubscribe secret must not be the drain's secret, and must not travel over `pg_net`.** The
existing rule in `AGENTS.md` — `net.http_request_queue` grants `PUBLIC` every privilege and this
project cannot revoke it — binds any future `pg_net` caller. The unsubscribe token is generated in
Node and embedded in a mail body, so it never touches that hop; the rule is recorded here so the
next person does not route it through one.

**Link scanners issue GETs.** Gmail, Outlook and security gateways prefetch URLs in mail. A GET that
mutates would unsubscribe people silently, which looks identical to the feature working. The GET
renders; only a POST mutates.

## Phase 1: The preference and its surface

### Overview

Create the notification preference and the place a collector changes it. Nothing sends yet; this
phase exists so that the switch is real before anything can be gated by it.

### Changes Required:

#### 1. Preferences table

**File**: `supabase/migrations/<timestamp>_add_notification_preferences.sql`

**Intent**: Give every collector an auction-notification setting that is on by default and readable
and writable only by its owner, without touching `profiles` — whose artist-readable select policy
would otherwise expose one user's preference to another.

**Contract**: New table `public.notification_preferences` keyed by `user_id uuid primary key
references public.profiles (id) on delete cascade`, carrying `auction_emails_enabled boolean not
null default true` and `updated_at timestamptz not null default now()`. RLS enabled with own-row
select, insert and update policies for `authenticated` — no artist-wide policy, and no select grant
beyond the owner. **Absent row means enabled**: no backfill, no signup-trigger change, and the
enqueue query in Phase 4 must left-join and treat null as enabled. Add a table comment saying so,
because the table's default and the query's null-handling encode the same rule in two places and a
future reader must not "fix" one of them.

#### 2. Preference Server Action

**File**: `src/app/actions/profile.ts`

**Intent**: Let a signed-in collector turn auction notifications on or off, upserting their row.

**Contract**: New exported action alongside `updateDisplayName`, taking the desired boolean through
a Zod-validated form field and upserting `notification_preferences` for `auth.uid()`. Follows the
existing action shape — validated at the boundary, returns a form state, calls `revalidatePath`
for `/account`. Note that every export of a `"use server"` module is a public endpoint: the action
must derive the user from the session and never accept a user id.

#### 3. Account page toggle

**Files**: `src/components/account/NotificationPreferenceForm.tsx`,
`src/app/(app)/account/page.tsx`

**Intent**: Surface the switch where a collector would look for it, beside the existing display-name
control.

**Contract**: New client component mirroring `DisplayNameForm`'s shape (form state, pending state,
optimistic or post-submit feedback). Rendered on the account page in its own section, visible to
every user — collector and artist alike, since artists are collectors too. The page reads the
current value server-side; a missing row renders as enabled.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db reset`
- Types regenerated and committed: `npm run db:types:local`
- Default lane passes, including new validation tests for the action: `npm run test`
- Integration lane proves own-row isolation — a second user cannot read or write the first user's
  preference row: `npm run test:integration`
- Format, lint, typecheck and build pass: `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run build`

#### Manual Verification:

- The account page shows the toggle, defaulted on, for a user with no preference row
- Turning it off and reloading shows it off; turning it back on persists too

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human before proceeding.

---

## Phase 2: Unsubscribe without a session

### Overview

Build the off-switch a recipient can use from their inbox, with no session and no login. This is the
first unauthenticated route in the project that acts on a user's behalf, so it is built and tested
before any mail can carry a link to it.

### Changes Required:

#### 1. Signed-token helper

**File**: `src/lib/email/unsubscribe.ts`

**Intent**: Mint and verify a token that proves "the holder of this link is the user it names",
without a database round-trip or a stored secret per user.

**Contract**: Two pure functions — one building a token from a user id, one verifying a token back to
a user id or null. HMAC-SHA256 over the user id plus a fixed purpose string, using a server-only
secret read **inside** the function (never at module scope — `next build` imports every module and CI
has no key), with the digest and payload encoded URL-safely. Verification must use a constant-time
comparison. Unset secret means verification fails closed, returning null. This module must never be
re-exported from a `"use server"` module.

#### 2. Environment entries

**Files**: `.env.example`, `.env.local`, `.env.prod`

**Intent**: Give the token a signing secret and give the mail an absolute base URL, neither of which
exists today.

**Contract**: Two new server-only names — a signing secret and a site base URL — documented in
`.env.example` with the same "read inside the function, unset degrades safely" note the email keys
carry. Neither is `NEXT_PUBLIC_`. The signing secret must be a distinct value from
`EMAIL_DRAIN_SECRET` and `EMAIL_DRAIN_TRIGGER_TOKEN`.

#### 3. Unsubscribe page and route

**Files**: `src/app/unsubscribe/page.tsx`, plus the mutating handler

**Intent**: Land the recipient on a page that says what will change, and flip the preference only on
an explicit POST — so that a link scanner's GET cannot unsubscribe anyone silently.

**Contract**: A route **outside** `(app)`, reachable signed-out. The GET renders: valid token → a
confirm button; invalid or missing token → a neutral failure that does not reveal whether the token
named a real user. The POST verifies the token again — never trusting a hidden field — and upserts
`auction_emails_enabled = false` for that user, then renders confirmation with a way back. Because
the caller has no session, the write needs a `security definer` function taking the verified user id,
granted narrowly; the anon key cannot satisfy the own-row policy from Phase 1. Offer re-subscribe on
the confirmation page.

### Success Criteria:

#### Automated Verification:

- Default lane covers the token round-trip, tamper rejection, wrong-purpose rejection, and
  fail-closed behaviour with the secret unset: `npm run test`
- Default lane asserts the GET performs no mutation
- Integration lane proves an unsubscribe POST flips the row, and that the definer function cannot be
  used to flip an arbitrary user without a valid token: `npm run test:integration`
- Format, lint, typecheck and build pass

#### Manual Verification:

- Visiting a valid unsubscribe URL signed out renders the confirm page and does not change anything
- Pressing the button turns the preference off, visible on the account page after signing in
- A tampered token shows the neutral failure page

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: The fifth outbox kind

### Overview

Teach the outbox and the templates about an auction-opened message. The drain needs no change.

### Changes Required:

#### 1. Widen the kind constraint

**File**: `supabase/migrations/<timestamp>_add_auction_opened_outbox_kind.sql`

**Intent**: Admit a fifth `kind` value into `email_outbox`.

**Contract**: Drop and recreate the `kind` check constraint to include `auction_opened` alongside the
four close kinds. `email_sends.kind` is free text and needs nothing. Never edit the original
migration — this is a new one.

#### 2. Template and payload schema

**File**: `src/lib/email/templates.ts`

**Intent**: Render the notification, and make its payload shape explicit so an unrenderable row fails
as one row rather than breaking the batch.

**Contract**: Add `auction_opened` to `OUTBOX_KINDS`, a strict Zod payload schema, and a message
builder returning `ComposedMessage`. Payload carries the artwork title, the starting price, the
closing time, the auction id (for the link) and the unsubscribe token — the recipient address stays
out, as the existing comment explains. Body is plain text, names the piece, the starting price and
when it closes, links to the auction, states plainly that the collector is receiving it because they
liked the piece, and closes with the unsubscribe link built from the Phase 2 base URL. It must not
state or imply anything about other bidders — the sealed guardrail holds on every surface, mail
included.

#### 3. Dispatch and rename

**Files**: `src/lib/email/templates.ts`, `src/lib/email/outbox.ts`, `src/lib/email/index.ts`

**Intent**: Route the new kind, and stop calling the dispatch a close-email composer now that it
renders a message that has nothing to do with a close.

**Contract**: Add the `auction_opened` branch to the dispatch and rename `composeCloseEmail` to
`composeOutboxEmail`, updating its call site at `outbox.ts:195`, the barrel export, and tests. The
unknown-kind default must keep returning null so an unrenderable row is marked failed with
`unrenderable` rather than aborting the batch.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db reset`
- Types regenerated: `npm run db:types:local`
- Default lane covers the new template's happy path, its schema rejections, and its negative
  assertions — no bid amount, no bid count, no other bidder's identity anywhere in the body:
  `npm run test`
- Default lane still covers the four close templates under the renamed dispatch
- Integration lane confirms `email_outbox` accepts an `auction_opened` row and still rejects an
  unknown kind: `npm run test:integration`
- Format, lint, typecheck and build pass

#### Manual Verification:

- A hand-inserted `auction_opened` row drains and the rendered mail reads correctly, with a working
  auction link and a working unsubscribe link

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Targeting, enqueue, and end-to-end proof

### Overview

Create the rows. An after-insert trigger on `auctions` resolves likers, applies the preference gate,
excludes the seller, and writes one outbox row per recipient.

### Changes Required:

#### 1. Enqueue function and trigger

**File**: `supabase/migrations/<timestamp>_enqueue_auction_opened_emails.sql`

**Intent**: When an auction row appears, enqueue one notification per eligible liker — inside the
database, so that every path that creates an auction is covered and S-06 can widen the recipient
query underneath the same gate.

**Contract**: A `security definer` function with `set search_path = ''`, mirroring
`enqueue_close_emails`, fired by an `after insert on public.auctions` trigger. Recipient set:
collectors with a `like` interaction on the auction's artwork, left-joined to
`notification_preferences` with null treated as enabled and `false` excluded, minus the seller,
minus anyone whose `auth.users.email` is null or empty. Addresses come from `auth.users.email` and
never from `profiles.email`, which is written once at signup and never synced. One row per recipient,
`kind = 'auction_opened'`, payload per the Phase 3 schema, including each recipient's own unsubscribe
token.

The gate is a join condition, not a post-send check: an opted-out collector must produce **no row**,
because a row would write their address into `email_outbox` and then into `email_sends` on account of
a message they refused.

Note on the token: minting an HMAC inside Postgres requires the signing secret to be reachable from
SQL. Resolve this during implementation — either mint via `pgcrypto` with the secret held in Vault
alongside the existing drain entries, or have the template build the link at render time from the
recipient id in the payload. The second keeps the secret in Node only and is preferred if the payload
can carry the user id without widening what the drain can see; the drain already holds the address,
so a user id adds no disclosure. Whichever is chosen, record it in the migration comment.

#### 2. Reuse check on the artwork title

**File**: same migration

**Intent**: Avoid a second notion of how an artwork is named in mail.

**Contract**: Read `artworks.title` the same way `enqueue_close_emails` does, so both paths agree.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase db reset`
- Types regenerated: `npm run db:types:local`
- Integration lane proves, against real Postgres and real RLS: creating an auction enqueues exactly
  one row per liker; the seller gets none even when they liked their own piece; a collector with
  `auction_emails_enabled = false` gets **no row at all**; a collector with no preference row does
  get one; a non-liker gets none; and an artwork with no likers enqueues nothing without erroring:
  `npm run test:integration`
- Integration lane proves the drain sends these rows and records them in `email_sends` with
  `kind = 'auction_opened'`
- Default lane and the full gate pass: `npm run test` · `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run build`

#### Manual Verification:

- Listing a piece that a second account has liked produces a pending `email_outbox` row within the
  transaction, and the per-minute drain sends it
- The received mail renders correctly and its unsubscribe link turns the preference off
- After unsubscribing, listing another liked piece produces no row for that collector
- Re-subscribing restores it
- Discovery is untouched: swiping, liking and the liked-artworks view behave exactly as before

**Implementation Note**: Pause for manual confirmation before closing the plan.

---

## Testing Strategy

Lane ownership follows `AGENTS.md`:

### Default lane (`npm run test`) — runs in CI

- The preference action's Zod gate and happy path, Supabase mocked
- The unsubscribe token: round-trip, tamper rejection, wrong purpose, fail-closed with no secret
- The `auction_opened` template: happy path, schema rejections, and the negative assertions — no bid
  amount, no bid count, no bidder identity in the body
- The renamed dispatch still routing the four close kinds

### Integration lane (`npm run test:integration`) — local only, opt-in

Owns everything that is a claim about grants, policies or the absence of them, because generated
types reflect the catalog and not the grants:

- `notification_preferences` own-row isolation between two real users
- The unsubscribe definer function's refusal to flip an arbitrary user without a valid token
- The full recipient matrix in Phase 4 — the gate, the seller exclusion, the non-liker exclusion,
  the absent-row-means-enabled case
- `email_outbox` accepting `auction_opened` and still rejecting an unknown kind

Mint one test user per file — `[auth.rate_limit] sign_in_sign_ups` is 30 per 5 minutes per IP.

### Smoke lane (`npm run test:smoke`) — manual

One real send of an `auction_opened` mail to the developer's own address, confirming it renders in a
real client and the unsubscribe link round-trips.

### What no lane covers

Delivery to any address other than the Resend account owner's, for as long as `EMAIL_FROM` is the
shared sender. Every FR-003 and FR-005 guardrail is asserted against outbox and ledger rows precisely
so that this gap does not leave the slice unproven.

## Migration Notes

Four migrations, applied in timestamp order: the preferences table, the unsubscribe definer function
(may be folded into the preferences migration if written in the same session), the widened `kind`
constraint, and the enqueue function plus trigger. Pushing to `main` auto-deploys them via
`.github/workflows/migrations.yml`.

No backfill. Absent preference rows mean enabled, so existing users need nothing, and likes recorded
before this change count normally — the enqueue query reads `interactions` as it finds it, which is
what §Constraints requires.

`supabase db reset` clears the Vault, so a local reset still needs the three existing drain entries
replanted, plus a fourth if the Phase 4 token decision puts the signing secret in SQL. See
`supabase/seed-assets/README.md`.

## References

- Roadmap slice S-05: `context/foundation/roadmap.md`
- PRD: `context/foundation/prd-v3.md` — FR-003, FR-005, §Guardrails
- The outbox this reuses: `context/archive/2026-09-12-close-outcomes-and-contact-exchange/plan.md`
- The send choke point: `context/archive/2026-09-12-outbound-email-foundation/plan.md`
- Pattern to mirror for enqueue: `supabase/migrations/20260913120000_add_email_outbox.sql:122+`
- Lessons: `context/foundation/lessons.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The preference and its surface

#### Automated

- [x] 1.1 Migration applies cleanly: `npx supabase db reset` — 4f37c2c
- [x] 1.2 Types regenerated and committed: `npm run db:types:local` — 4f37c2c
- [x] 1.3 Default lane passes, including new validation tests for the action: `npm run test` — 4f37c2c
- [x] 1.4 Integration lane proves own-row isolation between two users: `npm run test:integration` — 4f37c2c
- [x] 1.5 Format, lint, typecheck and build pass — 4f37c2c

#### Manual

- [x] 1.6 The account page shows the toggle, defaulted on, for a user with no preference row — 4f37c2c
- [x] 1.7 Turning it off and reloading shows it off; turning it back on persists too — 4f37c2c

### Phase 2: Unsubscribe without a session

#### Automated

- [x] 2.1 Default lane covers token round-trip, tamper, wrong purpose, and fail-closed: `npm run test`
- [x] 2.2 Default lane asserts the GET performs no mutation
- [x] 2.3 Integration lane proves the POST flips the row and the definer function refuses an invalid token: `npm run test:integration`
- [x] 2.4 Format, lint, typecheck and build pass

#### Manual

- [x] 2.5 A valid unsubscribe URL signed out renders the confirm page and changes nothing
- [x] 2.6 Pressing the button turns the preference off, visible on the account page
- [x] 2.7 A tampered token shows the neutral failure page

### Phase 3: The fifth outbox kind

#### Automated

- [ ] 3.1 Migration applies cleanly: `npx supabase db reset`
- [ ] 3.2 Types regenerated: `npm run db:types:local`
- [ ] 3.3 Default lane covers the new template, its schema rejections, and its negative assertions: `npm run test`
- [ ] 3.4 Default lane still covers the four close templates under the renamed dispatch
- [ ] 3.5 Integration lane confirms `email_outbox` accepts `auction_opened` and rejects an unknown kind: `npm run test:integration`
- [ ] 3.6 Format, lint, typecheck and build pass

#### Manual

- [ ] 3.7 A hand-inserted `auction_opened` row drains and renders correctly, with working auction and unsubscribe links

### Phase 4: Targeting, enqueue, and end-to-end proof

#### Automated

- [ ] 4.1 Migration applies cleanly: `npx supabase db reset`
- [ ] 4.2 Types regenerated: `npm run db:types:local`
- [ ] 4.3 Integration lane proves the full recipient matrix — one row per liker, seller excluded, opted-out collector gets no row, absent-row collector gets one, non-liker excluded, no-liker artwork enqueues nothing: `npm run test:integration`
- [ ] 4.4 Integration lane proves the drain sends these rows and records `kind = 'auction_opened'` in `email_sends`
- [ ] 4.5 Default lane and the full gate pass: `npm run test` · `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run build`

#### Manual

- [ ] 4.6 Listing a piece a second account liked produces a pending row, and the drain sends it
- [ ] 4.7 The received mail renders correctly and its unsubscribe link turns the preference off
- [ ] 4.8 After unsubscribing, listing another liked piece produces no row for that collector
- [ ] 4.9 Re-subscribing restores it
- [ ] 4.10 Discovery is untouched: swiping, liking and the liked-artworks view behave exactly as before
