# List Artwork for Auction (S-01) Implementation Plan

## Overview

Add the auction object to ArtSwipe: an artist lists one of their own artworks for auction with a
starting price and a preset duration, can cancel it while it is untouched, and any authenticated
user can browse open auctions in a dedicated section showing the artwork, the starting price, and
the time remaining.

This is roadmap slice **S-01** — the spine every other auction slice hangs off. Nothing in the
roadmap has anything to notify collectors about (S-05, S-06), bid on (S-02), or close (S-03, S-04)
until this object exists. The consequence for planning: the schema and the RLS shape chosen here
are inherited by five downstream slices and are expensive to change once `bids` rows reference
them, so they get more care than the size of this slice alone would justify.

Satisfies **FR-001**, **FR-002**, **FR-006**, and preserves **FR-014**.

## Current State Analysis

There is no auction surface of any kind. Thirteen migrations, no `auctions` table, no `/auctions`
route, no auction entry in the nav.

What exists and shapes the work:

- **Schema conventions are strong and consistent.** `supabase/migrations/20260909160100_add_artworks.sql`
  and `supabase/migrations/20260910101500_add_enrichment_quota.sql` establish the house style: uuid
  PK with `gen_random_uuid()`, RLS enabled on every table, policies wrapping `auth.uid()` in a
  scalar subquery, explicit indexes each carrying a comment that justifies it, `public.set_updated_at()`
  trigger for mutable rows, and `security definer` functions in `public` when a check and a write
  must be atomic.
- **The precedent for "the check belongs in the database".** `add_artworks.sql:44` — *"The role
  check belongs here and not only in the server action: a collector with a valid session could
  otherwise POST straight to PostgREST."* Any rule this slice needs to hold must hold at the
  database, not only in the Server Action.
- **`claim_enrichment_slot` is the atomicity precedent.** `add_enrichment_quota.sql` —
  *"Check and insert live in one function so two concurrent requests cannot both read a count
  under the cap and then both insert."* That is exactly the shape the one-live-auction-per-artwork
  rule needs.
- **`swipe_deck` returns `setof public.artworks`** (`20260909160200_add_interactions.sql:52`,
  replaced in place by `20260910180000_rank_swipe_deck.sql:15`). A separate `auctions` table leaves
  its signature and its result untouched — which is what FR-014 and §Guardrails ("auctions are
  strictly additive") require. Adding a column to `artworks` would not.
- **The studio grid already has a per-artwork action row.** `src/app/(app)/studio/page.tsx` renders
  Edit and `DeleteArtworkButton` per card — the natural place for a "List for auction" affordance,
  already inside `requireArtist` via `src/app/(app)/studio/layout.tsx`.
- **The integration lane runs under real RLS with no service-role key.** `test/integration/setup.ts`
  refuses any non-loopback host, and `test/integration/helpers.ts` mints ordinary users. It can
  prove what the policies permit and refuse; it cannot fabricate rows the policies forbid.
- **Mutations are Server Actions, validated with Zod at the boundary, returning a form state.**
  `src/app/actions/artworks.ts` is the template for the form path; `src/app/actions/interactions.ts`
  is the template for the argument-taking, result-returning path.
- **Pure, shared, server-and-client-safe constants live in `src/lib/<domain>/`.**
  `src/lib/artworks/tags.ts` states the rule once and explains that the database is the real gate
  and the module exists so the form promises exactly what the insert accepts.

## Desired End State

An artist opens their studio, sees a "List for auction" link on a piece that is not currently
listed, sets a starting price and picks 1, 3, or 7 days, and submits. The piece now shows an
"On auction" badge in the studio. Every authenticated user visiting `/auctions` — reachable from
the main nav — sees that auction in a grid: the artwork, the starting price, and a live countdown.
The listing artist sees their own auction in the same list, marked as theirs, with a Cancel
control. Cancelling removes it from the list. An auction whose end time has passed is no longer in
the list, with nothing having run on a timer to make that true.

Verified by: the full verify gate green, the integration lane proving the database refuses every
write the design forbids, and a manual walkthrough of list → browse → cancel.

### Key Discoveries:

- `supabase/migrations/20260909160100_add_artworks.sql:44` — the standing argument that a rule
  enforced only in a Server Action is not enforced, because PostgREST is a second front door.
- `supabase/migrations/20260910101500_add_enrichment_quota.sql` — `claim_enrichment_slot` is the
  existing answer to "two concurrent requests must not both pass the same check", and the reason it
  lives in `public` rather than `private` is that PostgREST only exposes `public` and it is called
  over RPC from a Server Action. Both reasons apply here verbatim.
- `supabase/migrations/20260909160000_add_profile_role.sql:31` — `private.is_artist()` is the
  existing role gate, `security definer`, granted to `authenticated`.
- `src/lib/artworks/queries.ts` — the `server-only` data-access module, with `attachArtists` as the
  established way to resolve attribution in one extra query rather than a PostgREST embed (because
  `email` is withheld from `profiles` at the column-grant level).
- `src/components/ui/Field.tsx` — `Field`, `submitButtonClass`, `secondaryButtonClass` are the form
  primitives; `Field` supports controlled and uncontrolled use and warns against mixing them.
- `context/foundation/lessons.md` — "Check the branch before the first commit of a change" and
  "Prove each Progress item before checking it off" both apply to this change's execution.

## What We're NOT Doing

Explicitly out of scope, deferred to the named slice or non-goal:

- **Bidding of any kind.** No `bids` table, no bid action, no bid UI. That is S-02.
- **Automatic close at the end time.** No scheduler, no cron, no `vercel.json`. An expired auction
  simply stops being open by the derived predicate. That is S-03.
- **Any notification.** No email, no provider, no send path. That is F-02, S-05, S-06.
- **Contact exchange or winner determination.** That is S-04.
- **The on-auction flag in the swipe deck.** That is S-07, and it is blocked on PRD Open Question 2.
- **Editing a live auction.** FR-002 permits cancellation, not editing. There will be no edit path.
- **Payments, escrow, fees, shipping, in-app messaging, reserve price, buy-it-now, bundled
  auctions, artist-facing analytics** — all PRD §Non-Goals.
- **Any change to upload, AI tagging, publishing, liking, the liked view, or deck ordering.**
  FR-013 and FR-014; this slice touches none of those files.
- **Currency modelling.** §Non-Goals rules out payments and fees, so the starting price is a number
  in implicit minor units with no currency column and no conversion.

## Implementation Approach

Build the auction as an additive module with its own table, its own `src/lib/auctions/` directory,
its own actions file, and its own route segment. Nothing in `src/lib/artworks/`,
`src/app/actions/artworks.ts`, `src/app/actions/interactions.ts`, or any existing migration is
modified. The two places existing files change at all are the studio grid (one affordance) and the
app layout nav (one link).

The central design choice is that **`auctions` has no INSERT, UPDATE, or DELETE policy**. Both
mutations are `security definer` functions that verify `auth.uid()` themselves. This is a stronger
position than the codebase has taken before, and it is taken deliberately:

- It makes FR-002's "no edits" absolute rather than conventional — there is no edit path to close.
- It makes the one-live-auction-per-artwork rule unbypassable, which a plain INSERT policy would
  not.
- It gives S-02 exactly one line to change: the `not exists (select 1 from public.bids ...)`
  predicate inside `cancel_auction`.

State is derived rather than stored: an auction is open when `cancelled_at is null and ends_at > now()`.
Nothing flips a flag, so nothing can be wrong. Cancellation is a soft `cancelled_at` stamp, not a
delete, so history survives for the relisting semantics FR-010 will need.

## Critical Implementation Details

**Type generation is a manual step and it gates everything downstream.** `src/types/database.ts` is
generated and must never be hand-edited (AGENTS.md). Nothing in Phase 2 will typecheck until
`npm run db:types:local` has run against a stack with the new migration applied. That command and
the `supabase db reset` before it are the user's to run — they are called out as manual Progress
items, not automated ones.

**A partial unique index cannot express "one live auction per artwork".** The predicate involves
`now()`, which is not `IMMUTABLE`, so Postgres will reject it in an index predicate. This is why the
rule lives inside `create_auction` with a row lock rather than in a constraint, and it is the
non-obvious reason the function exists at all.

**The countdown must not be server-rendered as a relative string.** A server-computed "3 days left"
differs between the server render and the client hydration pass, which is a hydration mismatch. The
server emits the absolute time and the ISO timestamp; the client component swaps in the ticking
remainder after mount.

---

## Phase 1: Schema and domain vocabulary

### Overview

Create the `auctions` table with its two `security definer` mutation functions, regenerate the
database types, and add the pure `src/lib/auctions/` module that states the durations, the price
bounds, and the openness predicate once for both server and client.

### Changes Required:

#### 1. The auctions migration

**File**: `supabase/migrations/20260911120000_add_auctions.sql`

**Intent**: Create the table that every later auction slice attaches to, with state derived from
timestamps rather than stored in a status column, and with the mutation surface closed to
everything but two functions. Follow the commenting discipline of `add_artworks.sql` — every index
and every policy carries the reason it exists.

**Contract**:

- Table `public.auctions`: `id uuid pk default gen_random_uuid()`, `artwork_id uuid not null
  references public.artworks (id) on delete cascade`, `seller_id uuid not null references
  public.profiles (id) on delete cascade`, `starting_price_cents bigint not null`,
  `ends_at timestamptz not null`, `cancelled_at timestamptz null`,
  `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
- Constraints: `auctions_starting_price_positive check (starting_price_cents > 0 and
  starting_price_cents <= 100000000000)`; `auctions_ends_after_start check (ends_at > created_at)`.
- Indexes: on `(artwork_id)` (the studio's live-auction lookup and the FK); on `(ends_at)` (the
  browse query's range predicate); on `(seller_id)` (the FK, and S-04's seller lookup).
- Trigger `auctions_set_updated_at` reusing the existing `public.set_updated_at()`.
- RLS enabled. **One policy only**: select, `to authenticated`, `using (true)` — FR-006 makes open
  auctions browsable by any signed-in user, and this table holds no bid data, so it stays safe when
  S-02 adds a separate `bids` table. Deliberately **no** insert, update, or delete policy; a comment
  states that both mutations go through the functions below and why.

`seller_id` is denormalised from `artworks.artist_id` on purpose: S-04 needs the seller of a
closed auction even if the artwork row has since been deleted, and the join is one the browse query
would otherwise make on every read.

#### 2. `create_auction`

**File**: `supabase/migrations/20260911120000_add_auctions.sql` (same migration)

**Intent**: The only way an auction row comes into existence. Verifies the caller is an artist, owns
the artwork, and has no live auction on it — then inserts, all in one statement-atomic function.

**Contract**: `public.create_auction(p_artwork_id uuid, p_duration_hours int, p_starting_price_cents bigint)
returns uuid`, `language plpgsql`, `volatile`, `security definer`, `set search_path = ''`.
`revoke execute ... from public, anon; grant execute ... to authenticated`.

Raises a distinguishable error (or returns null — pick one and hold it, the action must be able to
tell the cases apart) for each of: caller not authenticated, caller not `private.is_artist()`,
artwork not owned by caller, a live auction already exists on the artwork, duration not in the
permitted set. `p_duration_hours` is validated against `(24, 72, 168)` inside the function, so the
preset list is enforced at the database and not only at the Zod boundary.

The concurrency guard is the non-obvious part: take `select ... from public.artworks where id =
p_artwork_id and artist_id = v_user for update` before the liveness check, so two concurrent calls
serialise on the artwork row. Without it, both can read "no live auction" and both insert.

`ends_at` is computed as `now() + make_interval(hours => p_duration_hours)` — the client never
supplies an end time.

#### 3. `cancel_auction`

**File**: `supabase/migrations/20260911120000_add_auctions.sql` (same migration)

**Intent**: The only way an auction is cancelled. One conditional UPDATE whose WHERE clause *is*
FR-002's rule, so S-02 extends the rule by adding one predicate here rather than by finding every
caller.

**Contract**: `public.cancel_auction(p_auction_id uuid) returns boolean`, `security definer`,
`set search_path = ''`, same revoke/grant pair. Returns whether a row was actually cancelled.

The single statement, with a comment marking the S-02 extension point:

```sql
update public.auctions
   set cancelled_at = now()
 where id = p_auction_id
   and seller_id = (select auth.uid())
   and cancelled_at is null
   and ends_at > now()
   -- S-02 adds here: and not exists (select 1 from public.bids b where b.auction_id = id)
returning true into v_cancelled;
```

#### 4. Regenerated database types

**File**: `src/types/database.ts`

**Intent**: Pick up the new table and the two function signatures so the Supabase client types the
`.rpc()` calls Phase 2 makes. Generated — never hand-edited.

**Contract**: Produced by `npm run db:types:local` after `supabase db reset`. Run by the user (see
Critical Implementation Details). The file must gain a `public.Tables.auctions` entry and
`public.Functions.create_auction` / `cancel_auction` entries.

#### 5. Domain aliases

**File**: `src/types/domain.ts`

**Intent**: Name the auction row and the shape the UI actually wants, alongside the existing
`Artwork` / `ArtworkWithArtist` aliases and for the same stated reason — `database.ts` is
overwritten wholesale.

**Contract**: `export type Auction = Database["public"]["Tables"]["auctions"]["Row"]` and an
`AuctionWithArtwork = Auction & { artwork: ArtworkWithArtist }` for the browse surface.

#### 6. The pure auctions module

**File**: `src/lib/auctions/config.ts`

**Intent**: State the durations and price bounds once, mirroring the database's own checks, so the
form promises exactly what `create_auction` will accept. Same role and same rationale as
`src/lib/artworks/tags.ts`. No `server-only` — the form and the countdown are client components.

**Contract**: `AUCTION_DURATIONS` as an ordered list of `{ hours, label }` for 24 / 72 / 168 with
labels "1 day" / "3 days" / "7 days"; `AUCTION_DURATION_HOURS` as the derived tuple used by the Zod
enum; `MIN_STARTING_PRICE_CENTS` and `MAX_STARTING_PRICE_CENTS` mirroring the CHECK constraint.

**File**: `src/lib/auctions/status.ts`

**Intent**: Define openness and remaining time as pure functions of a row and an explicit clock, so
the predicate the browse query uses, the badge the studio shows, and the countdown the client ticks
all agree — and so all three are testable at any instant without a database.

**Contract**: `isOpen(auction: Pick<Auction, "cancelled_at" | "ends_at">, now: Date): boolean` and
`msRemaining(auction, now): number`, plus `formatRemaining(ms): string`. An explicit `now` parameter
rather than an internal `Date.now()` is what makes the expiry behaviour unit-testable, given the
integration lane cannot fabricate an expired row.

**File**: `src/lib/auctions/price.ts`

**Intent**: Convert between the minor units the database stores and the decimal string a person
types, in one place, so the form and every display site cannot disagree.

**Contract**: `parsePriceToCents(input: string): number | null` (null for anything unparseable,
negative, zero, or out of bounds) and `formatCents(cents: number): string`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly from scratch: `npx supabase db reset`
- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- Unit tests for `isOpen` / `msRemaining` / `formatRemaining` at an injected clock pass: `npm run test`
- Unit tests for `parsePriceToCents` / `formatCents` round-trip and reject out-of-bounds input: `npm run test`
- Build passes: `npm run build`

#### Manual Verification:

- `npm run db:types:local` has been run and `src/types/database.ts` contains `auctions`,
  `create_auction`, and `cancel_auction`
- `select * from pg_policies where tablename = 'auctions'` returns exactly one row, the select policy
- Existing migrations are untouched — `git diff` over `supabase/migrations/` shows only the new file

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 2: Server Actions and data access

### Overview

Add the Zod-validated Server Actions that call the two functions, and the `server-only` query module
that reads open auctions for the browse page and live-auction status for the studio.

### Changes Required:

#### 1. Auction Server Actions

**File**: `src/app/actions/auctions.ts`

**Intent**: The two mutations, validated at the boundary before anything is called, following the
form-state shape of `src/app/actions/artworks.ts` for the create path and the result shape of
`src/app/actions/interactions.ts` for cancel. Every export of a `"use server"` module is a public
endpoint (AGENTS.md), so these two are the entire public surface and both re-verify authorisation
through the DAL before the RPC re-verifies it again in the database.

**Contract**:

- `export type AuctionFormState = { errors?: { startingPrice?: string[]; duration?: string[] };
  message?: string } | undefined`
- `createAuction(_state: AuctionFormState, formData: FormData): Promise<AuctionFormState>` —
  `requireArtist()`, Zod-parse `artworkId` (uuid), `startingPrice` (string → cents via
  `parsePriceToCents`, bounded), `duration` (enum over `AUCTION_DURATION_HOURS`), then
  `supabase.rpc("create_auction", ...)`. Maps each distinguishable database refusal to a field error
  or a message — in particular "a live auction already exists" is a user-facing message, not a
  crash. On success: `revalidatePath("/studio")`, `revalidatePath("/auctions")`, `redirect("/auctions")`.
- `cancelAuction(formData: FormData): Promise<void>` — `requireUser()`, Zod-parse the auction id,
  `supabase.rpc("cancel_auction", ...)`. A `false` return is not an error condition to throw on: it
  means the auction was already cancelled, already ended, or not the caller's. Revalidate both paths.

Note for the implementer: nothing in this action may sit on the critical path behind a third-party
call — see `context/foundation/lessons.md`, "Never block a user-visible mutation on a third-party AI
call". Nothing here should call one at all; the note is here so it stays that way when S-05 adds
notifications and is tempted to `await` a send.

#### 2. Auction queries

**File**: `src/lib/auctions/queries.ts`

**Intent**: The read side, `server-only`, mirroring `src/lib/artworks/queries.ts` — including its
stated reason for resolving attribution with a second query rather than a PostgREST embed.

**Contract**:

- `getOpenAuctions(): Promise<AuctionWithArtwork[]>` — selects auctions where
  `cancelled_at is null` and `ends_at > now()`, newest-ending-first (`ends_at` ascending, so the
  auction closing soonest is at the top), then resolves artworks and their artists. The time
  predicate is the SQL mirror of `isOpen`; a comment should name the pairing so they are changed
  together.
- `getLiveAuctionsByArtwork(artworkIds: string[]): Promise<Map<string, Auction>>` — one query for a
  whole studio page, never per row. Returns a map so the grid can look up per card.

#### 3. Default-lane tests

**File**: `test/actions/auctions.test.ts`

**Intent**: The validation gates and the happy path, with Supabase and `next/*` mocked — the smoke
layer AGENTS.md describes. Supabase is never hit for real in this lane.

**Contract**: Follows the `vi.hoisted` fixture pattern of `test/actions/interactions.test.ts`.
Covers: a malformed artwork id is rejected before the RPC; a duration outside the preset set is
rejected; a zero, negative, or unparseable price is rejected; the happy path calls
`rpc("create_auction", ...)` with cents and hours; an "already live" refusal surfaces as a message
rather than throwing; `cancelAuction` returns quietly on a `false` result.

**File**: `test/lib/auctions-queries.test.ts`

**Intent**: Pin that the open-auction query actually carries both halves of the openness predicate —
the failure mode being a query that filters on `cancelled_at` and forgets `ends_at`, which would
show expired auctions forever.

**Contract**: Mocked Supabase query builder; asserts `is("cancelled_at", null)` and a `gt` on
`ends_at` are both applied, and that `getLiveAuctionsByArtwork` issues one query for many ids.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- New and existing default-lane tests pass: `npm run test`
- Build passes: `npm run build`

#### Manual Verification:

- `src/app/actions/auctions.ts` exports exactly two functions, both of which re-check authorisation
- No file under `src/lib/artworks/`, `src/app/actions/artworks.ts`, or `src/app/actions/interactions.ts`
  appears in `git diff`

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 3: Real-boundary proof of the RLS and RPC design

### Overview

Prove against a real local Supabase stack that the database refuses every write the design forbids,
before any UI rests on the assumption that it does. This phase adds no product code.

It is sequenced here, ahead of the UI, deliberately: the closed mutation surface is the load-bearing
decision of this slice and the one S-02 through S-04 inherit. Discovering a hole in it after two UI
surfaces are built is the expensive ordering.

### Changes Required:

#### 1. Auction boundary spec

**File**: `test/integration/auctions.int.ts`

**Intent**: Answer the questions mocking cannot — what the policies and the two functions actually
permit and refuse for a real authenticated user under real RLS.

**Contract**: Uses `requireLocalRunningStack` from `test/integration/setup.ts` and the fixture
helpers in `test/integration/helpers.ts`. **One test user per file is the rule** (the
`sign_in_sign_ups` rate limit is 30 per 5 minutes per IP) — this file needs an artist, a second
artist, and a collector, which is within the established budget for a file.

Cases, each of which is a distinct claim about the design:

- An artist can create an auction on their own artwork and it comes back from a select.
- A second `create_auction` on the same artwork while the first is live is refused.
- An artist cannot create an auction on another artist's artwork.
- A collector (non-artist) cannot create an auction at all.
- A duration outside `(24, 72, 168)` is refused by the function, not only by Zod.
- A starting price of zero or a negative is refused by the CHECK constraint.
- The seller can cancel their own untouched auction; `cancel_auction` returns true, and a second
  call returns false.
- A different user calling `cancel_auction` on someone else's auction returns false and the row is
  unchanged.
- **A direct PostgREST `insert` into `auctions` is refused** — this is the test that proves the
  closed mutation surface, and the reason the one-live-auction rule cannot be walked around.
- **A direct PostgREST `update` on an auction is refused** — proves FR-002's "no edits" has no door.
- Any authenticated user can select an auction created by someone else (FR-006's browse premise).

Teardown removes what the file created, following the existing helpers' pattern — no service-role
key, a user deleting its own rows through policies that already exist. Note that with no delete
policy on `auctions`, cleanup of auction rows is by artwork cascade (`on delete cascade` from
`artworks`), so deleting the fixture artwork is what clears them.

### Success Criteria:

#### Automated Verification:

- The integration lane passes against a local stack: `npm run test:integration`
- The default lane is still green and CI-safe: `npm run test`
- Linting and formatting pass over the new spec: `npm run lint` · `npm run format:check`

#### Manual Verification:

- Each of the eleven cases above exists as its own named test — the count and the names were not
  narrowed to fit what was easy to write (`context/foundation/lessons.md`, "Prove each Progress item
  before checking it off")
- The lane was observed failing when a policy is temporarily loosened, confirming the refusal tests
  actually test refusal rather than passing vacuously
- `test/integration/auctions.int.ts` mints no more users than it uses

**Implementation Note**: After completing this phase and all automated verification passes, pause
for manual confirmation before proceeding.

---

## Phase 4: The listing flow and the auction section

### Overview

The two user-facing surfaces: an artist lists a piece from the studio, and every authenticated user
browses open auctions at `/auctions` with a live countdown and — for their own listings — an inline
cancel.

### Changes Required:

#### 1. The listing form

**File**: `src/components/auctions/AuctionForm.tsx`

**Intent**: Collect a starting price and a duration for one artwork. A client component, because it
uses `useActionState` against `createAuction` and validates the price as the artist types.

**Contract**: Props `{ artwork: Artwork }`. Renders a hidden `artworkId`, a price `Field` from
`src/components/ui/Field.tsx`, and the durations from `AUCTION_DURATIONS` as radio inputs (three
options — a select would hide the choice behind an interaction for no gain). Uses `submitButtonClass`.
Shows the resolved end time ("ends Thursday, 18 September") as the artist changes the duration, so
the preset is concrete rather than abstract.

**File**: `src/app/(app)/studio/[id]/auction/page.tsx`

**Intent**: The route the studio's "List for auction" link opens. Inside `(app)/studio`, so
`requireArtist` already applies via the segment layout.

**Contract**: `PageProps<"/studio/[id]/auction">`, `await params`, `getArtwork(id)`, `notFound()`
when absent or not owned by the caller, and `notFound()` (or a message) when the piece already has a
live auction — the same refusal `create_auction` would give, surfaced before the artist fills in a
form that cannot succeed. Renders `ArtCard` alongside `AuctionForm`. `export const dynamic = "force-dynamic"`
and a `metadata` title, matching the other pages in the segment.

#### 2. The studio affordance

**File**: `src/app/(app)/studio/page.tsx`

**Intent**: Give the artist the entry point, and tell them which pieces are already listed so the
link is never a guaranteed refusal.

**Contract**: One added call to `getLiveAuctionsByArtwork` over the ids already fetched, then per
card in the existing action row: an "On auction" badge linking to `/auctions` when a live auction
exists, otherwise a "List for auction" link to `/studio/${artwork.id}/auction`. The Edit and Delete
controls are unchanged.

#### 3. The auction card and countdown

**File**: `src/components/auctions/AuctionCountdown.tsx`

**Intent**: Make "time remaining" true rather than stale, without a hydration mismatch.

**Contract**: `"use client"`. Props `{ endsAt: string; absolute: string }`. Renders `absolute` —
the server-formatted end time — until mounted, then replaces it with `formatRemaining(msRemaining(...))`
on a one-second interval, clearing the interval on unmount and at zero. At zero it shows "Ended";
the row disappears from the list on the next navigation, since openness is derived.

**File**: `src/components/auctions/AuctionCard.tsx`

**Intent**: The one way an auction is drawn, the same role `ArtCard` plays for artworks.

**Contract**: Props `{ auction: AuctionWithArtwork; isOwn: boolean }`. Composes `ArtCard` for the
artwork itself (so a change to how a piece looks still lands everywhere), then the starting price via
`formatCents`, the `AuctionCountdown`, and — when `isOwn` — a "Your listing" marker plus a
`CancelAuctionButton`. **No bid control, no bid count, no bidder name** anywhere in this component;
a comment should say so and cite §Guardrails "sealed means sealed", because this is the file S-02
will be tempted to add them to.

**File**: `src/components/auctions/CancelAuctionButton.tsx`

**Intent**: The seller's cancel control, with a confirm step.

**Contract**: `"use client"`, modelled directly on `src/components/artworks/DeleteArtworkButton.tsx`
— a form whose `action` is `cancelAuction`, a hidden auction id, and an `onSubmit` confirm.

#### 4. The auction section

**File**: `src/app/(app)/auctions/page.tsx`

**Intent**: FR-006's dedicated section.

**Contract**: `requireUser()`, `getOpenAuctions()`, grid of `AuctionCard` using the same
`grid gap-6 sm:grid-cols-2 lg:grid-cols-3` and dashed empty-state treatment as
`src/app/(app)/liked/page.tsx`. `isOwn` computed by comparing `auction.seller_id` to the
authenticated user's id. `export const dynamic = "force-dynamic"` and a `metadata` title.

#### 5. Navigation

**File**: `src/app/(app)/layout.tsx`

**Intent**: Make the section reachable. FR-006's Socrates note counts the auction section as one of
three routes in, so it needs to be visible to everyone, not only artists.

**Contract**: One `Link` to `/auctions` labelled "Auctions" in the existing `<nav>`, alongside
Discover and Liked and outside the `role === "artist"` branch.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Formatting passes: `npm run format:check`
- The full default lane passes, including every pre-existing artwork, interaction, deck, and
  onboarding spec unchanged: `npm run test`
- The integration lane still passes: `npm run test:integration`
- Build passes: `npm run build`

#### Manual Verification:

- An artist lists a piece from the studio with each of the three durations and the auction appears
  at `/auctions` with the right end time
- A listed piece shows the "On auction" badge in the studio and offers no second listing link
- A collector signed in as a different user sees the auction and no bid control, no bid count, and
  no bidder information anywhere on the page or in the page source (§Guardrails, "sealed means
  sealed" — this holds trivially now and the check establishes the habit for S-02)
- The countdown ticks live on an open tab and reads "Ended" when it reaches zero; a reload drops the
  auction from the list
- The seller cancels their own auction and it disappears; a second user has no cancel control
- **FR-014 regression:** uploading a new artwork, its AI tagging, and publishing all behave exactly
  as before — walked through end to end, not inferred from the test suite
- **FR-013 regression:** the swipe deck serves the same artworks in the same order, liking works,
  and the liked view is unchanged

**Implementation Note**: This is the final phase. After all automated verification passes and manual
testing is confirmed, the change is complete.

---

## Testing Strategy

### Unit Tests (default lane, `npm run test`):

- `isOpen` / `msRemaining` / `formatRemaining` at an injected clock — including the exact boundary
  instant, one millisecond either side, and a cancelled-but-not-yet-ended row
- `parsePriceToCents` / `formatCents` — round trip, decimals, rejection of zero, negatives,
  non-numeric input, and values beyond the CHECK constraint's bounds
- `createAuction` Zod gates: bad uuid, duration outside the preset set, unparseable price
- `createAuction` happy path: the RPC is called with cents and hours, not with a decimal or a label
- `createAuction` refusal mapping: "already live" becomes a user-facing message
- `cancelAuction` returns quietly on a `false` result rather than throwing
- `getOpenAuctions` applies both halves of the openness predicate
- `getLiveAuctionsByArtwork` issues one query for many ids

### Integration Tests (opt-in lane, `npm run test:integration`, local only):

The eleven boundary cases in Phase 3. The two that matter most are the direct-`insert` and
direct-`update` refusals: they are the only evidence that the closed mutation surface — the design
decision the rest of the auction roadmap inherits — is real rather than intended.

### Manual Testing Steps:

1. Sign in as an artist with at least one published piece. Open `/studio`; confirm each unlisted
   piece shows "List for auction".
2. List a piece at 7 days. Confirm the redirect to `/auctions` and that the card shows the artwork,
   the starting price formatted correctly, and a countdown near 7 days.
3. Return to `/studio`; confirm the piece now shows "On auction" and offers no listing link.
4. Navigate directly to `/studio/<that-id>/auction`; confirm it refuses rather than offering a form
   that cannot succeed.
5. Leave `/auctions` open for a minute; confirm the countdown ticks.
6. Cancel the auction from its card; confirm it disappears and the studio offers the listing link
   again — this is FR-010's relisting path working ahead of time.
7. Sign in as a second user. Confirm `/auctions` shows the first user's auctions with no cancel
   control, no bid control, and nothing about bids in the rendered source.
8. As that second user, upload a new artwork end to end and confirm tagging and publishing are
   unchanged (FR-014).
9. Swipe several cards, like one, and confirm `/liked` and the deck order are unchanged (FR-013).

## Performance Considerations

The browse query is one select on `auctions` filtered by `ends_at`, plus one artwork lookup and one
profile lookup for the whole page — the `attachArtists` batching pattern, never per row. The
`auctions_ends_at_idx` covers the range predicate. The studio page gains exactly one query
regardless of how many pieces the artist has.

The countdown runs one interval per card. At the volumes this product has that is immaterial; if the
auction list ever grows past a screenful, a single shared ticker in a context provider is the
obvious next step, and is not worth building now.

## Migration Notes

Nothing to migrate. The `auctions` table is new and empty, and no existing table, function, policy,
or row is modified — `20260910180000_rank_swipe_deck.sql` and every artwork and interaction row are
untouched, which is what makes the FR-013 and FR-014 preservation claims cheap to hold.

Rollback is dropping the migration forward in a new migration (AGENTS.md: never edit an applied
migration). Because nothing outside the auction module reads the table, a forward-drop removes the
feature without touching anything else.

Pushing the migration file to `main` auto-applies it via `.github/workflows/migrations.yml`.

## References

- Roadmap slice: `context/foundation/roadmap.md` — S-01
- PRD: `context/foundation/prd-v3.md` — US-01, FR-001, FR-002, FR-006, FR-014, §Guardrails,
  §Constraints, §Non-Goals
- Lessons: `context/foundation/lessons.md`
- Table and policy style: `supabase/migrations/20260909160100_add_artworks.sql`
- Atomic check-and-write function: `supabase/migrations/20260910101500_add_enrichment_quota.sql`
- Role gate: `supabase/migrations/20260909160000_add_profile_role.sql:31`
- Form-state Server Action: `src/app/actions/artworks.ts`
- Result-returning Server Action: `src/app/actions/interactions.ts`
- Data-access module: `src/lib/artworks/queries.ts`
- Grid and empty state: `src/app/(app)/liked/page.tsx`
- Confirm-then-submit button: `src/components/artworks/DeleteArtworkButton.tsx`
- Integration lane rails and fixtures: `test/integration/setup.ts`, `test/integration/helpers.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and domain vocabulary

#### Automated

- [x] 1.1 Migration applies cleanly from scratch: `npx supabase db reset` — a16dc6e
- [x] 1.2 Type checking passes: `npm run typecheck` — a16dc6e
- [x] 1.3 Linting passes: `npm run lint` — a16dc6e
- [x] 1.4 Formatting passes: `npm run format:check` — a16dc6e
- [x] 1.5 Unit tests for `isOpen` / `msRemaining` / `formatRemaining` at an injected clock pass: `npm run test` — a16dc6e
- [x] 1.6 Unit tests for `parsePriceToCents` / `formatCents` round-trip and reject out-of-bounds input: `npm run test` — a16dc6e
- [x] 1.7 Build passes: `npm run build` — a16dc6e

#### Manual

- [x] 1.8 `npm run db:types:local` has been run and `src/types/database.ts` contains `auctions`, `create_auction`, and `cancel_auction` — a16dc6e
- [x] 1.9 `pg_policies` returns exactly one row for `auctions`, the select policy — a16dc6e
- [x] 1.10 Existing migrations are untouched — a16dc6e

### Phase 2: Server Actions and data access

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — aefd96c
- [x] 2.2 Linting passes: `npm run lint` — aefd96c
- [x] 2.3 Formatting passes: `npm run format:check` — aefd96c
- [x] 2.4 New and existing default-lane tests pass: `npm run test` — aefd96c
- [x] 2.5 Build passes: `npm run build` — aefd96c

#### Manual

- [x] 2.6 `src/app/actions/auctions.ts` exports exactly two functions, both re-checking authorisation — aefd96c
- [x] 2.7 No existing artworks, interactions, or `src/lib/artworks/` file appears in `git diff` — aefd96c

### Phase 3: Real-boundary proof of the RLS and RPC design

#### Automated

- [x] 3.1 The integration lane passes against a local stack: `npm run test:integration` — 7ed7300
- [x] 3.2 The default lane is still green and CI-safe: `npm run test` — 7ed7300
- [x] 3.3 Linting and formatting pass over the new spec: `npm run lint` · `npm run format:check` — 7ed7300

#### Manual

- [x] 3.4 Each of the eleven boundary cases exists as its own named test, none narrowed to fit — 7ed7300
- [x] 3.5 The lane was observed failing with a policy temporarily loosened, confirming the refusal tests are not vacuous — 7ed7300
- [x] 3.6 `test/integration/auctions.int.ts` mints no more users than it uses — 7ed7300

### Phase 4: The listing flow and the auction section

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck` — f1f098a
- [x] 4.2 Linting passes: `npm run lint` — f1f098a
- [x] 4.3 Formatting passes: `npm run format:check` — f1f098a
- [x] 4.4 The full default lane passes, including every pre-existing spec unchanged: `npm run test` — f1f098a
- [x] 4.5 The integration lane still passes: `npm run test:integration` (all 39 tests across all 5 files pass; a `storage-boundary.int.ts` test that briefly failed mid-phase was a stale characterization test — it pinned a bug fixed by an unrelated, already-closed change's migration `20260911000000_add_artwork_storage_select.sql`, and was updated to assert the now-correct behavior) — f1f098a
- [x] 4.6 Build passes: `npm run build` — f1f098a

#### Manual

- [x] 4.7 An artist lists a piece with each of the three durations and it appears at `/auctions` with the right end time — f1f098a
- [x] 4.8 A listed piece shows the "On auction" badge and offers no second listing link — f1f098a
- [x] 4.9 A second user sees the auction with no bid control, bid count, or bidder information anywhere in the page source — f1f098a
- [x] 4.10 The countdown ticks live and reads "Ended" at zero; a reload drops the auction from the list — f1f098a
- [x] 4.11 The seller cancels their own auction and it disappears; a second user has no cancel control — f1f098a
- [x] 4.12 FR-014 regression: upload, AI tagging, and publishing walked through end to end and unchanged — f1f098a
- [x] 4.13 FR-013 regression: deck ordering, liking, and the liked view unchanged — f1f098a
