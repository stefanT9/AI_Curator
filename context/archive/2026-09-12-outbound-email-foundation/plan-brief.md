# Outbound Email Foundation — Plan Brief

> Full plan: `context/changes/outbound-email-foundation/plan.md`
> Research: `context/changes/outbound-email-foundation/research.md`

## What & Why

ArtSwipe has never sent a message to anyone — no provider, no SDK, no send path anywhere in `src/`. Three coming slices need one: S-04 (close outcomes), S-05 (liker notifications), S-06 (taste-matched targeting). This builds the send path once, before three callers each invent their own — because the "a collector who turned notifications off receives none, **from any path**" guardrail is only checkable if there is one path to check.

## Starting Point

The repo has exactly one third-party integration, `src/lib/ai/`, and it is a well-documented template: closed failure union, lazy env read, never throws, one abort budget. It also has a ledger precedent (`ai_enrichment_calls`: append-only by policy omission, atomic inside a definer function) and three test lanes, one of which exists specifically to confirm a real external provider works. What it does not have is any logging at all — `grep -rn "console\." src/` returns zero matches — so "a failure is visible" is a new capability rather than an extension of something.

## Desired End State

`sendEmail({ to, subject, text })` is the only code in the repo that talks to a mail provider, never throws, and returns a typed result over six failure variants. Every attempt is recorded in an append-only `email_sends` table that no Supabase client can read or write. A real email arrives in the account owner's inbox via the smoke lane. Nothing in the running app calls it yet — that is intentional.

## Key Decisions Made

| Decision                  | Choice                                            | Why (1 sentence)                                                                                                        | Source   |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------- |
| Scope boundary            | Send module + ledger only                         | The bridge, recipient resolution, preference and unsubscribe each belong to the slice that actually needs them.          | Plan     |
| Provider                  | Resend, via its SDK                               | `onboarding@resend.dev` sends today with no domain decision, and the SDK's `{data, error}` return maps onto `{ok, reason}`. | Plan     |
| Recipient parameter       | A plain email address                             | Keeps the module database-free, so the "which credential outranks RLS" decision moves to the slice that knows the recipients. | Plan     |
| Failure visibility        | An `email_sends` ledger table                     | The only option that makes "did a message fail" answerable after the fact, which is a claim about history, not a moment. | Plan     |
| Ledger access             | RLS enabled, **no policies at all**               | An operator record, not a feature — and owner-readable rows would leak collector addresses to artists once S-05 exists.  | Plan     |
| Proof artifact            | Smoke lane live send + default-lane matrix        | Matches the existing three-lane discipline and proves a real message arrives without shipping unused UI.                 | Plan     |
| Who writes the ledger     | A separate `recordSend` sidecar, not `sendEmail`  | The smoke lane has no authenticated user, so a DB write inside the send function would make it uncallable there.         | Plan     |
| Bridge topology (deferred)| Database Webhook on an outbox table               | Recorded in research so S-04 inherits a decision rather than a blank page; not built here.                               | Research |
| Sending identity          | Deferred to launch day                            | The shared domain delivers to the owner's own address, and the only real user is the owner.                              | Research |

## Scope

**In scope:** the `resend` dependency · `RESEND_API_KEY` + `EMAIL_FROM` in `.env.example` · `src/lib/email/{send,record,index}.ts` · one additive migration (`email_sends` + `record_email_send`) · default-lane failure matrix · integration-lane grant proof · smoke-lane live send · an `AGENTS.md` section.

**Out of scope:** the `pg_net` / Database Webhook bridge · recipient resolution · the FR-005 preference column and toggle · one-click unsubscribe and `List-Unsubscribe` headers · retries, queueing, backoff · templating · moving Supabase Auth email onto this provider · any user-reachable surface · a custom sending domain and its DNS records.

## Architecture / Approach

Two layers, mirroring how `top-up.ts` composes over `src/lib/ai/`. `send.ts` is pure and database-free — the choke point that talks to Resend, and being DB-free is exactly what makes it callable from the smoke lane, a Server Action, and later a webhook drain without any of them holding a credential that outranks RLS. `record.ts` is a never-throws sidecar that writes the ledger through a `security definer` RPC, taking a client rather than constructing one. The ledger table has no RLS policies at all, following `close_due_auctions`' "the absence is the access control" posture.

## Phases at a Glance

| Phase                                        | What it delivers                                                    | Key risk                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1. The send path, and a real email           | `src/lib/email/`, env config, failure matrix, a message that arrives | Resend returns the shared-domain 403 with error name `validation_error` — same name as a 422; only the status code separates them. |
| 2. The ledger, and the rule written down     | Migration, `recordSend`, grant proof under real RLS, `AGENTS.md`     | Generated types make `record_email_send` look callable regardless of grants, so only the integration lane can catch a mistake. |

**Prerequisites:** a Resend account and API key in `.env.local` · `SMOKE_EMAIL_TO` set to that account's own address · a running local Supabase stack for Phase 2.
**Estimated effort:** ~2 sessions, one per phase. Phase 1 is the larger half.

## Open Risks & Assumptions

- **`actor_id` must be nullable.** A send with no user context is the normal case for S-04, whose trigger is a database cron job. `not null` would pass every test in this plan and break the first real consumer.
- **The 8s abort budget is set by the platform, not the provider.** Vercel Hobby clamps functions to 10s and a send will often run inside `after()`, sharing the invocation.
- **A consuming slice could call `sendEmail` and forget `recordSend`.** The `AGENTS.md` section is the only thing preventing it; nothing enforces the pair in code.
- **Resend's exact SDK error-object fields were not confirmed from the docs** — the classifier must be written against the installed package's types.
- **Nothing in the app exercises the module when this lands**, so env plumbing on a real deploy stays unproven until S-04 or S-05.

## Success Criteria (Summary)

- A real email, sent by this codebase, arrives in an inbox — and its Resend message id is recorded.
- With no API key, sending degrades to `unconfigured` and `npm run build` still passes, proving nothing reads the key at module scope.
- Every send attempt, successful or not, is queryable afterwards with its failure reason — and no Supabase client can read, write, or tamper with that record.
