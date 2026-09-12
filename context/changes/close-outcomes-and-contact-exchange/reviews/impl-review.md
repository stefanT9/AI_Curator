<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Close Outcomes and Contact Exchange

- **Plan**: context/changes/close-outcomes-and-contact-exchange/plan.md
- **Scope**: Phases 1–2 of 2 (full plan)
- **Date**: 2026-09-12
- **Verdict**: REJECTED at review; all 10 findings triaged and 9 fixed (F9 accepted)
- **Findings**: 3 critical, 4 warnings, 3 observations

Context for the verdict: the craft here is high. Grants, the definer posture, the three-layer
defence of the `auction_lost` payload and the injection-free cron command are all correct. The
defects sit at the edges the plan reasoned about least, not in its core.

## Triage outcome

| | |
|---|---|
| Fixed | F1 (Fix C), F2, F3, F4, F5 (Fix A), F6 (Fix B), F7, F8, F10 — 9 |
| Accepted | F9 — 1 |
| Skipped | none |

Code fixes verified: `format:check`, `lint`, `typecheck`, `test` (338 passed, up from 332) and
`build` with both drain secrets unset all pass. Five new migrations dry-run cleanly in rolled-back
transactions against the local stack. The integration lane needs a `supabase db reset` first — see
`../follow-ups/review-fixes.md`, which also carries the two env vars and the linked-project check.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | FAIL |

## Verification run

`format:check`, `lint`, `typecheck`, `test` (332 passed) and `build` with `EMAIL_DRAIN_SECRET`
unset all pass. Two cron jobs registered, both vault entries present, 8 historical `200`s in
`net._http_response`, `503 drain_unconfigured` rows proving the unset path, the stale-pending
operator query returning 0, 3 real successful sends in `email_sends`. `test:smoke` not re-run (sends
real mail); `supabase db reset` not run (operator's own command, clears the vault).

**The integration lane's 90/90 pass was a false green** — the local stack is missing migration
`20260913120200`; see F4.

## Findings

### F1 — Drain secret is readable by any signed-in user via pg_net's queue

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260913120100_schedule_email_drain.sql:64-83
- **Detail**: The cron command passes `Authorization: Bearer <secret>` to `net.http_post`, and
  pg_net persists that header in `net.http_request_queue.headers` (jsonb). Verified on the running
  local stack: schema `net` has usage granted to both `anon` and `authenticated`,
  `http_request_queue` has select granted to `authenticated`, and neither net table has RLS —
  `set role authenticated; select ... from net.http_request_queue` succeeds. That secret is not a
  second lock: it IS the access control for `claim_pending_emails`, which is granted to `anon` and
  returns plaintext recipient AND counterparty addresses. A signed-in user polling that table during
  the row's lifetime captures the secret, then harvests every queued address with only the
  publishable key. Not yet verified: whether the linked project grants the same.
- **Fix A ⭐ Recommended**: Revoke `net` from `anon`/`authenticated` in a migration
  - Strength: One migration, no redesign; closes the read at the source. Matches this schema's
    "absence is the access control" posture.
  - Tradeoff: Reaches into a Supabase-managed schema; a platform change could re-grant it.
  - Confidence: HIGH — the grant is verified present and RLS is off.
  - Blind spot: Whether anything else in the project relies on `net` being readable.
- **Fix B**: Bind the RPCs to a nonce so the secret is not worth stealing
  - Strength: Survives a future re-grant; removes a long-lived secret from a durable table.
  - Tradeoff: Real redesign of both definer functions and the drain.
  - Confidence: MEDIUM — sound, but new design work rather than a correction.
  - Blind spot: Interaction with the vault-based cron command.
- **Fix A was attempted and withdrawn.** A migration cannot revoke these grants: the grantor is
  `supabase_admin`, migrations run as `postgres`, `pg_has_role('postgres','supabase_admin','member')`
  is false and `set role supabase_admin` errors. Every `revoke` returned "no privileges could be
  revoked" and the privileges survived a rolled-back dry run. The ACLs are also wider than first
  reported: schema `net` is `=U/supabase_admin` and both net tables are `=arwdDxtm/supabase_admin`,
  so `PUBLIC` holds insert/update/delete as well as select. That is a Supabase platform default, not
  something this change introduced — what this change introduced is putting a security-critical
  secret into it.
- **Decision**: FIXED via Fix C — split the header token from the RPC secret.
  `20260913120300_split_drain_trigger_token.sql` re-registers the cron job to read a new
  `email_drain_trigger_token` vault entry; `route.ts` checks `EMAIL_DRAIN_TRIGGER_TOKEN` while
  `EMAIL_DRAIN_SECRET` stays with `drainOutbox` and never enters a header, body or URL. Docs updated
  in `.env.example`, `supabase/seed-assets/README.md` and `AGENTS.md` (a new rule binding any future
  `pg_net` caller). Verified: format/lint/typecheck/test green, and the migration applies in a
  rolled-back transaction leaving exactly one drain job.

### F2 — Transient send failures are terminal; an unset key destroys the backlog

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/email/outbox.ts:150 · supabase/migrations/20260913120000_add_email_outbox.sql:365-368
- **Detail**: Every `SendResult` with `ok:false` is marked `failed`, and `failed` is excluded from
  `claim_pending_emails` forever. The migration's justification ("a send the provider refused is a
  fact") holds only for `not_permitted`/`invalid_recipient`. The same treatment lands on
  `rate_limited`, `unavailable`, `timeout`, and on `unconfigured`, which `send.ts:104` returns
  before any request is made. A deploy with `RESEND_API_KEY` missing walks the entire queue on its
  first tick, marks everything failed, and leaves no requeue path short of hand-written SQL against
  a policy-free table. The operator's pending query shows nothing, because nothing is pending.
- **Fix**: Split terminal from transient — keep `not_permitted`/`invalid_recipient` terminal, leave
  the other four `pending` for the existing attempts ceiling, and never consume a row on
  `unconfigured`. A `deferred` branch in `mark_email_sent` writes the ledger row and leaves the
  outbox row pending.
  - Strength: Uses machinery that already exists — the ceiling is built, tested and raised to 3.
  - Tradeoff: `mark_email_sent`'s status vocabulary grows a third value; `email_sends` gains rows
    for attempts that will be retried.
  - Confidence: HIGH — the `SendFailure` union is closed and each variant is unambiguous.
  - Blind spot: Whether a repeatedly-deferred row should surface differently from an exhausted one.
- **Decision**: FIXED. `20260913120400_defer_transient_send_failures.sql` teaches `mark_email_sent`
  a third input value, `deferred`, which maps to `pending` on the outbox row and to `failed` in the
  ledger — so neither check constraint moves and the row stays visible to the operator's query.
  `src/lib/email/outbox.ts` owns the classification (`TERMINAL_FAILURES` = `not_permitted`,
  `invalid_recipient`; everything else defers), and breaks the batch immediately on `unconfigured`
  so one missing key cannot spend the whole backlog's attempt budget. `DrainSummary` gains a
  `deferred` count. Verified against the local stack in a rolled-back transaction: a deferred row
  stays `pending`, writes its ledger row, is reclaimed on the next call with `attempts` moving 1→2,
  and a `failed` row is still never reclaimed. Default suite green at 332.
- **Resolved in passing**: the drain's catch-all previously incremented `failed` while leaving the
  row `pending`, so the documented `claimed = sent + failed` invariant was arithmetically true but
  described the wrong state. It now counts `deferred`, which is exactly what the row is, and the
  invariant reads `sent + failed + deferred`.

### F3 — The integration spec contradicts the migration shipped beside it

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: test/integration/email-outbox.int.ts:526-538
- **Detail**: "does not hand the same row out twice" asserts a second claim returns zero rows, with
  a comment reading "The ceiling starts at one attempt. Phase 2 raises it". Phase 2 raised it to
  `attempts < 3` (20260913120200:66) in this same change set. With attempts at 1 after the first
  claim, the second claim returns the same four rows and the assertion fails. The raised ceiling —
  the most consequential behaviour change in Phase 2 — therefore has no coverage, and the lane is
  opt-in so CI never caught it.
- **Fix**: Rewrite as a ceiling test — claim three times asserting the rows come back each time,
  then assert the fourth returns nothing and `attempts` has settled at 3.
- **Decision**: FIXED. `email-outbox.int.ts` now has "hands a row back until the ceiling, then
  stops", walking attempts 2 and 3 and asserting the fourth claim returns nothing with the rows
  still `pending`. Two specs added for 20260913120400 besides: a `deferred` mark leaves the row
  pending while writing a `failed` ledger row, and an unknown status raises `EML02` without touching
  the row. Not yet executed — the lane needs the reset in F4 first.

### F4 — Progress 2.2 and 2.5 were checked against an incomplete migration set

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/close-outcomes-and-contact-exchange/plan.md (Progress 2.2, 2.5)
- **Detail**: `supabase_migrations.schema_migrations` tops out at `20260913120100`; the third
  migration has never been applied and `pg_proc` still holds `attempts < 1`. That is why the lane
  passed 90/90 and why F3 went unnoticed. Criterion 2.5 also reads "applies **both** migrations"
  while three now exist — its wording was never reconciled after the ceiling migration was added.
  This is lessons.md entry 2 recurring verbatim: prove each Progress item against the exact command
  or artifact it names, and never leave a step title describing something other than what shipped.
- **Fix**: Run `supabase db reset` (re-planting both vault entries after), re-run the integration
  lane, and correct 2.5's wording to three migrations.
- **Decision**: FIXED in the plan; the run is yours. Progress 2.5 is reopened and reworded to all
  five of this change's migrations, 2.2 is annotated with the migration range it actually proved,
  and a new 2.12 tracks the integration lane against the full set. The reset itself is an operator
  command — and it now needs **three** vault entries planted afterwards, not two.

### F5 — A 50-row batch can outlive the function and burn attempts it never used

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/app/api/email/drain/route.ts (no maxDuration) · src/lib/email/outbox.ts:54,129
- **Detail**: `DEFAULT_LIMIT` is 50, sends are sequential, each send's ceiling is 8s (send.ts:37) —
  worst case near 400s, past the cron's own `timeout_milliseconds` of 30000 and past any plausible
  function limit. No `maxDuration` export, no vercel.json. Because `attempts` is incremented for the
  whole batch at claim time, a function killed at row 5 leaves 45 rows pending having each burned an
  attempt never offered to a provider; three such ticks retires them.
- **Fix A ⭐ Recommended**: Lower the batch to what one invocation can finish, and set `maxDuration`
  - Strength: Smallest change; the per-minute cron means a smaller batch costs latency, not ceiling.
  - Tradeoff: A large backlog drains more slowly.
  - Confidence: HIGH — the arithmetic is not in doubt.
  - Blind spot: Haven't measured a real send's p99 against the 8s budget.
- **Fix B**: Keep the batch, break the loop on a wall-clock deadline
  - Strength: Adaptive — fast sends still clear 50 rows in one tick.
  - Tradeoff: More moving parts in a loop whose simplicity is a virtue.
  - Confidence: MEDIUM — needs a `maxDuration` to measure against anyway.
  - Blind spot: Unattempted rows still carry a consumed attempt.
- **Decision**: FIXED via Fix A. `route.ts` exports `maxDuration = 60` (route segment config, per
  `node_modules/next/dist/docs/.../maxDuration.md`) and `DEFAULT_LIMIT` drops from 50 to 5 — ~40s of
  worst-case sequential sends inside a 60s ceiling, with the arithmetic written down in both files
  so raising one number without the other is a visible mistake. A caller may still ask for more, for
  draining a backlog by hand. Two tests pin it: the `maxDuration` value, and the default `p_limit`.

### F6 — Exhausted rows sit permanently at the head of the hot index

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260913120000_add_email_outbox.sql:71-73
- **Detail**: Rows past the ceiling deliberately stay `pending`, so they remain in
  `email_outbox_pending_idx` and, being oldest, sit at the head of every `order by created_at`
  claim — re-read and discarded every minute forever. The design note treats pending as the
  operator's signal; the index pays for it.
- **Fix A ⭐ Recommended**: Add a terminal `abandoned` status
  - Strength: A better operator signal than "old and pending", and it drops the rows out of the
    partial index for free.
  - Tradeoff: Touches the status check constraint and `mark_email_sent`.
  - Confidence: HIGH — clean separation of "stuck" from "given up on".
  - Blind spot: Interacts with F2's proposed `deferred` — decide the two together.
- **Fix B**: Narrow the index predicate to `status='pending' and attempts < 3`
  - Strength: One line, no vocabulary change.
  - Tradeoff: Couples the index to the ceiling literal; raising the ceiling silently degrades it.
  - Confidence: MEDIUM — works, but hides a coupling.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix B. `20260913120500_narrow_pending_email_index.sql` rebuilds
  `email_outbox_pending_idx` with the claim's exact predicate, `status = 'pending' and attempts < 3`.
  The coupling to the ceiling literal is called out in the migration and in an index comment, with
  Fix A (`abandoned`) recorded there as the thing to revisit if the ceiling moves again.

### F7 — A broken drain is indistinguishable from a quiet minute

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/email/outbox.ts:119
- **Detail**: `if (error || !data || data.length === 0) return EMPTY;` collapses a vault
  misconfiguration (EML00), a wrong secret (EML01) and an empty queue into one 200 `{0,0,0}`. The
  migration went to deliberate trouble to make those distinguishable and nothing consumes the
  distinction, so vault drift looks exactly like a healthy idle minute in `net._http_response`.
- **Fix**: Carry a PII-free discriminator into the summary (`claim_error: "EML01"`) and answer
  non-200 on a claim error so `status_code` shows it.
- **Decision**: FIXED. `DrainSummary` gains an optional `claimError` carrying the SQLSTATE (`EML00`
  / `EML01`, or `"unknown"`), set only when the claim errored — an empty queue still returns a plain
  summary, which is the distinction being preserved. The route answers 502 when it is present
  (neither 401, about our caller, nor 503, about our configuration). A code and never a message,
  since the body lands in `net._http_response`. Four tests added across the two lanes.

### F8 — mark_email_sent has no status guard

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260913120000_add_email_outbox.sql:397-403
- **Detail**: The update matches on `id` alone, so a replay — or a retry after a write-back that
  actually committed — writes a second `email_sends` row and can flip `sent` → `failed`.
- **Fix**: Add `and o.status = 'pending'` to the `where`, making the documented lost-write-back
  retry idempotent at the ledger.
- **Decision**: FIXED, folded into `20260913120400` before it was ever applied. A replay now matches
  no row and raises `EML03` (message reworded to "no pending outbox row", since it covers both "no
  such row" and "already settled"), which the drain already swallows per-row. Integration spec added:
  re-marking a `sent` row as `failed` raises `EML03`, leaves the row `sent`, and leaves the ledger at
  one entry.

### F9 — A missing winner address suppresses the seller's notice too

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: supabase/migrations/20260913120000_add_email_outbox.sql:183-206
- **Detail**: Both contact-exchange inserts are guarded on both addresses being present, so a winner
  with no `auth.users.email` means the seller is never told their work sold, while losing bidders
  still get theirs. The plan said skip "that recipient"; the file documents the coupling and reasons
  it well. Flagged so the asymmetry is a known choice rather than an unnoticed one.
- **Fix**: Split the guard so the seller's `auction_sold` row is written whenever the seller's own
  address resolves, with the counterparty omitted — or accept and leave as documented.
- **Decision**: ACCEPTED. The coupling is reasoned in the file, the edge needs a null
  `auth.users.email`, and splitting it would need a fourth payload variant for a case that may never
  occur. Recorded so the asymmetry is a known choice.

### F10 — Two documentation drifts

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/email/outbox.ts:64 · src/app/api/email/drain/route.ts:94-95
- **Detail**: `outbox.ts:64` introduces `"unrenderable"` as an `email_sends.reason` while that
  column's comment (20260912140000:50-51) still enumerates only the six `SendFailure` variants. And
  `route.ts:94-95` uses `!` on both Supabase env vars, so a missing one throws an uncontrolled 500 —
  the file's only non-`Response.json` exit.
- **Fix**: Add a new migration commenting the widened `reason` vocabulary, and guard the two env
  vars with the same 503 shape the drain secret already uses.
- **Decision**: FIXED. `20260913120500` rewrites the `email_sends.reason` comment to name
  `unrenderable` alongside the six `SendFailure` variants and say why it is not one of them. The
  route now checks both Supabase env vars and answers the same 503 as an unset trigger token, so the
  handler has no uncontrolled exit left; both cases are pinned by tests, and the file's other cases
  stub the two vars rather than inheriting them.
