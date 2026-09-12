# Close Outcomes and Contact Exchange — Plan Brief

> Full plan: `context/changes/close-outcomes-and-contact-exchange/plan.md`
> Inherited research: `context/archive/2026-09-12-outbound-email-foundation/research.md` (§3, bridge topology)

## What & Why

Roadmap slice **S-04**, the last link in the auction spine. At close with at least one bid, the
winning bidder and the seller each receive the other's contact details; losing bidders are told they
did not win and receive nothing about the seller or the winner. At close with no bids, the seller is
told the auction ended and the artwork is free to relist. Without this, an auction resolves into
silence — the outcome exists in the database and reaches nobody.

## Starting Point

Both halves exist and cannot reach each other. `close_due_auctions` stamps the outcome under a
per-minute `pg_cron` job and is granted to **nobody** — the absent grant is the access control.
`sendEmail` is the only code that talks to a mail provider and nothing in the app calls it. Between
them: a database-triggered close cannot call Node, and `profiles` revokes table-wide select and
grants every column except `email`, so there is no path by which one user reads another's address.
Both gaps are deliberate, so this slice adds a narrow way through each rather than relaxing either.
`closed_at` is already proven to be written exactly once and never moved, with the integration test
recording that S-04 would trigger on it.

## Desired End State

An auction closes. Within about two minutes — one for the close sweep, one for the drain — four
messages have been attempted, one per person the outcome concerns, each recorded in the `email_sends`
ledger with its reason. The winner's message names the seller's email; the seller's names the
winner's; the losing bidder's names neither. Re-running either sweep sends nothing further.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Bridge credential | Shared secret verified inside definer functions | No service-role key and no second runtime, so `src/lib/email/` stays the only module that talks to a provider. | Plan (sanctioned) |
| Disclosure surface | Email only | The narrowest disclosure FR-009 permits — no new read path in the app, `profiles` grants untouched. | Plan |
| Delivery guarantee | At-least-once, bounded by an attempt ceiling | A dropped fire-and-forget POST must not silently lose a "you won" notice; a duplicate is the lesser failure. | Plan |
| Drain trigger | Per-minute `pg_cron` → `net.http_post` | Set-based like the close itself, and one mechanism serves both first attempts and retries. | Plan (departs from research's per-row webhook) |
| Enqueue mechanism | `after update of closed_at` trigger on `auctions` | Exactly-once falls out of a proven property without touching the close function the integration lane pins. | Plan (departs from research) |
| Address source | `auth.users.email`, read in the definer trigger | `profiles.email` is written on insert and never synced, so it can disclose an address the user abandoned. | Plan |
| Ledger writer | `mark_email_sent` calls `record_email_send` internally | The drain has no session and `record_email_send` must stay revoked from `anon`; this keeps the ledger's single writer literal. | Plan |
| FR-005 preference | Never gates close outcomes | A bidder who committed money must learn the result; the preference belongs to S-05's notifications. | Plan |
| Losing bidders | Do get an email | "Told" means pushed in a slice whose point is that the outcome reaches people without them checking. | Plan |
| Failure visibility | `email_sends` + the pending-rows query | Matches F-02's stated failure story exactly; no new surface. | Plan |
| Backfill | None — already-closed auctions get no rows | They predate the feature; mailing their participants now would be wrong. | Plan |

## Scope

**In scope:** `email_outbox` (no RLS policies) · an enqueue trigger resolving four recipient classes ·
`claim_pending_emails` / `mark_email_sent` gated by a vault-held secret · `pg_net` and a per-minute
drain schedule · a proxy-exempt `POST /api/email/drain` · four pure message templates with Zod'd
payloads · the claim→send→mark loop · default-lane matrix, integration proof, a real smoke send ·
`AGENTS.md` and `.env.example`.

**Out of scope:** FR-011 (the did-it-sell follow-up, the PRD's designated first cut) · the FR-005
preference and one-click unsubscribe (S-05) · any on-page contact disclosure · a custom sending
domain · HTML mail and templating · relisting limits · any change to `close_due_auctions`,
`place_bid`, `cancel_auction`, the `bids` select policy, or the swipe deck.

## Architecture / Approach

```
close_due_auctions (pg_cron, 1/min)
  └─ stamps closed_at  ──trigger: after update of closed_at──▶  email_outbox
                                  (resolves auth.users.email)      │
                                                                   │ pending
pg_cron (1/min) ─ net.http_post ─▶ POST /api/email/drain           │
                                      └─ claim_pending_emails(secret) ◀┘
                                      └─ templates → sendEmail
                                      └─ mark_email_sent(secret) ─▶ email_sends
```

Addresses live in the outbox row, which is why the drain never needs a credential that can read
addresses for its own sake — the secret buys exactly two operations, not RLS bypass. `email_outbox`
has RLS enabled with no policies at all, the posture `close_due_auctions` and `email_sends` both
already take.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. The database half | Outbox, enqueue trigger, the two secret-gated functions, integration proof | The `auction_lost` payload must carry no counterparty and no amount — the one §Access Control assertion, and the one that fails silently |
| 2. The bridge, and mail that arrives | `pg_net`, drain cron, proxy exemption, route handler, templates, drain loop, smoke send, AGENTS.md | The `pg_net` hop is fire-and-forget, so no test lane can assert on it — it is proven by hand, once |

**Prerequisites:** S-03 and F-02 done and on `main` (both are). A running local Supabase stack with
`.env.test.local` generated. A Resend key and `SMOKE_EMAIL_TO` in `.env.local`. Two Supabase Vault
entries (`email_drain_secret`, `email_drain_url`) and `EMAIL_DRAIN_SECRET` in the app env — the user
runs the Supabase lifecycle and `db:types:local` themselves.

**Estimated effort:** ~2–3 sessions. Phase 2 is the larger half and is ordered so a single-attempt
drain is proven before the retry ceiling goes above one.

## Open Risks & Assumptions

- **The vault entries are operator steps that fail quietly.** Without them the drain is inert and the only symptom is outbox rows staying pending — which is exactly what the pending-rows query exists to catch, but nobody is watching it.
- **`anon` gets its first function grants in this schema.** The secret argument is the real access control; a caller holding the publishable key but not the secret gets an exception. If that reasoning is wrong, it is wrong in the one place that hands out email addresses.
- **A duplicate message is reachable** when a send succeeds and its write-back is lost. Bounded by the attempt ceiling, not eliminated.
- **Worst-case latency is ~2 minutes** (close sweep + drain). Acceptable because §Guardrails' timing requirement is about the auction closing on time, which `place_bid` enforces to the instant.
- **`onboarding@resend.dev` delivers only to the Resend account owner.** Every other recipient returns 403 → `not_permitted`, so until a sending domain is configured the only real end-to-end proof is mail to the developer's own inbox.
- **The `pg_net` hop is the one thing no lane covers.** Proven by hand via `net._http_response`, and recorded as such rather than papered over.

## Success Criteria (Summary)

- A winner learns they won, at what amount, and how to reach the seller — without opening the app.
- A losing bidder's message names no address, no amount and no bid count; the seller of an unsold piece gets a closing notice, not a failure report.
- Closing the same auction twice, or draining twice, sends nothing extra — and every attempt, successful or not, is queryable afterwards with its reason.
