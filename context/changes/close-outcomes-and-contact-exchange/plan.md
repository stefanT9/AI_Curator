# Close Outcomes and Contact Exchange Implementation Plan

## Overview

Roadmap slice **S-04**. When an auction closes, the four people it concerns learn what happened —
and the two who now have a sale to complete get each other's email address. The winner is told they
won, at what amount, and how to reach the seller; the seller is told what it sold for and how to
reach the winner; every losing bidder is told only that they did not win; and a seller whose auction
drew no bids is told it ended and the piece is free to relist.

Nothing in the product sends mail today from any path a user can trigger, and the event that starts
this one happens inside Postgres where no app code runs. The work is therefore half a bridge and
half a message.

## Current State Analysis

**The outcome exists and is durable.** `close_due_auctions`
(`supabase/migrations/20260912120000_add_auction_close.sql:87-127`) stamps `closed_at`,
`winning_bid_id` and `winning_amount_cents` in one statement under a `for update skip locked` lock,
driven by a per-minute `pg_cron` job. `closed_at` is written exactly once and never moves — pinned
by `test/integration/auction-close.int.ts:339-352`, whose assertion carries an explicit forward
reference to this slice: _"a re-close would move it, and S-04 will trigger on that timestamp being
written exactly once."_

**The send path exists and is unused.** `sendEmail` (`src/lib/email/send.ts:100`) is the only code
in the repo that talks to a mail provider, never throws, and returns `{ ok: false, reason }` over a
six-variant union. `recordSend` (`src/lib/email/record.ts:60`) writes one append-only ledger row per
attempt through `record_email_send`, which takes `actor_id` from `auth.uid()` itself. `email_sends`
has RLS enabled with **no policies at all** and is read only over a direct connection. Nothing in
the running app calls any of it.

**The two halves cannot reach each other.** `close_due_auctions` is granted to nobody — the `revoke`
at `20260912120000_add_auction_close.sql:129-132` has no matching `grant`, and that omission is the
access control that makes exposing its `p_now` test seam safe. The migration names the only callers
left: _"the cron job (running as `postgres`, which owns this function) and a direct postgres
connection."_ A database-triggered close cannot call Node.

**There is no path by which one user reads another's contact details.** `profiles` revokes
table-wide select and re-grants exactly `(id, display_name, role, created_at, updated_at)`
(`20260909160400_public_artist_profiles.sql:15-17`), with the rationale stated in the file: the
row-level "signed-in users can read artist profiles" policy _"on its own would hand out the artist's
email along with their name"_, and column grants are the only thing that scopes a select.

**`profiles.email` is written once and never synced.** `handle_new_user`
(`20260909144939_add_user.sql:32-49`) fires `after insert on auth.users` only. A user who changes
their address in Supabase Auth leaves `profiles.email` stale, and a stale address is a wrong
disclosure.

**Every new endpoint is redirected to `/login`.** The proxy matcher
(`src/proxy.ts:15-17`) excludes only static assets and the literal `auth/confirm`, and `isPublic`
(`src/utils/supabase/proxy.ts:9-20`) admits only `/`, `/login`, `/signup*` and `/auth/*`. An
unauthenticated POST to a new route is 307-redirected — method preserved — at a page route, which
fails as a plumbing bug rather than an auth error.

**What does not exist at all.** `grep -rn -i -E "notified_at|outbox|pg_net"` over `src/`,
`supabase/migrations/`, `scripts/` and `test/` finds nothing relevant. `pg_net` is available in the
Supabase image (0.20.4) but not installed; the `supabase_functions` webhook machinery is present and
non-functional without it. `supabase_vault` **is** installed. There are no scheduled GitHub
workflows and no `vercel.json` / `vercel.ts`.

**The closed-auction page already says the right things, and deliberately stops short.**
`closedOutcome` (`src/app/(app)/auctions/[id]/page.tsx:32-61`) has four viewer branches — seller
sold, seller unsold, winner, losing bidder — and discloses no identity, no bid count and no losing
amount. Its docblock records that this leaves §Access Control's "one new disclosure" entirely to
this slice.

## Desired End State

An auction closes. Within roughly two minutes — one for the close sweep, one for the drain — four
emails have been attempted, one per person the outcome concerns, and every attempt is a row in
`email_sends` with its reason. The winner's message names the seller's email address; the seller's
names the winner's; the losing bidder's names neither. A seller whose auction drew no bids has a
message framed as a closing notice with the piece free to relist, not a failure report.

Verify by: closing an auction with bids against a local stack, observing four `email_outbox` rows
appear as a side effect of the sweep with no app code running, then running the drain and seeing
four `email_sends` rows and (on the smoke path, with a real key) a real message in the inbox.
Re-running the sweep adds zero outbox rows; re-running the drain sends zero further messages.

### Key Discoveries:

- `closed_at` is written exactly once and never moves (`test/integration/auction-close.int.ts:339-352`) — the exactly-once enqueue falls out of this for free.
- `auctions` already carries a denormalised `seller_id` specifically so this slice could find the seller after an artwork row is gone (`context/archive/2026-09-11-list-artwork-for-auction/plan.md`).
- The partial-index shape a drain query needs already has a precedent: `auctions_due_close_idx` (`20260912120000_add_auction_close.sql:36-38`).
- The "absence is the access control" posture is stated twice, for `close_due_auctions` (`:129-132`) and for `email_sends` (`20260912140000_add_email_sends.sql:64-67`) — a new table with no policies is the house style, not an omission to explain.
- `email_sends.actor_id` was made nullable *for this slice specifically*: _"it is the normal case for S-04, whose trigger is the per-minute pg_cron close with no session attached at all"_ (`20260912140000_add_email_sends.sql:28-31`).
- `record_email_send` is granted to `authenticated` only, and the migration states why `anon` must stay revoked: _"a signed-out caller could write ledger rows naming any recipient they liked."_
- `auth/confirm`'s matcher exclusion is the stated precedent for "this route does its own thing with credentials" — the only option that skips the proxy entirely.
- Trigger precedent for enqueue-on-write: `on_auth_user_created` (`20260909144939:47-49`) and `bids_set_updated_at` (`20260911190000:67`).

## What We're NOT Doing

- **FR-011** — the follow-up asking both parties whether the sale happened. Nice-to-have, and the PRD's named first cut.
- **The FR-005 preference and one-click unsubscribe.** S-05 owns both. Close outcomes are transactional and are never gated by them.
- **Any on-page disclosure of contact details.** The address travels in the message only; `closedOutcome` and the `profiles` grants are untouched.
- **A custom sending domain.** `onboarding@resend.dev` delivers only to the Resend account owner's address; every other recipient returns 403 → `not_permitted`. That is an env change on launch day, not code.
- **Enqueueing for auctions that closed before this ships.** They predate the feature and mailing their participants now would be wrong.
- **Templating, HTML mail, retries beyond a bounded attempt count, a queue library, `pgmq`, Edge Functions, a second runtime.**
- **Relisting limits** (PRD Open Question 4) — unlimited relisting stays the default.
- **Any change to `close_due_auctions`, `place_bid`, `cancel_auction`, the `bids` select policy, or the swipe deck.**

## Implementation Approach

Five moving parts, each the narrowest thing that works:

1. **`email_outbox`** — one row per recipient, carrying the resolved address and a rendered payload. RLS enabled, **no policies at all**, so it is invisible and unwritable from every Supabase client.
2. **An `after update` trigger on `auctions`**, firing only on the `closed_at` null → not-null transition. It resolves recipients and addresses inside a `security definer` function owned by `postgres`, reading `auth.users.email` directly.
3. **Two secret-gated definer functions** — `claim_pending_emails(p_secret)` hands out pending rows including addresses, `mark_email_sent(p_secret, …)` writes the outbox status and the `email_sends` ledger row. Both verify a shared secret internally and are the only grants `anon` has anywhere in this schema.
4. **A `pg_cron` job** calling `net.http_post` once a minute against a proxy-exempt route handler.
5. **The drain** — `src/lib/email/outbox.ts` claims, composes via pure template functions, calls `sendEmail`, marks back.

Two departures from F-02's recommendation, both deliberate:

**A trigger, not a rewrite of the close.** The research assumed the enqueue would ride inside
`close_due_auctions`' existing `update … from winners w` statement. An `after update … when (old.closed_at
is null and new.closed_at is not null)` trigger gets the same exactly-once guarantee from the same
proven property, without touching a function the integration lane already pins, and covers every
close path including a direct psql one. The project has two triggers already; this is the third.

**A set-based drain, not a per-row Database Webhook.** A webhook is a `for each row` trigger, so an
auction with four recipients becomes four POSTs, and a separate retry mechanism is still needed
because `pg_net` does not retry. One per-minute `pg_cron` → `net.http_post` serves first attempts and
retries with the same code, and is set-based like `close_due_auctions` itself.

## Critical Implementation Details

**The address source, and why it is not `profiles`.** Every address resolves from `auth.users.email`
inside the definer trigger function. `profiles.email` is populated by `handle_new_user` on insert and
never updated, so it can name an address the user has since abandoned — and the whole point of this
slice is that the address is correct enough for a stranger to complete a sale through. A definer
function owned by `postgres` with `set search_path = ''` reads `auth.users` by fully-qualified name.

**Who writes the ledger.** The drain runs as `anon` (no session), and `record_email_send` is granted
to `authenticated` only — for a stated reason that must not be undone. So `mark_email_sent` calls
`public.record_email_send(…)` internally, definer calling definer. `actor_id` lands null, which is
exactly the case `email_sends` documents as normal for this slice. The TS `recordSend` sidecar is
therefore **not** on this path; that is a documented deviation from AGENTS.md's "a caller with a
Supabase client sends, then calls `recordSend`", and the AGENTS.md amendment in Phase 2 must say so.

**At-least-once means a duplicate is possible.** A send that succeeds and whose `mark_email_sent`
write-back is then lost will be re-sent on the next tick. Bound it: an `attempts` counter and a
`max_attempts` ceiling, after which the row stays pending-but-exhausted and shows up in the operator
query rather than retrying forever.

**Ordering inside Phase 2.** Prove a single-attempt drain end to end *before* enabling the retry
job. A retry loop layered onto an unproven drain can mail the same person repeatedly, and the
project's only sender identity delivers solely to the developer's own inbox — so the first duplicate
lands on whoever is testing, which is the good case, but only by luck.

---

## Phase 1: The database half

### Overview

Everything that happens inside Postgres: the outbox, the trigger that fills it as a side effect of
the close, and the two secret-gated functions the drain will later call. No app code, no extension,
no mail. At the end of this phase a local close produces outbox rows and nothing consumes them.

### Changes Required:

#### 1. The outbox table

**File**: `supabase/migrations/20260913120000_add_email_outbox.sql` (new)

**Intent**: One row per intended message, carrying the resolved recipient address and everything the
message needs, so the drain never has to look anything up and never needs a credential that can read
addresses for its own sake.

**Contract**: `public.email_outbox` — `id uuid pk default gen_random_uuid()`, `auction_id uuid
references public.auctions (id) on delete cascade`, `recipient_email text not null`, `kind text not
null` with a check constraining it to the four variants (`auction_won`, `auction_sold`,
`auction_lost`, `auction_unsold`), `payload jsonb not null`, `status text not null default 'pending'`
check in (`pending`, `sent`, `failed`), `attempts integer not null default 0`, `last_error text`,
`sent_at timestamptz`, `created_at timestamptz not null default now()`.

RLS enabled with **no policies at all** — follow the header comment style of
`20260912140000_add_email_sends.sql:15-31`, naming the omission as the access control and saying what
it buys: the table holds plaintext email addresses, so a client-readable policy would be a
disclosure surface wider than the one FR-009 asks for.

A partial index on `(created_at) where status = 'pending'`, mirroring `auctions_due_close_idx`
(`20260912120000_add_auction_close.sql:36-38`) — pending rows stay near-empty while sent rows
accumulate forever, which is the same asymmetry that index's comment describes.

`payload` carries the artwork title, the amount in cents where one applies, and the counterparty
address where one applies. It is `jsonb` rather than columns because the four variants genuinely
differ in what they need; a comment should say that, since the project otherwise prefers columns.

#### 2. The enqueue trigger

**File**: same migration

**Intent**: Fill the outbox as a side effect of the close, exactly once per auction, resolving each
recipient's live address — without modifying `close_due_auctions`.

**Contract**: `public.enqueue_close_emails()` — `returns trigger`, `language plpgsql`, `security
definer`, `set search_path = ''`. Fires from:

```sql
create trigger auctions_enqueue_close_emails
  after update of closed_at on public.auctions
  for each row
  when (old.closed_at is null and new.closed_at is not null)
  execute function public.enqueue_close_emails();
```

The `when` clause is the exactly-once guarantee and rests on a proven property — `closed_at` never
moves (`test/integration/auction-close.int.ts:339-352`). Say so in the comment, and cite the test.

Recipient resolution, all inside the function:

- **`winning_bid_id is null`** → one `auction_unsold` row for the seller. No amount, no counterparty.
- **otherwise** → one `auction_sold` row for the seller, with `winning_amount_cents` and the winner's address as counterparty; one `auction_won` row for the winning bidder, with the amount and the seller's address; and one `auction_lost` row for every other `bids.bidder_id` on that auction, with **no amount and no counterparty**.

Addresses join `auth.users` by id, fully qualified. A null or empty `email` must skip that recipient
rather than insert a row the drain cannot use; a `coalesce`-and-insert would produce a permanently
failing row. The artwork title comes from `public.artworks` via `new.artwork_id`.

The loser set is `select bidder_id from public.bids where auction_id = new.id and id is distinct from
new.winning_bid_id` — by id, not by amount, because a tie at the winning amount is resolved by
`updated_at`/`id` in the close and the loser at that amount is still a loser.

Grant nothing. A trigger function needs no execute grant, and `revoke execute … from public, anon,
authenticated` mirrors `handle_new_user` (`20260909144939:45`).

**Deliberately no backfill.** Auctions already closed when this migration runs get no rows. State
that explicitly — `20260912120000_add_auction_close.sql:233-237` backfilled on purpose and said why,
so the opposite choice here needs the same treatment.

#### 3. The two secret-gated functions

**File**: same migration

**Intent**: Give the drain exactly two operations — take pending work, report what happened — and
make the shared secret the thing that authorises them, not a role.

**Contract**:

`public.claim_pending_emails(p_secret text, p_limit integer default 50)` — `returns setof` a row
shape of `(id, kind, recipient_email, payload)`. Verifies the secret, increments `attempts` on every
row it returns, and returns only rows where `status = 'pending' and attempts < <max>`. Ordered by
`created_at`, `limit p_limit`, `for update skip locked` so two overlapping drains cannot claim the
same row.

`public.mark_email_sent(p_secret text, p_id uuid, p_status text, p_reason text default null,
p_provider_id text default null)` — `returns void`. Verifies the secret; updates the outbox row's
`status`, `sent_at`, `last_error`; and calls `public.record_email_send(recipient_email, kind,
p_status, p_reason, p_provider_id)` so the ledger keeps its single writer. Reads `recipient_email`
and `kind` off the row rather than taking them as parameters — the caller should not be able to
attribute a send to a recipient the row does not name.

Secret verification is shared: a `public.verify_drain_secret(p_secret text) returns boolean`
helper, or an inlined comparison in both. Either way, compare against a value read from
`vault.decrypted_secrets` by a fixed name (`email_drain_secret`) — `supabase_vault` is already
installed, and this keeps the secret out of the migration, out of the repo, and out of the cron job
definition. A missing vault entry must make both functions **raise**, not silently authorise.

Both are `security definer`, `set search_path = ''`, and — this is the one place the project grants
`anon` anything — `grant execute … to anon`. Write the justification in full: the drain POST carries
no session, the secret argument is the access control, and a caller holding the publishable key but
not the secret gets an exception rather than a row. Remember the `revoke` from `public` first;
`config.toml` leaves `auto_expose_new_tables` at the cloud default, so a new function in `public` is
born granted to `anon`, `authenticated`, `service_role` and `public` — the grant must be restated
deliberately, not inherited.

#### 4. The integration spec

**File**: `test/integration/email-outbox.int.ts` (new)

**Intent**: Prove the enqueue is a real side effect of a real close, not a fixture, and that the
no-policy invisibility holds under actual RLS.

**Contract**: Models `test/integration/auction-close.int.ts` — `requireLocalRunningStack()` in
`beforeAll`, one set of users minted per file (`[auth.rate_limit] sign_in_sign_ups` is 30 per 5
minutes per IP), fixtures built through ordinary RLS-bound clients, and a `Pool` over
`requireLocalDatabaseUrl()` used **only** for what is deliberately ungranted. Assertions:

- A seller, a winner and two losing bidders bid; one `close_due_auctions(p_now)` call produces exactly four rows, one per recipient, with the right `kind` each.
- The `auction_lost` rows' `payload` contains **no** counterparty address and **no** amount. This is the §Access Control assertion; everything else is plumbing.
- A second `close_due_auctions` call adds **zero** rows and does not move `closed_at`.
- A no-bid close produces exactly one `auction_unsold` row and no others.
- A cancelled auction produces none (the sweep skips it, so the trigger never fires).
- An authenticated Supabase client selecting `email_outbox` gets zero rows; inserting, updating and deleting all fail.
- `claim_pending_emails` with a wrong secret raises; with the right one it returns rows and increments `attempts`.
- `mark_email_sent` with the right secret moves the row to `sent` **and** writes an `email_sends` row whose `actor_id` is null.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` all pass
- `npm run test:integration` passes, including the new `email-outbox.int.ts`
- `supabase db reset` applies the migration cleanly with no error
- Generated types include `email_outbox`, `claim_pending_emails` and `mark_email_sent` (the user runs `npm run db:types:local`)

#### Manual Verification:

- Closing an auction with bids on a local stack produces four outbox rows with correct addresses, read over psql — with no app process running at all
- The vault secret's absence makes `claim_pending_emails` raise rather than return rows
- An authenticated client in the browser (devtools) cannot see `email_outbox`

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before proceeding
to the next phase. The user runs the Supabase lifecycle and `db:types:local` commands themselves.

---

## Phase 2: The bridge, and mail that arrives

### Overview

Everything in Node, plus the hop that reaches it. `pg_net`, the drain cron, the proxy exemption, the
route handler, the four message templates, the claim→send→mark loop, the default-lane matrix, a real
email, and the `AGENTS.md` section. Build it in the order below: a single-attempt drain is proven
working before the retry ceiling is raised above one.

### Changes Required:

#### 1. The message templates

**File**: `src/lib/email/templates.ts` (new)

**Intent**: Turn an outbox row into a subject and a plain-text body, as four pure functions with no
I/O — so the whole of what each person is told is testable in the default lane and reviewable as
prose.

**Contract**: One exported function per `kind`, each taking a typed payload and returning `{ subject,
text }` (the shape `EmailMessage` needs minus `to`), plus a dispatcher that maps `kind` → function
and returns `null` for an unrecognised kind rather than throwing. Zod-parse the `payload` at this
boundary: it arrives as `jsonb` from the database and AGENTS.md requires external input validated
before use. Each variant's shape is its own schema — the `auction_lost` schema must **not** have a
counterparty field at all, so a payload that somehow carried one could not reach the body.

The four messages, and what each may contain:

| kind | may name | must never name |
| --- | --- | --- |
| `auction_won` | artwork title, winning amount, seller's email | any other bidder, the bid count |
| `auction_sold` | artwork title, winning amount, winner's email | any other bidder, the bid count, losing amounts |
| `auction_lost` | artwork title | the amount, the winner, the seller's email, the bid count |
| `auction_unsold` | artwork title, that it is free to relist | that nobody bid, in those words |

`auction_unsold`'s framing is a PRD decision, not a style preference: FR-010's Socrates note records
that _"'nobody bid on your work' is a discouraging message"_ and resolves it as _"a closing notice
with the artwork free to relist, not a failure report."_ Put that citation in the comment so nobody
later "improves" the copy back.

#### 2. The drain

**File**: `src/lib/email/outbox.ts` (new)

**Intent**: The loop — claim a batch, compose, send, mark — as one exported function taking a
Supabase client, so the route handler is thin and the loop is testable without HTTP.

**Contract**: `drainOutbox(supabase, { limit }): Promise<{ claimed, sent, failed }>`. Calls
`claim_pending_emails`, and for each row composes via the dispatcher, calls `sendEmail`, then calls
`mark_email_sent` with the `SendResult` mapped the way `recordSend` maps it (`status` from `result.ok`,
then `p_provider_id` **or** `p_reason`, never both). Never throws: a row that fails to compose is
marked `failed` with a reason rather than aborting the batch, and the summary is the return value.

Sends sequentially, not `Promise.all`. Resend's free tier is 10 requests/second and an auction with
many losing bidders is one batch; sequential also keeps the 8s-per-send budget in `send.ts`
interpretable against Vercel's function ceiling.

Reads the drain secret from `process.env` **inside** the function, never at module scope — the
`OPENROUTER_API_KEY` / `RESEND_API_KEY` discipline, for the same reason: `next build` imports every
module and CI has no secret.

#### 3. The route handler

**File**: `src/app/api/email/drain/route.ts` (new)

**Intent**: The one endpoint Postgres can reach. Authenticate the caller, run the drain, return a
count.

**Contract**: `POST` only. Verifies the inbound `Authorization: Bearer <secret>` header against
`process.env.EMAIL_DRAIN_SECRET` using `timingSafeEqual` from `node:crypto` (already established as
an acceptable import by `scripts/build-corpus.ts`), returning 401 on mismatch and 503 when the env
var is unset — unset must not mean "open". Zod-parses the body (an optional `limit`), per AGENTS.md.
Builds a sessionless Supabase client from the publishable key — not `createClient` from
`src/utils/supabase/server.ts`, which is cookie-aware and has no cookies to read here — and calls
`drainOutbox`.

Returns `{ claimed, sent, failed }` as JSON. The response body must not name a recipient or an
address: `net._http_response` stores responses in the database where they are readable by anyone who
can read that table.

The header check is belt-and-braces; the real gate is the secret argument inside the definer
functions, because the publishable key is public by design. Say that in a comment so the check is not
mistaken for the whole of the security.

#### 4. The proxy exemption

**File**: `src/proxy.ts`

**Intent**: Let the drain POST actually reach the handler.

**Contract**: Add `api/email/drain` to the matcher's negative lookahead, alongside `auth/confirm`.
This is the only option that skips the proxy entirely — no `getClaims()` round trip, no cookie
writing — and `auth/confirm`'s exclusion is the stated precedent for a route that does its own thing
with credentials. Extend the existing comment rather than adding a second one.

#### 5. `pg_net` and the drain schedule

**File**: `supabase/migrations/20260913120100_schedule_email_drain.sql` (new)

**Intent**: The hop. Once a minute, tell the app there may be mail to send.

**Contract**: `create extension if not exists pg_net;` with no guard — the house style, stated at
`20260912120100_schedule_auction_close.sql:19-25`: an environment missing it should fail loudly here
rather than quietly end up with no drain.

Then `cron.schedule('drain-email-outbox', '* * * * *', …)` whose command calls `net.http_post` with
the URL and the bearer token read from `vault.decrypted_secrets` — **not** inlined, which would
commit the secret and the production URL to the repo. Two vault entries: `email_drain_url` and
`email_drain_secret` (the latter shared with Phase 1's functions). Guard the command so a missing
vault entry skips the POST rather than erroring every minute in the cron log.

Separate migration from Phase 1's, for the reason `20260912120100` gives about its own split: the
schedule is operational rather than structural and may need re-registering on its own.

Note in the file that one minute here stacks on the close sweep's minute, so worst-case latency from
`ends_at` to an inbox is about two minutes — and that this is fine, because §Guardrails' timing
requirement is about *the auction closing* on time, which `place_bid` already enforces to the
instant, not about mail.

#### 6. Env and docs

**Files**: `.env.example`, `AGENTS.md`, `supabase/seed-assets/README.md` (the vault setup step)

**Intent**: Make the two operator steps — the vault entries and the Vercel env var — discoverable,
and write down the rules this slice establishes.

**Contract**: `.env.example` gains `EMAIL_DRAIN_SECRET` with the same framing the other server-only
keys get (deliberately not `NEXT_PUBLIC_`, read inside the function, and what degrades when it is
unset). `AGENTS.md`'s outbound-email section gains: close outcomes go through the outbox, never
directly from a Server Action; `email_outbox` has no policies and that is the access control; the
drain is the only caller of `claim_pending_emails` / `mark_email_sent`; and the documented deviation
— this path writes the ledger through `mark_email_sent` rather than the TS `recordSend`, because the
drain has no session and `record_email_send` must stay revoked from `anon`.

#### 7. Tests

**Files**: `test/lib/email-templates.test.ts`, `test/lib/email-outbox.test.ts`,
`test/actions/email-drain.test.ts` (or the route-handler equivalent under the existing `test/actions`
convention), `test/smoke/auction-close-email.live.ts`

**Intent**: Put each question in the lane that can answer it.

**Contract**:

- **Default lane** — the four templates against fixed payloads, including the negative assertions (an `auction_lost` body contains no `@` and no currency figure); the payload schemas rejecting a malformed `jsonb`; `drainOutbox` with `sendEmail` and the Supabase client mocked, covering a success, each `SendFailure` variant mapping to the right `mark_email_sent` argument, and a compose failure marking one row failed without aborting the batch; the route handler rejecting a wrong secret, a missing secret (503), and a non-POST method. `vi.mock` factories are hoisted — share fixtures through `vi.hoisted`.
- **Integration lane** — already covered in Phase 1. Nothing here.
- **Smoke lane** — one real close-outcome email, sent to `SMOKE_EMAIL_TO`, composed by the real templates and sent by the real `sendEmail`. Mirrors `test/smoke/email.live.ts`.

The `pg_net` hop itself is proven by hand, once: `pg_net` is fire-and-forget (it returns a
`request_id`; the response lands later in `net._http_response`), so no lane can assert on it without
a listener. Say that in the plan's record and in the manual criteria rather than pretending otherwise.

### Success Criteria:

#### Automated Verification:

- `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` all pass
- `npm run test:integration` still passes (Phase 1's spec is unaffected by the Node half)
- `npm run test:smoke` sends a real close-outcome email and it arrives
- With `EMAIL_DRAIN_SECRET` unset, `npm run build` passes — proving nothing reads it at module scope
- `supabase db reset` applies both migrations and registers exactly two cron jobs

#### Manual Verification:

- A local auction closes and, within ~2 minutes and with no manual step, four emails are attempted — confirmed by four new `email_sends` rows
- `select * from net._http_response order by created desc limit 5` shows the drain POST returning 200
- A POST to the drain route with a wrong bearer token returns 401; with the right one on an empty outbox it returns zeroes
- `select * from email_outbox where status = 'pending' and created_at < now() - interval '15 minutes'` — the operator's "did a message fail" query — returns nothing after a healthy run
- The retry ceiling is raised above one attempt only after a single-attempt drain has been observed working end to end
- A real `auction_won` email in the inbox names the seller's address; a real `auction_lost` email names no address and no amount

**Implementation Note**: After completing this phase and all automated verification passes, pause for
manual confirmation. The user runs the Supabase lifecycle commands and the vault setup themselves.

---

## Testing Strategy

### Unit Tests:

- The four templates, asserted on what they contain **and** on what they must not (no `@`, no currency figure in `auction_lost`)
- Payload schema rejection for each variant
- `drainOutbox`: success, every `SendFailure` variant, a compose failure mid-batch, an empty claim
- Route handler: wrong secret → 401, unset secret → 503, wrong method, malformed body

### Integration Tests:

- Four outbox rows as a side effect of one real `close_due_auctions` call; the right `kind` per recipient
- `auction_lost` payload carries no counterparty and no amount
- Second sweep: zero new rows, `closed_at` unmoved
- No-bid close → one `auction_unsold` row; cancelled auction → none
- `email_outbox` invisible and unwritable to an authenticated client
- `claim_pending_emails` / `mark_email_sent` refuse a wrong secret; `mark_email_sent` writes an `email_sends` row with null `actor_id`

### Manual Testing Steps:

1. Set the two vault entries and `EMAIL_DRAIN_SECRET`, then close an auction with two bidders locally and watch four `email_sends` rows appear without touching anything.
2. Read `net._http_response` to confirm the hop returned 200.
3. POST the drain route with a wrong token and confirm 401.
4. Read the real `auction_won` and `auction_lost` messages in the inbox and confirm the disclosure boundary by eye — this is the §Access Control check no test can fully make.
5. Unset the vault secret and confirm the drain stops cleanly (functions raise, cron logs the failure) rather than sending unauthenticated.

## Performance Considerations

`claim_pending_emails` is bounded by `p_limit` (50) and ordered by the partial index, so the drain's
work per tick is bounded regardless of backlog. Sends are sequential against Resend's 10/second free
tier, so a 50-row batch is ~50 round trips — comfortably inside a function invocation at sub-second
sends, but it is the number to revisit if a single auction ever has hundreds of bidders. The `for
update skip locked` claim means two overlapping drains degrade into two smaller batches rather than
duplicate sends.

## Migration Notes

Two additive migrations, no data migration. Auctions that closed before the trigger exists get no
outbox rows by design, so the deploy cannot emit a burst of mail about old auctions — the opposite
of S-03's deliberate backfill, and for the opposite reason.

Rollback is `drop trigger` (stops enqueue; the drain then finds nothing) and
`cron.unschedule('drain-email-outbox')` (stops the hop; rows accumulate harmlessly as pending). The
two are independent, so either half can be disabled without the other. Never edit an already-applied
migration — add a new one.

Two operator steps that are not code and will not fail loudly: the vault entries
(`email_drain_secret`, `email_drain_url`) on each environment, and `EMAIL_DRAIN_SECRET` in Vercel.
Without them the drain is inert and the only symptom is outbox rows staying pending — which is what
the operator query in the manual criteria exists to catch.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-04
- PRD: `context/foundation/prd-v3.md` — FR-009, FR-010, §Access Control, §Guardrails
- The bridge research this plan inherits: `context/archive/2026-09-12-outbound-email-foundation/research.md` §3 and the platform-native follow-up
- The send path and ledger: `src/lib/email/send.ts`, `src/lib/email/record.ts`, `supabase/migrations/20260912140000_add_email_sends.sql`
- The close and its exactly-once property: `supabase/migrations/20260912120000_add_auction_close.sql`, `test/integration/auction-close.int.ts:339-352`
- "Absence is the access control" precedent: `20260912120000_add_auction_close.sql:129-132`
- Lesson that governs the drain's placement: `context/foundation/lessons.md` — never block a user-visible mutation on a third-party call

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The database half

#### Automated

- [x] 1.1 `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` all pass — 0bfb824
- [x] 1.2 `npm run test:integration` passes, including the new `email-outbox.int.ts` — 0bfb824
- [x] 1.3 `supabase db reset` applies the migration cleanly with no error — 0bfb824
- [x] 1.4 Generated types include `email_outbox`, `claim_pending_emails` and `mark_email_sent` — 0bfb824

#### Manual

- [x] 1.5 Closing an auction with bids locally produces four outbox rows with correct addresses, with no app process running — 0bfb824
- [x] 1.6 The vault secret's absence makes `claim_pending_emails` raise rather than return rows — 0bfb824
- [x] 1.7 An authenticated client cannot see `email_outbox` — 0bfb824

### Phase 2: The bridge, and mail that arrives

#### Automated

- [x] 2.1 `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build` all pass — 55965d9
- [x] 2.2 `npm run test:integration` still passes — 55965d9 (against migrations through `20260913120100` only; see 2.12)
- [x] 2.3 `npm run test:smoke` sends a real close-outcome email and it arrives — 55965d9
- [x] 2.4 With `EMAIL_DRAIN_SECRET` unset, `npm run build` passes — 55965d9
- [x] 2.5 `supabase db reset` applies all five of this change's migrations and registers exactly two cron jobs — observed 2026-09-12 after the impl review: `schema_migrations` tops out at `20260913120500`, `claim_pending_emails` carries `attempts < 3`, `mark_email_sent` knows `deferred`, the pending index carries the narrowed predicate, and `cron.job` holds exactly `close-due-auctions` and `drain-email-outbox`
- [x] 2.12 `npm run test:integration` passes against the full migration set — 93 passed, `email-outbox.int.ts` at 19 including the rewritten ceiling spec and the three added for `20260913120400` (deferred, unknown status, replay guard)

#### Manual

- [ ] 2.6 A local auction closes and four emails are attempted within ~2 minutes with no manual step — reopened by the impl review: observed against the pre-split wiring, where the cron job presented `email_drain_secret` and the route checked `EMAIL_DRAIN_SECRET`. `20260913120300` moved the header onto `email_drain_trigger_token` / `EMAIL_DRAIN_TRIGGER_TOKEN`, so the shipped path has not delivered a message yet
- [ ] 2.7 `net._http_response` shows the drain POST returning 200 — reopened by the impl review: observed against the pre-split wiring, where the cron job presented `email_drain_secret` and the route checked `EMAIL_DRAIN_SECRET`. `20260913120300` moved the header onto `email_drain_trigger_token` / `EMAIL_DRAIN_TRIGGER_TOKEN`, so the shipped path has not delivered a message yet
- [ ] 2.8 Wrong bearer token returns 401; right token on an empty outbox returns zeroes — reopened by the impl review: observed against the pre-split wiring, where the cron job presented `email_drain_secret` and the route checked `EMAIL_DRAIN_SECRET`. `20260913120300` moved the header onto `email_drain_trigger_token` / `EMAIL_DRAIN_TRIGGER_TOKEN`, so the shipped path has not delivered a message yet
- [x] 2.9 The pending-rows operator query returns nothing after a healthy run — 55965d9
- [x] 2.10 The retry ceiling is raised above one attempt only after a single-attempt drain is proven — 55965d9
- [x] 2.11 A real `auction_won` email names the seller's address; a real `auction_lost` email names no address and no amount — 55965d9
