# Auction Notifications for Likers — Plan Brief

> Full plan: `context/changes/auction-notifications-for-likers/plan.md`

## What & Why

When an auction opens, every collector who liked that artwork and has auction notifications enabled
is told about it (FR-003); every collector has an auction-notification preference, on by default,
which they can turn off from their account page or from a link in any notification (FR-005).

The two ship together by PRD decree, not convenience. FR-003's Socrates note records that the
notification was *revised* to depend on the preference, because "a like was never consent to be
emailed". Shipping the notification without the switch ships the version the PRD explicitly
rejected.

It is also what makes the auction spine visible: S-01 through S-04 built a working auction nobody
is ever told about.

## Starting Point

The expensive half already exists. S-04 left behind a *general* outbox, and its drain branches on
nothing — it passes `row.kind` straight to the compose dispatch (`src/lib/email/outbox.ts:195`). A
fifth message kind therefore touches a CHECK constraint, a template and a dispatch branch, and
nothing else.

What does not exist is the consent half: no preference of any kind, and no unauthenticated route
that acts on a user's behalf — this would be the project's first.

## Desired End State

An artist lists a piece. Within a minute, every collector who liked it — except the artist, and
except anyone who has opted out — has an outbox row the drain sends. The mail names the piece, the
starting price and the closing time, links to the auction, says why they are receiving it, and
carries an unsubscribe link. An opted-out collector gets **no row at all** — not a row that fails
to send.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Enqueue topology | After-insert trigger on `auctions` | Gate and targeting live in one definer function, so S-06 widens the recipient query underneath a gate it cannot bypass | Plan |
| Preference storage | New `notification_preferences` table | `profiles` has an artist-readable select policy scoped only by column grants — a column there would leak one user's setting to another | Plan |
| Default semantics | Absent row means enabled | No backfill, no signup-trigger coupling; encodes FR-005's "enabled by default" in one place | Plan |
| Unsubscribe auth | HMAC-signed token in the URL | Stateless, nothing to expire or clean up, and the secret never travels — only the signature | Plan |
| Prefetch defence | Landing page + confirm POST | Link scanners GET every URL in mail; a mutating GET unsubscribes people silently, which looks identical to the feature working | Plan |
| Volume cap | Deferred to S-06 | Under FR-003 alone, volume is bounded by the collector's own likes, so a cap here would be untestable | Plan (PRD OQ-1) |
| Recipient scope | Likers only, seller always excluded | FR-003 names likers; the seller cannot bid, so a notification would be noise | Plan |
| Definition of done | Ledger proves targeting; delivery manual to one address | Every FR-003 / FR-005 guardrail is a claim about rows, so the slice is provable without a sending domain | Plan |

## Scope

**In scope:** the preference table and its account-page toggle; an unauthenticated unsubscribe page
and route with a signed token; a fifth `email_outbox` kind with its template; a `security definer`
enqueue function and trigger resolving likers.

**Out of scope:** FR-004 taste-matched targeting (S-06); a volume cap; HTML mail; digests; a seller
confirmation mail; fixing the sending domain; any preference beyond the single on/off switch;
backfilling preference rows.

## Architecture / Approach

```
create_auction ──▶ auctions INSERT
                        │
                        ▼  (after-insert trigger, security definer)
             enqueue_auction_opened_emails
                        │   likers ⋈ preferences (null = enabled)
                        │   − seller  − null addresses
                        ▼
                  email_outbox rows  ── existing S-04 bridge ──▶ drain ──▶ sendEmail ──▶ email_sends
```

The gate is a **join condition inside the definer function**, not a check above it or after the
send. That placement is the load-bearing decision: S-06 adds a second recipient source, and a gate
in the caller would then have two places to fail.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. The preference and its surface | `notification_preferences` table, action, account toggle | Own-row isolation must hold where `profiles` failed — proven in the integration lane, not assumed from types |
| 2. Unsubscribe without a session | HMAC token, landing page, confirm POST | First unauthenticated mutating route in the project; a mutating GET would unsubscribe people silently |
| 3. The fifth outbox kind | Widened `kind` CHECK, `auction_opened` template, renamed dispatch | Template must leak nothing about bids — the sealed guardrail holds in mail too |
| 4. Targeting, enqueue, end-to-end proof | Definer enqueue function + trigger, full recipient matrix | Minting the unsubscribe token from SQL needs the secret reachable from Postgres; plan names the alternative that keeps it in Node |

**Prerequisites:** S-01 and F-02, both done and on `main`. A local Supabase stack with the three
existing drain Vault entries planted (`supabase db reset` clears them).

**Estimated effort:** ~4 sessions, one per phase. Phases 1–3 are small and independent; Phase 4
carries the real logic and most of the integration lane.

## Open Risks & Assumptions

- **Delivery is capped at one address.** `EMAIL_FROM=onboarding@resend.dev` in both `.env.local` and
  `.env.prod`; Resend's shared sender 403s every other recipient, terminally (`outbox.ts:118`).
  Pre-existing — it already affects S-04's close outcomes. An env change, not a code change, and no
  guardrail here depends on it.
- **Phase 4's token mechanics are deliberately left open** between minting in SQL via Vault and
  building the link at render time in Node. The plan states the preference (Node) and the condition
  under which it holds; the choice must land in the migration comment.
- **Absent-row-means-enabled encodes one rule in two places** — the column default and the query's
  null handling. "Fixing" either breaks FR-005 silently; the table comment says so.
- **The unsubscribe secret must never travel over `pg_net`** — `net.http_request_queue` grants
  `PUBLIC` every privilege and this project cannot revoke it.

## Success Criteria (Summary)

- A collector who liked a piece is told when it goes up for auction, promptly, with a mail that
  reveals nothing about anyone's bids.
- A collector who turns notifications off receives none — and generates no outbox row, so their
  address is never written on account of a message they refused.
- Swiping, liking, the liked-artworks view and the deck's ordering behave exactly as before.
