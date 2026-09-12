# Timed Auction Close Implementation Plan

## Overview

Roadmap slice S-03. An auction stops at its stated `ends_at` without anyone intervening, the
highest sealed bid standing at that moment becomes the winner (earliest bid wins a tie), and
the outcome is recorded once, durably, on the auction row.

This is the first time-triggered behaviour the product has ever had. The trigger is a
per-minute `pg_cron` job inside the database, not a platform cron, because Vercel's Hobby plan
caps cron at once per day firing anywhere inside its hour — which cannot satisfy §Guardrails'
"closes close enough to its stated end time that a collector watching the clock is not misled".

## Current State Analysis

**Closing is already half-done, by construction.** `supabase/migrations/20260911120000_add_auctions.sql:1-6`
states the design deliberately: state is derived from timestamps, not stored in a status
column, so "nothing flips a flag, so nothing can be wrong, and no scheduler is needed to make
an expired auction stop being open -- that is S-03's territory". An expired auction already
stops being open on every surface:

- `place_bid` refuses it under a row lock (`ends_at > now()`, `supabase/migrations/20260911190000_add_bids.sql:105-115`)
- `cancel_auction` refuses it (`20260911190000_add_bids.sql:167-176`)
- `getOpenAuctions` / `getOpenAuctionsPage` / `getLiveAuctionsByArtwork` exclude it (`src/lib/auctions/queries.ts:96-98`, `131-133`, `237-239`)
- `isOpen` / `canBid` mirror the same predicate in TypeScript (`src/lib/auctions/status.ts:16-42`)
- the detail page already renders a distinct ended-vs-cancelled message (`src/app/(app)/auctions/[id]/page.tsx:85-90`)

**What is missing is not "stop accepting bids" — it is an outcome.** Nothing computes a
winner, nothing records one, and S-04 (contact exchange) has no exactly-once event to trigger
on.

**The tie-break comparator is already chosen and load-bearing.** `20260911190000_add_bids.sql:62-69`
calls the `bids_set_updated_at` trigger "load-bearing, not bookkeeping" — `updated_at` records
the moment the current amount became that bidder's standing bid, and is FR-008's earliest-wins
comparator. That is why the raise path is an upsert rather than a delete-and-insert, and it
means a collector who raises correctly forfeits their earlier queue position.

**The sealed guardrail is a single RLS policy, and the seller is deliberately excluded from it.**
`20260911190000_add_bids.sql:11-21`: "The seller is deliberately *not* granted a read … S-03's
close will run security definer and bypass RLS, so withholding the read here blocks no later
slice." The close was anticipated; the policy does not need to change.

**Nothing schedules anything today.** No `vercel.json` / `vercel.ts`, no `pg_cron`, no route
handler cron, nothing in `supabase/config.toml`. `context/foundation/infrastructure.md:13-25`
records Vercel Hobby at $0 for non-commercial coursework.

**The integration lane cannot currently construct an expired auction.** `src/lib/auctions/status.ts:6-11`
already names the reason: "the integration lane runs under real RLS with no service-role key,
so it cannot fabricate a row whose `ends_at` has already passed". `create_auction` accepts only
24/72/168 hours, so nothing in that lane ends soon either.

## Desired End State

An auction that reaches `ends_at` is stamped closed within roughly a minute, with the highest
sealed bid recorded as its winner and that bid's amount denormalised onto the auction row. A
collector watching the countdown sees it hit zero and the page updates itself to show the
outcome. The winner is told they won and at what amount; the seller is told what it sold for;
other bidders are told they did not win, and nothing more. Anyone can reach a closed auction
they participated in from `/auctions`.

Verified by: `npm run test:integration` proving winner selection, tie-break, no-bid close,
idempotency and the post-close bid refusal against a real local stack; and a manual walkthrough
of an auction closing under the registered cron job.

### Key Discoveries:

- Vercel Hobby cron is limited to once per day and fires anywhere inside its hour — disqualifying for this guardrail ([Vercel: Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)). Supabase `pg_cron` supports minute and even 1–59 second schedules on the free tier ([Supabase Cron](https://supabase.com/docs/guides/cron)).
- `supabase status -o env` emits `DB_URL` alongside the two keys `test/integration/setup.ts:16-20` renames, so `.env.test.local` **already contains** a local postgres connection string. The close test needs an accessor and a `pg` devDependency, not a new env workflow. **Verify this before building on it** — regenerate the file if `DB_URL` is absent.
- The openness predicate lives in exactly three places the code already says must be changed together (`src/lib/auctions/status.ts:12-14`, `src/lib/auctions/queries.ts:86-90`, and the two SQL functions). `closed_at` joins all of them.
- `getOwnBid` (`src/lib/auctions/queries.ts:180-191`) is read only when the auction is biddable (`src/app/(app)/auctions/[id]/page.tsx:52`). Comparing its `id` to `winning_bid_id` tells a collector they won while disclosing nothing about anyone else.
- `AuctionCard`'s standing rule (`src/components/auctions/AuctionCard.tsx:13-21`): the card may say *that* you bid, never how much — `hasBid` is a boolean "for exactly that reason; do not give it a number". The closed state must not relax this for non-participants.
- Migrations auto-deploy on push to `main` via `.github/workflows/migrations.yml`, running `supabase db push` as the project's `postgres` role — which can create extensions and call `cron.schedule`.

## What We're NOT Doing

- **No notifications of any kind.** Telling the winner by email, telling losers, telling the seller — all S-04 and S-05, both of which need F-02's outbound path, which does not exist. This slice only makes the outcome *visible in the app* to people who go and look.
- **No contact exchange.** §Access Control's "one new disclosure" — who the counterparty is — belongs to S-04. Nothing here reveals a bidder's identity to the seller, or the seller's details to the winner beyond what the artist page already shows.
- **No bid count, ever, to anyone.** Not before close, not after. §Guardrails withholds it and the previous slice denied the seller a read on `bids` on purpose.
- **No losing amounts disclosed.** A losing bidder sees that they lost; they do not see the winning amount. Only the seller and the winner see it.
- **No change to the `bids` select policy.** It stays a flat `bidder_id = auth.uid()`.
- **No relisting rules.** FR-010's "free to relist" already works — `create_auction`'s liveness check is `ends_at > now()`, so an ended auction permits a new listing with no change. Bounds on repeated relisting are PRD Open Question 4, owned by the user.
- **No pagination on the closed section.** A bounded recent window, not a full auction history.
- **No Vercel plan change.** The pg_cron choice exists precisely so none is needed.

## Implementation Approach

Three phases, mirroring the shape `sealed-bidding` used: the database first, a real-boundary
proof second, the surface last.

The close is **one SQL function**, `close_due_auctions(p_now)`, which selects due auctions
under `for update skip locked`, picks each one's winner with a lateral join, and stamps the
outcome in a single `update`. It is idempotent by its own `where` clause: `closed_at is null`
means a second sweep over the same auction changes nothing, the same conditional-update shape
`cancel_auction` already uses.

`p_now` exists only to make the close testable — the seam `isOpen`/`canBid` already use in
TypeScript for exactly this reason. It governs **due-ness only**, never the recorded timestamp:
`closed_at` is always the real `now()`. Because a future `p_now` in an attacker's hands would
close live auctions early, the function is granted to nobody: `revoke execute … from public,
anon, authenticated`. Only the `pg_cron` job (running as `postgres`) and the integration lane's
direct postgres connection can call it.

The outcome is materialised on `auctions` rather than derived. This is a deliberate exception
to that table's stated derive-everything stance, for two reasons: S-04 needs a durable,
exactly-once event, and the winning amount must reach the seller, who cannot read `bids` at all.
Denormalising the amount is the same move `auctions.seller_id` already makes — freezing a value
at the moment it becomes meaningful so a later change cannot silently rewrite history.

## Critical Implementation Details

**Locking and ordering.** The sweep must take the same `for update` lock on the auction row
that `place_bid` does (`20260911190000_add_bids.sql:105-111`), or a bid can land between the
close's due-ness read and its winner selection and be silently dropped from the result.
`skip locked` is the correct variant: a contended auction is skipped and closes on the next
tick, and it is past `ends_at` anyway so the bid in flight will be refused by `place_bid`'s own
check. A plain `for update` would instead hold locks across the whole sweep transaction and
block bids on every other auction in the batch.

**Determinism of the tie-break.** `order by amount_cents desc, updated_at asc` is FR-008, but
`updated_at` is only microsecond-resolution transaction time. Append `id asc` as a final
comparator so the winner is deterministic even in the pathological case, and so the same
fixture yields the same winner on every test run.

**Timing tolerance.** The one-minute lag is cosmetic, never a late bid: `place_bid` already
refuses at the exact instant `ends_at` passes, under a row lock, independently of whether the
sweep has run. The countdown reaching zero and the outcome appearing are what need to line up,
which is what Phase 3's refresh is for.

## Phase 1: The close, in the database

### Overview

Add the outcome columns, the close function, the openness-predicate updates, the backfill, and
the scheduled job. After this phase an auction closes itself correctly; nothing in the UI shows
it yet.

### Changes Required:

#### 1. Outcome columns and the close function

**File**: `supabase/migrations/20260912120000_add_auction_close.sql` (new)

**Intent**: Give an auction somewhere to record that it closed and who won, and add the one
function that does it. Backfill any auction already past `ends_at` so no row is left in a state
the new code does not expect.

**Contract**:

- `auctions` gains three nullable columns: `closed_at timestamptz`, `winning_bid_id uuid references public.bids (id) on delete set null`, `winning_amount_cents bigint`. A partial index on `(ends_at) where closed_at is null and cancelled_at is null` serves the sweep's due-ness scan.
- `close_due_auctions(p_now timestamptz default now()) returns integer` — `language plpgsql`, `volatile`, `security definer`, `set search_path = ''`. Returns the number of auctions closed. Granted to nobody: `revoke execute on function public.close_due_auctions(timestamptz) from public, anon, authenticated;` and **no** `grant` follows. Document that omission in the migration — it is the whole reason `p_now` is safe to expose.
- A comment on `winning_amount_cents` stating that the `bids` row remains the source of truth and this column is the published result, frozen at close, readable by the seller who cannot read `bids`.

The function body is the non-obvious part — the lock variant and the lateral join both matter,
and `closed_at` is deliberately `now()` rather than `p_now`:

```sql
with due as (
  select a.id
    from public.auctions a
   where a.closed_at is null
     and a.cancelled_at is null
     and a.ends_at <= p_now
   order by a.ends_at
     for update skip locked
),
winners as (
  select d.id as auction_id, b.id as bid_id, b.amount_cents
    from due d
    left join lateral (
      select b.id, b.amount_cents
        from public.bids b
       where b.auction_id = d.id
       order by b.amount_cents desc, b.updated_at asc, b.id asc
       limit 1
    ) b on true
)
update public.auctions a
   set closed_at = now(),
       winning_bid_id = w.bid_id,
       winning_amount_cents = w.amount_cents
  from winners w
 where a.id = w.auction_id;
```

#### 2. Closed is authoritative, not inferred

**File**: `supabase/migrations/20260912120000_add_auction_close.sql` (same migration)

**Intent**: Make "closed means no more bids, and no cancellation" true by construction rather
than a consequence of two timestamps happening to agree. Without this, anything that closes an
auction whose `ends_at` is still future — `p_now` in a test, a future operational need — leaves
`place_bid` willing to accept bids on a closed auction.

**Contract**: `create or replace` both `place_bid(uuid, bigint)` and `cancel_auction(uuid)` with
unchanged signatures, adding `and closed_at is null` to each one's openness predicate. Signatures
unchanged means `create or replace` keeps the existing grants and they are not restated — the
same note `20260911190000_add_bids.sql:152-156` makes. `place_bid`'s addition goes inside the
`for update` locking select, so the check and the write stay one decision.

#### 3. Backfill

**File**: `supabase/migrations/20260912120000_add_auction_close.sql` (same migration, last statement)

**Intent**: Close every auction already past its end time, so the deploy leaves no row in a state
the new UI branches were not written for — and so the close path is exercised against real data
the moment it ships.

**Contract**: One `perform public.close_due_auctions();` in a `do $$ … $$` block. Volume is tiny
today, which is the argument for doing it in one transaction now rather than leaving it to the
first sweep.

#### 4. The schedule

**File**: `supabase/migrations/20260912120100_schedule_auction_close.sql` (new)

**Intent**: Register the per-minute sweep, in version control, so `supabase db reset` and the
deploy workflow both produce a working scheduler. Separate from the schema migration
deliberately: the schedule is operational, may need re-registering independently, and if
`pg_cron` is unavailable somewhere the failure points at the right file.

**Contract**: `create extension if not exists pg_cron;` followed by a `cron.schedule` call with a
fixed job name (`close-due-auctions`) on `* * * * *` running `select public.close_due_auctions();`.
Scheduling the same job name again replaces it, so the migration is re-runnable. Add a comment
recording that a per-minute schedule is the §Guardrails tolerance decision, and that Vercel Hobby
cron was ruled out (daily, hour-wide window) — otherwise the next reader will "simplify" this into
a `vercel.ts` cron entry.

No guard around the extension: an environment without `pg_cron` should fail loudly here rather
than silently end up with no scheduler, which is the exact "countdown reaches zero, nothing
happens" failure this slice exists to prevent.

#### 5. Regenerated types

**File**: `src/types/database.ts` (generated — never hand-edited)

**Intent**: Pick up the three new columns and the new function signature so `Auction` in
`src/types/domain.ts` carries them.

**Contract**: Ask the user to run `npm run db:types:local` after `supabase db reset` — it is the
only source for a new column's types pre-merge. Do not hand-edit, and do not run the
Supabase lifecycle commands; hand them over as copy-paste:

```bash
npx supabase db reset
npm run db:types:local
```

#### 6. The TypeScript mirror of the predicate

**File**: `src/lib/auctions/status.ts`, `src/lib/auctions/queries.ts`

**Intent**: Keep the three statements of "open" in agreement, as the comments in both files
already instruct.

**Contract**: `isOpen`'s parameter widens to `Pick<Auction, "cancelled_at" | "ends_at" | "closed_at">`
and gains `auction.closed_at === null`. `getOpenAuctions`, `getOpenAuctionsPage` and
`getLiveAuctionsByArtwork` each gain `.is("closed_at", null)`. `canBid` needs no change beyond
inheriting the wider `Pick`. Update the cross-referencing comments in both files to name
`closed_at` as part of the pairing.

### Success Criteria:

#### Automated Verification:

- Migrations apply cleanly from scratch: `npx supabase db reset` (user-run)
- Types regenerate with the three new columns: `npm run db:types:local` (user-run)
- Type checking passes: `npm run typecheck`
- Existing default suite still passes: `npm run test`
- Linting and formatting pass: `npm run lint` · `npm run format:check`
- Build passes: `npm run build`

#### Manual Verification:

- `select * from cron.job where jobname = 'close-due-auctions'` returns one row after a reset
- A hand-inserted auction with `ends_at` in the past is closed within ~60s of a reset, with the correct `winning_bid_id` and `winning_amount_cents`
- `select public.close_due_auctions()` called as `authenticated` is refused (permission denied)

**Implementation Note**: After completing this phase and all automated verification passes,
pause here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase. Phase blocks use plain bullets — the corresponding `- [ ]`
checkboxes live in the `## Progress` section at the bottom of the plan.

---

## Phase 2: Real-boundary proof

### Overview

Prove the close against a real local stack under real RLS. The default suite cannot answer any
of this — winner selection, tie-break, idempotency and the sealed boundary are all properties of
the database.

### Changes Required:

#### 1. A direct-postgres seam for the lane

**File**: `test/integration/setup.ts`, `package.json`

**Intent**: `close_due_auctions` is granted to nobody, so no Supabase client can reach it. The
lane needs a direct postgres connection — which its env file already carries.

**Contract**: Add `pg` and `@types/pg` as devDependencies. Export `requireLocalDatabaseUrl()`
from `setup.ts`, reading `DB_URL` and applying the **same loopback hostname guard**
`requireLocalStack` applies — this connection is far more powerful than an anon client, so it
gets the stronger check, not a weaker one. Throw with the same `SETUP_COMMANDS` instruction when
absent.

**First**: confirm `DB_URL` is actually in `.env.test.local`. If `supabase status -o env` does not
emit it under that name, the accessor and the documented regeneration command in `AGENTS.md`
change together. Do not build the phase on the assumption.

#### 2. The close specification

**File**: `test/integration/auction-close.int.ts` (new)

**Intent**: Pin every property of the close that only a real database can answer.

**Contract**: One test user set per file (`[auth.rate_limit] sign_in_sign_ups` is 30 per 5
minutes per IP). Auctions are created normally through `create_auction`, so their `ends_at` is
hours away; the close is driven by calling `close_due_auctions(p_now)` over the direct
connection with `p_now` set past those `ends_at`. Cases:

- **Highest wins** — three bidders at different amounts; `winning_bid_id` is the top bid's, `winning_amount_cents` matches.
- **Earliest wins a tie** — two bidders at the same amount, placed in sequence; the earlier `updated_at` wins. Then a third case where the earlier bidder *raises to the same amount later* — confirming the upsert moves them behind, which is the behaviour `bids_set_updated_at` exists to produce.
- **No bids** — `closed_at` set, both winner columns null.
- **Idempotent** — a second call over the same auctions returns 0 and changes no column, including `closed_at`.
- **Cancelled auctions are untouched** — a cancelled auction past `ends_at` keeps `closed_at` null.
- **Bids refused after close** — `place_bid` through the ordinary authenticated client returns `BID01` on a closed auction whose `ends_at` is still in the future. This is the case that only exists because of the `p_now` seam, and the reason Phase 1 added `closed_at is null` to `place_bid`.
- **Cancellation refused after close** — `cancel_auction` returns `false` on the same auction.
- **Sealed holds after close** — the seller, through their own authenticated client, still reads zero rows from `bids` on the closed auction, while reading `winning_amount_cents` from `auctions` successfully. This is the single assertion that proves the denormalisation did not leak the policy open.
- **A loser learns nothing** — a losing bidder reads only their own bid row, and the auction row's `winning_bid_id` is not theirs.

Follow `test/integration/bids.int.ts` for fixture and teardown shape.

### Success Criteria:

#### Automated Verification:

- The new spec passes: `npm run test:integration` (user-run, local stack)
- The rest of the lane still passes in the same run — no regression from the `place_bid` / `cancel_auction` changes
- Type checking passes with the new devDependencies: `npm run typecheck`
- Linting and formatting pass: `npm run lint` · `npm run format:check`
- Default suite and build unaffected: `npm run test` · `npm run build`

#### Manual Verification:

- Each close assertion was observed failing before the Phase 1 function made it pass, or — where Phase 1 already shipped — was confirmed to fail when its specific guard is temporarily removed. Per `context/foundation/lessons.md`, a red/green test must be observed red.
- The lane still refuses to run against a non-loopback `DB_URL` (temporarily point it elsewhere and confirm the throw)

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: The outcome surfaces

### Overview

Make the close observable: the result on the detail page, a closed state on the card, a
countdown that does something when it reaches zero, and a way to find a closed auction at all.

### Changes Required:

#### 1. Reading closed auctions the viewer took part in

**File**: `src/lib/auctions/queries.ts`

**Intent**: A closed auction is currently reachable only by URL. Give `/auctions` a bounded
recent-participation query.

**Contract**: Add `getMyClosedAuctions(viewerId)` returning `AuctionWithArtwork[]`, plus
`CLOSED_AUCTIONS_WINDOW_DAYS = 30` and `CLOSED_AUCTIONS_LIMIT = 12`. Two queries, never per row:
first the viewer's own bid `auction_id`s (RLS already scopes this read — no `bidder_id` filter,
for the reason `getOwnBid` states at `src/lib/auctions/queries.ts:170-179`), then auctions where
`closed_at` is non-null, within the window, and `seller_id.eq.<viewer>` **or** `id.in.(<bid ids>)`,
ordered by `closed_at` descending. Then `attachArtworks`. The participation filter here is for
correctness and relevance, not access control — `auctions` has a blanket select policy and holds
no bid data.

#### 2. The outcome, to participants only

**File**: `src/app/(app)/auctions/[id]/page.tsx`

**Intent**: Show the result of a closed auction to the people it concerns, and nothing to anyone
else.

**Contract**: `getOwnBid` moves out from behind the `biddable` guard — it is now needed whenever
the viewer is not the seller, open or closed. The existing three-way control block gains a
closed branch before the ended/cancelled message, with four mutually exclusive outcomes:

- seller, winner present → sold, with `winning_amount_cents`
- seller, no winner → ended with no bids, free to relist
- own bid id equals `winning_bid_id` → you won, with the amount
- own bid present, not the winner → you did not win (**no amount**)
- neither → the existing "This auction has ended."

Cancelled stays its own message, unchanged — the two terminal states are disjoint by design.
Keep the existing comment's spirit: state in the block why no branch shows a bid that is not the
viewer's own.

#### 3. Closed state on the card

**File**: `src/components/auctions/AuctionCard.tsx`

**Intent**: Let the browse grid draw a closed auction without relaxing the card's standing rule.

**Contract**: The countdown is replaced by a "Closed" label when `closed_at` is set. The card
shows **no amount and no outcome** — the existing `hasBid` badge is the only participation signal,
and finding out whether you won requires opening the auction. Extend the component's doc comment
to say so, so the next reader does not add a "You won" badge here.

#### 4. Countdown reaches zero

**File**: `src/components/auctions/AuctionCountdown.tsx`

**Intent**: §Guardrails names "a countdown that reaches zero with nothing happening" as a
failure shape. The page is already `force-dynamic`, so a refresh re-reads real state.

**Contract**: When the tick reaches zero, call `router.refresh()` **once**, after a short delay
long enough to let the sweep land (the schedule is per-minute, so the delay must cover the worst
case — around 60s — or the refresh shows "ended" with no outcome, which is the failure in
miniature). Fire only if the component was mounted while the auction was still open: a page
loaded on an already-ended auction must not refresh on mount. Clear the timer on unmount.

Add `"use client"` is already present; the component gains `useRouter` from `next/navigation`.

#### 5. Recently closed on the browse page

**File**: `src/app/(app)/auctions/page.tsx`

**Intent**: A path to the outcome, since S-04's notification does not exist yet.

**Contract**: Below the open grid and its pagination, a "Recently closed" section rendering
`getMyClosedAuctions` through the same `AuctionCard`. Omitted entirely when empty. Not
paginated — it is a bounded recent window, not a history.

#### 6. Unit coverage for the widened predicate

**File**: `test/lib/` (alongside the existing status tests)

**Intent**: The default suite's smoke layer should cover the predicate change and the winner
comparison, both of which are pure.

**Contract**: `isOpen` returns false for a closed auction whose `ends_at` is still in the future
and whose `cancelled_at` is null — the case that distinguishes the new column from the old two.
`canBid` inherits it.

### Success Criteria:

#### Automated Verification:

- Default suite passes, including the new predicate cases: `npm run test`
- Type checking passes: `npm run typecheck`
- Linting and formatting pass: `npm run lint` · `npm run format:check`
- Build passes: `npm run build`
- Integration lane still green: `npm run test:integration` (user-run)

#### Manual Verification:

- As the seller, a closed auction with bids shows the winning amount; with no bids it shows the relist message
- As the winning collector, the auction says you won and shows your amount
- As a losing collector, the auction says you did not win and shows **no amount anywhere** — confirmed by reading the rendered HTML, not just the visible text
- As a signed-in user who neither sold nor bid, the closed auction shows only that it ended
- A countdown watched through zero updates itself to the outcome without a manual reload
- "Recently closed" lists auctions you bid on and auctions you sold, and nothing else
- `/auctions` open grid no longer contains the auction once it closes

**Implementation Note**: This is the final phase. Confirm manual verification before closing out
the change.

---

## Testing Strategy

### Unit Tests (default suite, `npm run test`):

- `isOpen` / `canBid` with `closed_at` set and `ends_at` still in the future
- Existing auction and bid action tests continue to pass unchanged

### Integration Tests (`npm run test:integration`, local only):

The whole of Phase 2. These are the tests that matter for this slice — winner selection,
tie-break, idempotency, the post-close refusals, and the sealed-after-close assertion are all
properties of the database that mocking cannot answer.

### Manual Testing Steps:

1. Reset the local stack, confirm `cron.job` holds `close-due-auctions`.
2. Create an auction as an artist, bid on it as two collectors at different amounts.
3. Move the auction's `ends_at` into the past directly in psql (this is a manual step, not a test fixture — the lane uses `p_now` instead).
4. Wait a minute; confirm `closed_at`, `winning_bid_id` and `winning_amount_cents` are set correctly.
5. Load the detail page as each of: seller, winner, loser, uninvolved user. Confirm each sees only what §Guardrails permits.
6. Load `/auctions` as the winner; confirm the auction appears under "Recently closed" and not in the open grid.
7. Create a fresh auction, open the detail page, move `ends_at` to ~30s ahead, and watch the countdown cross zero without touching the page.

## Performance Considerations

The sweep runs every minute forever and mostly finds nothing. The partial index on
`(ends_at) where closed_at is null and cancelled_at is null` keeps the due-ness scan to an index
range regardless of how many auctions have accumulated, and `skip locked` means it never blocks
a bid. pg_cron's documented ceiling is 32 concurrent jobs; this is one, running in well under a
second.

`getMyClosedAuctions`' first query — the viewer's bid `auction_id`s — is unbounded in principle,
the same shape `getOpenAuctions` carries and that `getArtistArtworksPage` already hit a "URI too
long" wall with. It is bounded in practice by how many auctions one collector bids on, and the
30-day window bounds the second query. If it ever grows, the fix is a security-definer function
that does the participation join in SQL — noted here so the next person does not have to
rediscover it.

## Migration Notes

Two migrations, applying in timestamp order. `20260912120000_add_auction_close.sql` is
self-contained and reversible in the sense that matters — dropping three nullable columns and
one function restores the previous behaviour exactly, because the openness predicate falls back
to the two timestamps it used before. `20260912120100_schedule_auction_close.sql` is independent:
unscheduling the job stops closes without touching the schema.

The backfill runs inside the first migration. If the linked project ever holds a large backlog
of expired auctions, that becomes one long transaction — not a concern at current volume, and
the reason it is done now rather than deferred.

Per `AGENTS.md`, neither migration may be edited once applied. Pushing them to `main` auto-deploys
via `.github/workflows/migrations.yml`.

## References

- Roadmap slice: `context/foundation/roadmap.md:153-164` (S-03)
- PRD: FR-008 (`context/foundation/prd-v3.md:136`), §Guardrails
- Predecessor plans: `context/archive/2026-09-11-sealed-bidding/plan.md`, `context/archive/2026-09-11-list-artwork-for-auction/plan.md`
- Auction schema and design rationale: `supabase/migrations/20260911120000_add_auctions.sql`
- Bid schema, sealed policy, tie-break comparator: `supabase/migrations/20260911190000_add_bids.sql`
- The testability seam this reuses: `src/lib/auctions/status.ts:3-14`
- [Vercel: Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs) — Hobby daily cap
- [Supabase Cron](https://supabase.com/docs/guides/cron) — pg_cron scheduling

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The close, in the database

#### Automated

- [x] 1.1 Migrations apply cleanly from scratch: `npx supabase db reset` — f28643a
- [x] 1.2 Types regenerate with the three new columns: `npm run db:types:local` — f28643a
- [x] 1.3 Type checking passes: `npm run typecheck` — f28643a
- [x] 1.4 Existing default suite still passes: `npm run test` — f28643a
- [x] 1.5 Linting and formatting pass: `npm run lint` · `npm run format:check` — f28643a
- [x] 1.6 Build passes: `npm run build` — f28643a

#### Manual

- [x] 1.7 `cron.job` holds one `close-due-auctions` row after a reset — f28643a
- [x] 1.8 A past-dated auction closes within ~60s with the correct winner and amount — f28643a
- [x] 1.9 `close_due_auctions` is refused when called as `authenticated` — f28643a

### Phase 2: Real-boundary proof

#### Automated

- [x] 2.1 The new close spec passes: `npm run test:integration`
- [x] 2.2 The rest of the integration lane still passes in the same run
- [x] 2.3 Type checking passes with the new devDependencies: `npm run typecheck`
- [x] 2.4 Linting and formatting pass: `npm run lint` · `npm run format:check`
- [x] 2.5 Default suite and build unaffected: `npm run test` · `npm run build`

#### Manual

- [x] 2.6 Each close assertion was observed red before it was made green
- [x] 2.7 The lane still refuses a non-loopback `DB_URL`

### Phase 3: The outcome surfaces

#### Automated

- [ ] 3.1 Default suite passes, including the new predicate cases: `npm run test`
- [ ] 3.2 Type checking passes: `npm run typecheck`
- [ ] 3.3 Linting and formatting pass: `npm run lint` · `npm run format:check`
- [ ] 3.4 Build passes: `npm run build`
- [ ] 3.5 Integration lane still green: `npm run test:integration`

#### Manual

- [ ] 3.6 Seller sees the winning amount, or the relist message when there were no bids
- [ ] 3.7 Winner is told they won, with their amount
- [ ] 3.8 Loser is told they did not win, with no amount anywhere in the rendered HTML
- [ ] 3.9 An uninvolved signed-in user sees only that the auction ended
- [ ] 3.10 A countdown watched through zero updates itself to the outcome
- [ ] 3.11 "Recently closed" lists only auctions the viewer bid on or sold
- [ ] 3.12 A closed auction leaves the open grid on `/auctions`
