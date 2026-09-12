# Timed Auction Close — Plan Brief

> Full plan: `context/changes/timed-auction-close/plan.md`

## What & Why

Roadmap slice S-03. An auction must stop at its stated end time without anyone intervening, and
the highest sealed bid standing at that moment must win — with an earlier bid beating a later
one at the same amount. This is the first time-triggered behaviour the product has ever had, and
the slice S-04 (contact exchange) is built directly on top of.

## Starting Point

Closing is already half-done by construction. The auctions schema deliberately derives state
from timestamps rather than storing a status, so an expired auction already stops being open
everywhere — `place_bid` refuses it under a row lock, every browse query excludes it, and the
detail page already says "ended". What is missing is not "stop accepting bids"; it is an
**outcome**. Nothing computes a winner, nothing records one, and S-04 has no exactly-once event
to trigger on. Nothing anywhere in the project schedules anything.

## Desired End State

An auction that reaches its end time is stamped closed within about a minute, with the winning
bid and its amount recorded on the auction row. A collector watching the countdown sees it hit
zero and the page updates itself to show the result. The winner is told they won and at what
amount, the seller is told what it sold for, other bidders are told only that they did not win —
and anyone can reach a closed auction they took part in from `/auctions`.

## Key Decisions Made

| Decision              | Choice                                              | Why (1 sentence)                                                                                                   |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Close trigger         | Supabase `pg_cron`, every minute                    | Vercel Hobby cron is capped at once per day inside an hour-wide window — disqualifying against the timing guardrail. |
| Outcome storage       | Materialise `closed_at` / `winning_bid_id` / `winning_amount_cents` on `auctions` | S-04 needs a durable exactly-once event, and the seller must learn the amount without being able to read `bids`.     |
| Timing tolerance      | Within ~1 minute of `ends_at`                       | The lag is cosmetic — `place_bid` already refuses at the exact instant, so no late bid can ever land.                |
| Close authorization   | Granted to **nobody**; only the cron job and a direct psql connection | The `p_now` test seam would otherwise let any signed-in user close live auctions early.                              |
| Test seam             | `close_due_auctions(p_now)`                         | The same explicit-clock seam `isOpen`/`canBid` already use, for the reason `status.ts` states verbatim.              |
| Bid gate              | `closed_at is null` added to `place_bid`            | Makes "closed means no more bids" structural rather than a consequence of two timestamps agreeing.                   |
| Cancelled auctions    | Skipped by the sweep; stays a disjoint terminal state | "The seller withdrew" and "it ran and nobody bid" are situations FR-010 treats differently.                          |
| Pre-existing expiries | Closed by the migration                             | No row is left in a state the new UI branches were not written for.                                                 |
| Post-close disclosure | Outcome to participants only; no identities, no bid count, no losing amounts | Makes FR-008 observable while leaving §Access Control's "one new disclosure" entirely to S-04.                       |
| Job registration      | In a migration, unguarded                           | An environment without `pg_cron` should fail loudly, not silently end up with no scheduler.                          |

## Scope

**In scope:** the close function and its schedule; outcome columns on `auctions`; `closed_at`
added to every statement of the openness predicate; backfill of already-expired auctions; a
real-boundary integration proof; participant-scoped outcome on the detail page; a closed state
on the card; a countdown that refreshes at zero; a recently-closed section on `/auctions`.

**Out of scope:** notifications of any kind (S-04/S-05, both need F-02); contact exchange; bid
counts to anyone ever; losing amounts; changes to the `bids` select policy; relisting limits
(PRD Open Question 4); pagination on the closed section; any Vercel plan change.

## Architecture / Approach

A per-minute `pg_cron` job calls one security-definer SQL function. It selects due auctions under
`for update skip locked` — the same lock `place_bid` takes, so a bid cannot land between the
due-ness read and the winner selection — picks each winner with a lateral join ordered by
`amount_cents desc, updated_at asc, id asc`, and stamps the outcome in a single `update`. It is
idempotent by its own `where closed_at is null`, the same conditional-update shape
`cancel_auction` uses. `p_now` governs due-ness only; `closed_at` is always the real clock.

## Phases at a Glance

| Phase                         | What it delivers                                                           | Key risk                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1. The close, in the database | Outcome columns, close function, predicate updates, backfill, cron schedule | `pg_cron` availability and the `cron.schedule` call behaving the same locally and on the linked project |
| 2. Real-boundary proof        | Integration spec for winner, tie-break, idempotency, post-close refusals    | Depends on `DB_URL` actually being present in `.env.test.local` — must be confirmed, not assumed        |
| 3. The outcome surfaces       | Detail-page result, card state, countdown refresh, recently-closed section  | Four viewer branches, each of which must be proven to leak nothing                                      |

**Prerequisites:** S-02 (`sealed-bidding`) is done and on `main`. A running local Supabase stack
with `.env.test.local` generated. The user runs the Supabase lifecycle and `db:types:local`
commands themselves.

**Estimated effort:** ~3 sessions, one per phase.

## Open Risks & Assumptions

- **`DB_URL` in `.env.test.local` is assumed, not verified.** `supabase status -o env` should emit it, but Phase 2 must confirm before building on it — if the name differs, the accessor and the `AGENTS.md` instructions change together.
- **The countdown refresh races the sweep.** A refresh fired the instant the countdown hits zero can show "ended" with no outcome. The delay must cover the worst-case minute, which makes the update feel slightly late by design.
- **pg_cron puts operational state in the database rather than the repo.** The schedule is registered by a migration, but its *running* state is invisible from the codebase — a disabled job is silent.
- **Materialising the outcome is a deliberate exception** to the auctions table's stated derive-everything stance. If that stance is later reasserted, this is the row to argue about.
- **The sweep is unbounded in principle.** A minute-long batch of overdue auctions closes in one transaction; the partial index and current volume make this fine, and it is noted so nobody rediscovers it.

## Success Criteria (Summary)

- A collector watching a countdown reach zero sees the auction close and the outcome appear, without reloading.
- The highest bid wins; at equal amounts the earlier one wins — proven against a real database, including the case where a raise correctly moves a bidder behind.
- Nobody learns anything §Guardrails withholds: no bid count, no bidder identity, no losing amount, and the seller still cannot read `bids` at all.
