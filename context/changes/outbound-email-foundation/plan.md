# Outbound Email Foundation Implementation Plan

## Overview

Stand up `src/lib/email/` as the single path from this app to a mail provider, plus an append-only ledger that makes a failed send answerable after the fact. Prove it by receiving a real email, without shipping any surface a user can reach.

This is F-02 from `context/foundation/roadmap.md`, deliberately narrowed. Three future slices consume it — S-04 (close outcomes), S-05 (liker notifications), S-06 (taste-matched targeting) — and none of them exist yet. The value of doing it first is that the choke point and the failure-recording discipline exist before three callers invent three of their own.

## Current State Analysis

The project has never sent a message to anyone. Confirmed absent: no mail provider, SDK, or template library in `package.json`; no send path anywhere in `src/`; no `vercel.json` / `vercel.ts`.

What exists that this plan leans on:

- **One third-party integration to copy.** `src/lib/ai/enrich.ts` is 188 lines of exactly the required shape — closed failure union, lazy env read, never throws, one abort budget for the whole call. `src/lib/ai/index.ts` is the barrel discipline.
- **A ledger precedent.** `supabase/migrations/20260910101500_add_enrichment_quota.sql` is the closest thing to "a table recording third-party calls": append-only by policy omission, atomicity inside one `security definer` function, exhaustive `revoke`-then-`grant`.
- **Three test lanes with disjoint globs**, one of which (`test/smoke/**/*.live.ts`) exists precisely to confirm a real external provider works.
- **`profiles.email` is unreadable by anyone.** The `select` grant was narrowed in `supabase/migrations/20260909160400_public_artist_profiles.sql:15-17` and `email` has never been on the list. There is no service-role key in any runtime path. This is why the send function takes a plain address and obtaining one is left to the consuming slices.

What is missing and is created here: the provider dependency, the module, two env vars, the ledger table and its writer function, and a written rule in `AGENTS.md`.

## Desired End State

`sendEmail({ to, subject, text })` exists in `src/lib/email/`, is the only code in the repo that talks to a mail provider, never throws, and returns `{ ok: true, id } | { ok: false, reason }` over a closed six-variant union. `recordSend(supabase, entry)` writes every attempt to an append-only `email_sends` table that no Supabase client can read or write directly.

Verification that it is done:

- `npm run test:smoke -- email` sends a real message that arrives in the account owner's inbox, and prints its Resend message id.
- With `RESEND_API_KEY` unset, the same lane asserts exactly `{ ok: false, reason: "unconfigured" }` — and `npm run build` still passes, proving the key is read at call time rather than module scope.
- `npm run test:integration` proves, against real Postgres, that the ledger accepts a write through the definer function, refuses every direct client read and write, and rejects updates and deletes.
- `select * from public.email_sends order by created_at desc` over `DB_URL` shows one row per attempt with its status and failure reason.

### Key Discoveries:

- The Resend shared-domain 403 and a 422 field-validation error **both carry the error name `validation_error`** — they are distinguishable only by HTTP status. Classifying on name alone would silently collapse "you must verify a domain" into "bad recipient".
- `onboarding@resend.dev` delivers **only to the Resend account owner's own address**; any other recipient returns 403. With one real user on this project, that is sufficient for the whole of F-02 and defers the domain decision entirely.
- The smoke lane has **no authenticated user** — it calls a library function directly, with no session. So the ledger write cannot be inside `sendEmail`, and `email_sends.actor_id` must be nullable.
- `grep -rn "console\." src/` returns zero matches. There is no logger and no logging convention to extend; the ledger is the observability mechanism, not a log line.
- `close_due_auctions` appears in `src/types/database.ts:281` despite being granted to nobody — generated types reflect the catalog, not grants. The same will be true of `record_email_send`, so only the integration lane can prove its grants are right.
- `lefthook.yml` is entirely commented out; there is no pre-commit gate. The five-command verify set is manual and in CI.

## What We're NOT Doing

Explicitly out of scope, with the slice that owns each:

- **The `email_outbox` table, `pg_net`, and the Database Webhook bridge** — the mechanism by which a Postgres-side event reaches this module. Recommended shape is recorded in `research.md` §"Follow-up Research"; S-04 builds it.
- **Recipient resolution.** No definer function that answers "who should hear about this auction". S-05 (likers) and S-06 (taste match) own it, and F-01 supplies the taste definition S-06 needs.
- **The FR-005 notification preference** — no column, no toggle, no account-page control. S-05 owns it.
- **One-click unsubscribe** — no route, no token scheme, no `List-Unsubscribe` headers. S-05 owns it.
- **Retries, queueing, backoff, dead-lettering.** A failed send is recorded and stays failed. The ledger is what makes a retry story possible later; it is not one.
- **Templating.** Plain text is the payload. No React Email, no MJML, no template registry.
- **Moving Supabase Auth email onto this provider.** Auth mail continues through Supabase's built-in service, which keeps the two sending reputations separate at no cost.
- **Any user-visible surface.** Nothing in the running app calls this module when the plan is done. That is intentional, not an omission.
- **A custom sending domain, SPF/DKIM/DMARC records.** `EMAIL_FROM` makes this a config change when a domain exists.

## Implementation Approach

Two layers, mirroring how `src/lib/artworks/top-up.ts` composes over `src/lib/ai/`:

- `send.ts` is **pure and database-free**. It is the choke point that talks to Resend. Being DB-free is what makes it callable from the smoke lane, from a Server Action, and later from a webhook drain, without any of them needing a credential that outranks RLS.
- `record.ts` is a **never-throws sidecar** that writes the ledger through an RPC. It takes a Supabase client rather than constructing one, so it is not bound to a request context.

The ledger is an operational record for the developer, not a user-facing feature. `email_sends` therefore gets RLS with **no policies at all** — invisible and unwritable from every client, readable only over a direct connection. This is the `close_due_auctions` posture ("the absence is the access control") and it sidesteps a trap for S-05: if the table were owner-readable, recording a collector's address against the notifying artist's `actor_id` would disclose collector addresses to that artist.

Phase 1 delivers a real email. Phase 2 delivers the ledger and writes the rule down.

## Critical Implementation Details

**The `validation_error` name collision.** Resend returns the shared-domain restriction as HTTP **403** with error name `validation_error`, and ordinary field-validation failures as **422** with names including `validation_error`, `invalid_parameter`, and `missing_required_field`. The classifier must branch on **status code first**, mapping 403 to `not_permitted` and 422 to `invalid_recipient`. Getting this backwards produces the single most confusing possible failure during development, because the first real send to any address other than the account owner's hits exactly this path.

**The abort budget is 8 seconds, and the reason is the platform, not the provider.** A Resend API call normally completes in well under a second. The constraint is that Vercel Hobby clamps function duration to 10s and a send will often run inside `after()`, where it still counts against the same invocation. Eight seconds leaves headroom and fails fast instead of consuming the ceiling. Unlike `src/lib/ai/enrich.ts` there is no fallback chain, so this is a single-call timeout rather than a shared one.

**`actor_id` must be nullable.** A send with no user context is legitimate and will be the normal case for S-04, whose trigger is a database cron job. Making the column `not null` would work for every test written in Phase 2 and break the first real consumer.

## Phase 1: The send path, and a real email in your inbox

### Overview

Add the provider, build the module in the shape `src/lib/ai/` established, cover every failure variant in the default lane, and confirm with a live send that a message actually arrives.

### Changes Required:

#### 1. The provider dependency

**File**: `package.json`

**Intent**: Add `resend` as a runtime dependency. It is the only new dependency this plan introduces.

**Contract**: A new entry under `dependencies`, pinned with the project's existing caret convention. No change to `scripts`.

#### 2. Environment configuration

**File**: `.env.example`

**Intent**: Document both new variables in a fourth block, following the `OPENROUTER_API_KEY` comment template — what it is for, that it is deliberately server-only, that it is optional and what degrades without it, and the provider's free-tier limits.

**Contract**: Two variables. `RESEND_API_KEY` (server-only, no `NEXT_PUBLIC_` prefix; unset means sending is unavailable and nothing else breaks). `EMAIL_FROM` (optional; defaults to the Resend shared sender). The comment must state the shared-domain restriction explicitly — that `onboarding@resend.dev` delivers only to the Resend account owner's address — because that is the fact a reader will need first. Free tier: 3,000/month, 100/day, 10 requests/second.

#### 3. The send module

**File**: `src/lib/email/send.ts`

**Intent**: The one place in the app that talks to a mail provider. Reads the key lazily, builds a Resend client per call, sends one message with a single abort budget, classifies any failure onto a closed union, and never throws. No database access of any kind.

**Contract**: The exported types are a signature contract Phase 2 and all three consuming slices depend on:

```ts
export type SendFailure =
  | "unconfigured"      // no RESEND_API_KEY, or the provider rejected it (401)
  | "not_permitted"     // 403 — shared sending domain, recipient is not the account owner
  | "invalid_recipient" // 422 — the address or a required field was rejected
  | "rate_limited"      // 429
  | "unavailable"       // 5xx, network failure, anything unclassified
  | "timeout";          // the abort budget expired

export type EmailMessage = { to: string; subject: string; text: string };

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; reason: SendFailure };

export async function sendEmail(message: EmailMessage): Promise<SendResult>;
```

The classifier must branch on status code before error name, per Critical Implementation Details. `import "server-only"` at the top. Constants (`TIMEOUT_MS`, the default sender) stay module-private and carry the reasoning for their values in a docblock, as `enrich.ts` does. The key read is the first statement of the function body with the same `next build` / CI rationale in a comment.

#### 4. The barrel

**File**: `src/lib/email/index.ts`

**Intent**: Public surface of the email layer, with a docblock stating that importing it pulls in `server-only` and — critically for the consuming slices — that `sendEmail` is the only sanctioned path to a provider and must never be re-exported from a `"use server"` module.

**Contract**: Re-export `sendEmail` and the three types from `./send`. Nothing else in Phase 1.

#### 5. Default-lane coverage

**File**: `test/lib/email.test.ts`

**Intent**: Prove every branch of the classifier and the never-throws guarantee without any network call.

**Contract**: Mock the `resend` module with a `vi.hoisted` transport spy, following `test/lib/ai.test.ts:1-16`. Import `@/lib/email/send` directly rather than through the barrel. `beforeEach` stubs `RESEND_API_KEY`; `afterEach` calls `vi.unstubAllEnvs()`. One case per `SendFailure` variant plus the success path; the `unconfigured` case must assert `expect(send).not.toHaveBeenCalled()` with the key stubbed to `""`. Include an explicit case where the mock rejects with a thrown error, asserting a typed result rather than a rejection. Assert the request shape — `from`, `to`, `subject`, `text` — by reaching into the spy's first call.

#### 6. The live proof

**File**: `test/smoke/email.live.ts`

**Intent**: Send one real message and confirm it was accepted, or assert the unconfigured contract when no key is present. Gated by filename, not a skip condition.

**Contract**: `.live.ts` suffix so the default glob cannot see it. Two contracts branching on key presence, mirroring `test/smoke/enrich.live.ts:54-89`: with a key, assert `ok: true` and a non-empty `id`; without, assert exactly `{ ok: false, reason: "unconfigured" }`. **Throw rather than skip** when the recipient address is missing, per `test/integration/setup.ts:11-13` — a green suite that ran nothing is worse than a red one. Recipient comes from `SMOKE_EMAIL_TO`; the error message must name that variable and state the shared-domain restriction. Write the result, including the message id and elapsed time, to a gitignored JSON file because Vitest swallows stdout for passing tests. Generous per-test timeout above the module's own budget.

**File**: `.gitignore`

**Intent**: Ignore the new smoke output file alongside the existing entry.

**Contract**: One line added next to `test/smoke/.last-result.json`, under the same comment.

### Success Criteria:

#### Automated Verification:

- `npm run test` passes, including `test/lib/email.test.ts` covering all six `SendFailure` variants and the success path
- `npm run typecheck` passes
- `npm run lint` passes
- `npm run format:check` passes
- `npm run build` passes **with no `RESEND_API_KEY` in the environment** — this is the assertion that the key is read at call time, not module scope

#### Manual Verification:

- With `RESEND_API_KEY` and `SMOKE_EMAIL_TO` (the Resend account owner's address) in `.env.local`, `npm run test:smoke -- email` passes and a real email arrives in that inbox
- With `RESEND_API_KEY` set to an empty string, the same command asserts `{ ok: false, reason: "unconfigured" }` and makes no network call
- Pointing `SMOKE_EMAIL_TO` at any address other than the account owner's yields `reason: "not_permitted"` — confirming the 403 is classified distinctly from a 422 rather than collapsed into `invalid_recipient`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase. Note that `npm run test:smoke` with no filter also runs `enrich.live.ts`, which makes real OpenRouter calls — use the `-- email` filter to run only this file.

---

## Phase 2: The ledger, and the rule written down

### Overview

Add the append-only record that makes a failed send answerable after the fact, prove its grants against real Postgres (the only lane that can), and write the choke-point rule into `AGENTS.md` so the three consuming slices inherit it.

### Changes Required:

#### 1. The ledger migration

**File**: `supabase/migrations/20260912140000_add_email_sends.sql`

**Intent**: Create an append-only record of every send attempt, plus the one function permitted to write it. Follows the `ai_enrichment_calls` precedent for RLS and atomicity, and the `close_due_auctions` precedent for access control by grant omission.

**Contract**: A header comment in the house style stating why the table has no policies and why `actor_id` is nullable.

Table `public.email_sends`: `id uuid primary key default gen_random_uuid()`, `actor_id uuid references auth.users (id) on delete cascade` (**nullable** — see Critical Implementation Details), `recipient text not null`, `kind text not null` with a length check, `status text not null check (status in ('sent', 'failed'))`, `reason text` (a `SendFailure` variant when failed), `provider_id text` (the Resend message id when sent), `created_at timestamptz not null default now()`.

An index leading with `created_at desc`, with a comment naming the query it serves (the operator's "what failed recently").

`alter table public.email_sends enable row level security;` followed by **no policies at all**, with a comment stating that the omission is deliberate and is the access control — the table is an operational record read over a direct connection, and an owner-readable policy would disclose recipients to the wrong party once S-05 exists.

Function `public.record_email_send(p_recipient text, p_kind text, p_status text, p_reason text default null, p_provider_id text default null) returns uuid`, `volatile`, `security definer`, `set search_path = ''`. It sets `actor_id` from `(select auth.uid())` **itself** and takes no actor parameter, so a caller cannot attribute a row to anyone else. Followed by `revoke execute ... from public, anon;` then `grant execute ... to authenticated;` — the revoke is not optional, because `config.toml` leaves `auto_expose_new_tables` at the cloud default and a new `public` function is born granted to `anon`, `authenticated`, `service_role` and `public`.

#### 2. Regenerate database types

**File**: `src/types/database.ts`

**Intent**: Pick up the new table and function. This file is generated and must never be hand-edited.

**Contract**: **The human runs `npm run db:types:local`** after applying the migration locally. The implementer must not run it. The file should gain an `email_sends` Row/Insert/Update block and a `record_email_send` entry under `Functions`.

#### 3. The ledger writer

**File**: `src/lib/email/record.ts`

**Intent**: Write one send attempt to the ledger. Never throws — a ledger that fails must not take down the send it was recording. Takes a Supabase client rather than constructing one, so it is usable from a Server Action, a route handler, or a script.

**Contract**: `recordSend(supabase, entry): Promise<void>`, where `entry` derives from a `SendResult` plus the recipient and kind. `import "server-only"` at the top. Calls `supabase.rpc("record_email_send", ...)` and swallows any error, following `src/lib/artworks/top-up.ts:41-43`'s belt-and-braces wrapper. The function's docblock must state that it lives here rather than beside a Server Action because every export of a `"use server"` module is a public endpoint.

**File**: `src/lib/email/index.ts`

**Intent**: Extend the barrel, and document the composition rule.

**Contract**: Additionally re-export `recordSend` and its entry type. The docblock gains one sentence: a real caller sends, then records — `sendEmail` is the gate, `recordSend` is the record, and a consuming slice is expected to call both.

#### 4. Real-boundary coverage

**File**: `test/integration/email-sends.int.ts`

**Intent**: Prove the access-control posture that the default lane provably cannot, because the default lane mocks Supabase entirely and the generated types will happily let a wrongly-privileged call type-check.

**Contract**: `requireLocalRunningStack()` in `beforeAll`; one `new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 })` for reading the table; one test user minted per file via `createTestCollector` from `test/integration/helpers.ts`. Assertions: the RPC succeeds for an authenticated caller and returns a uuid; a direct `select` from `email_sends` through that client returns no rows despite the row existing (no select policy); a direct `insert`, `update` and `delete` through that client are all refused; a read over the pool shows exactly one row whose `actor_id` equals the test user and whose `status`/`reason` match what was passed; and the RPC ignores any attempt to attribute the row elsewhere. Follows `test/integration/auction-close.int.ts`'s split — ordinary clients for what a user can do, the raw connection only for what is deliberately ungranted.

#### 5. Write the rule down

**File**: `AGENTS.md`

**Intent**: Record the conventions a future slice must follow, next to the existing "AI enrichment" section which is the closest analogue. Without this, S-04, S-05 and S-06 each re-derive a send path and the single-choke-point property is lost.

**Contract**: A new section stating: `src/lib/email/` is the only module that talks to a mail provider; `sendEmail` never throws and returns `{ ok: false, reason }`; `RESEND_API_KEY` is server-only, read inside the function never at module scope, and unset means sending degrades to unavailable while everything else keeps working; `EMAIL_FROM` defaults to the Resend shared sender, which delivers only to the account owner's address, so a custom domain is an env change not a code change; `email_sends` has no RLS policies by design and is written only through `record_email_send`; a send must never sit on the critical path of a user-visible mutation (pointing at the existing lesson in `context/foundation/lessons.md`); and which lane tests what — default for the failure matrix, integration for the ledger's grants, smoke for a real send. It should also name what F-02 deliberately left to S-04/S-05 so the next implementer does not assume it exists.

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` passes, including `test/integration/email-sends.int.ts`
- `npm run typecheck` passes against the regenerated `src/types/database.ts`
- `npm run test` still passes
- `npm run lint` and `npm run format:check` pass
- `npm run build` passes

#### Manual Verification:

- Apply the migration locally — `npx supabase db reset` — and confirm it applies cleanly in timestamp order with no error
- Run `npm run db:types:local` and confirm `src/types/database.ts` gains `email_sends` and `record_email_send`
- After the integration lane runs, `psql "$DB_URL" -c "select actor_id, recipient, kind, status, reason from public.email_sends order by created_at desc limit 5"` shows the recorded attempts — this is the failure-visibility query, and confirming it works by hand is what makes "visible rather than silent" true
- Read the new `AGENTS.md` section and confirm it would stop a future slice from building a second send path

**Implementation Note**: The two Supabase lifecycle commands above are for the human to run, per this project's standing convention — the implementer should propose them as copy-paste rather than executing them. Phase blocks use plain bullets; the `- [ ]` checkboxes live in `## Progress` at the bottom.

---

## Testing Strategy

### Unit Tests:

- Every `SendFailure` variant reached through a mocked provider, asserted by branch and by mock call count
- The `unconfigured` short-circuit, proving no network call is attempted with an empty key
- A thrown provider error returning a typed result rather than rejecting — the never-throws guarantee
- The request shape handed to the provider: `from`, `to`, `subject`, `text`
- The 403-vs-422 split asserted as two separate cases, since a single case cannot catch the collision

### Integration Tests:

- `record_email_send` accepted for an authenticated caller, returning a row id
- `email_sends` unreadable, uninsertable, unupdatable and undeletable through a Supabase client — four separate assertions, because the absence of four policies is the access control
- `actor_id` set from the session rather than from any parameter
- The recorded row's `status` and `reason` round-trip correctly

### Manual Testing Steps:

1. Put `RESEND_API_KEY` and `SMOKE_EMAIL_TO` (the Resend account owner's address) in `.env.local`
2. Run `npm run test:smoke -- email` and confirm a real email arrives, with the message id in `test/smoke/`'s output file
3. Set `RESEND_API_KEY=""` and re-run; confirm `unconfigured` and no network call
4. Point `SMOKE_EMAIL_TO` at a different address and re-run; confirm `not_permitted`, not `invalid_recipient`
5. Run `npx supabase db reset`, then `npm run db:types:local`, then `npm run test:integration`
6. Query `email_sends` over `DB_URL` and confirm the rows are there and legible

## Performance Considerations

The abort budget is 8s against Vercel Hobby's hard 10s function ceiling, on the assumption that a send will often run inside `after()` and share the invocation. There is no fallback chain and no retry, so the worst case is one 8s wait rather than a multiple of it. The ledger write is a single-row insert through an RPC and is not on any user-visible path. Resend's 10 requests/second account limit is far above anything this project will generate, and is documented in `.env.example` rather than defended in code.

## Migration Notes

One forward-only migration, additive: a new table and a new function, no change to any existing object. It is therefore safe under `vercel rollback` — a previous app build simply never calls it. Per `AGENTS.md`, pushing the migration file to `main` auto-deploys it via `.github/workflows/migrations.yml`, so the PR merge is the approval gate for the schema change.

No data migration and no backfill: there is no history of sends to record.

`RESEND_API_KEY` must be added to the Vercel project's environment before any deployed code path calls the module. Nothing in this plan deploys such a path, so the variable can be added at the same time as the first consuming slice without breaking anything — with it unset, `sendEmail` returns `unconfigured` and no caller exists to notice.

## References

- Related research: `context/changes/outbound-email-foundation/research.md` — the full option space for the deferred bridge is in its "Follow-up Research" section
- Roadmap entry: `context/foundation/roadmap.md` §"F-02: The product can send a message, once, through one gated path"
- Requirements: `context/foundation/prd-v3.md` FR-005, §Constraints, §Guardrails
- The module shape to mirror: `src/lib/ai/enrich.ts:41-188`, barrel at `src/lib/ai/index.ts`
- The ledger precedent: `supabase/migrations/20260910101500_add_enrichment_quota.sql`
- The grant-omission precedent: `supabase/migrations/20260912120000_add_auction_close.sql:129-132`
- The never-block-a-mutation rule: `context/foundation/lessons.md`, first entry
- Default-lane provider mocking: `test/lib/ai.test.ts:1-16`
- Smoke-lane gating: `test/smoke/enrich.live.ts:5-9`
- Integration-lane fixtures: `test/integration/helpers.ts`, `test/integration/setup.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: The send path, and a real email in your inbox

#### Automated

- [x] 1.1 `npm run test` passes, including `test/lib/email.test.ts` covering all six `SendFailure` variants and the success path — 5fbb180
- [x] 1.2 `npm run typecheck` passes — 5fbb180
- [x] 1.3 `npm run lint` passes — 5fbb180
- [x] 1.4 `npm run format:check` passes — 5fbb180
- [x] 1.5 `npm run build` passes with no `RESEND_API_KEY` in the environment — 5fbb180

#### Manual

- [x] 1.6 `npm run test:smoke -- email` passes with a key set, and a real email arrives in the account owner's inbox — 5fbb180
- [x] 1.7 With `RESEND_API_KEY=""`, the smoke lane asserts `{ ok: false, reason: "unconfigured" }` and makes no network call — 5fbb180
- [x] 1.8 A non-owner recipient yields `reason: "not_permitted"`, distinct from `invalid_recipient` — 5fbb180

### Phase 2: The ledger, and the rule written down

#### Automated

- [x] 2.1 `npm run test:integration` passes, including `test/integration/email-sends.int.ts`
- [x] 2.2 `npm run typecheck` passes against the regenerated `src/types/database.ts`
- [x] 2.3 `npm run test` still passes
- [x] 2.4 `npm run lint` and `npm run format:check` pass
- [x] 2.5 `npm run build` passes

#### Manual

- [x] 2.6 `npx supabase db reset` applies the migration cleanly
- [x] 2.7 `npm run db:types:local` regenerates `src/types/database.ts` with `email_sends` and `record_email_send`
- [x] 2.8 The `email_sends` query over `DB_URL` shows the recorded attempts legibly
- [x] 2.9 The new `AGENTS.md` section would stop a future slice from building a second send path
