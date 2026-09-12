---
date: 2026-09-12T16:38:24+03:00
researcher: stefanT9
git_commit: 344b11f82294f24405107eb0b2609b84184c901f
branch: feat/list-artwork-for-auction
repository: artswipe
topic: "Outbound email foundation (F-02): a single gated send path for the first transactional message the product has ever sent"
tags: [research, codebase, email, notifications, rls, pg_cron, pg_net, security-definer, provider-selection]
status: complete
last_updated: 2026-09-12
last_updated_by: stefanT9
last_updated_note: "Added follow-up research on platform-native (Supabase / Vercel) paths for the DB→app bridge, with a recommended shape"
---

# Research: Outbound email foundation (F-02)

**Date**: 2026-09-12T16:38:24+03:00
**Researcher**: stefanT9
**Git Commit**: `344b11f82294f24405107eb0b2609b84184c901f`
**Branch**: `feat/list-artwork-for-auction`
**Repository**: artswipe

## Research Question

F-02 from `context/foundation/roadmap.md`: _"a single send path exists that delivers one transactional message to one address, with every caller routed through the same choke point and a failure to send visible rather than silent."_

Scoped at the user's direction to four areas: (1) the send path itself, (2) the database→app trigger bridge, (3) the FR-005 preference and one-click unsubscribe, (4) the send record / observability question. Provider selection was researched on the web as well as in the repo, because the roadmap's one open unknown for F-02 is the sending identity.

## Summary

Six findings, in descending order of how much they should change the plan.

1. **The hard wall is not the provider — it is that no code path in this project, at any privilege a Supabase client can hold, can read a recipient's email address.** `profiles.email` exists but the `select` grant to `authenticated` was revoked in the third migration and has stayed revoked ([20260909160400_public_artist_profiles.sql:15-17](supabase/migrations/20260909160400_public_artist_profiles.sql#L15-L17)) — a user cannot read that column even on their own row. The app gets its own address from JWT claims instead ([src/lib/auth/dal.ts:42](src/lib/auth/dal.ts#L42)). There is no service-role key anywhere in the runtime. So F-02's real content is not "call a mail API"; it is **deciding which single new credential or mechanism is allowed to cross that boundary**, and spending it exactly once.

2. **The two future callers have incompatible trigger topologies, and this is why F-02 must exist as a foundation rather than being folded into S-05.** S-05's trigger is a Server Action the artist is watching ([src/app/actions/auctions.ts:83-124](src/app/actions/auctions.ts#L83-L124)). S-04's trigger is `close_due_auctions`, which runs **inside Postgres** on a per-minute `pg_cron` job and is granted to _nobody_ — the absent grant is the access control ([20260912120000_add_auction_close.sql:129-132](supabase/migrations/20260912120000_add_auction_close.sql#L129-L132)). A database-triggered close cannot call Node. If F-02 does not settle the bridge, S-04 will grow its own path and the "off means off, from any path" guardrail gets three places to fail instead of one — the exact outcome F-02 exists to prevent.

3. **Every new endpoint is redirected to `/login` by default.** The proxy matcher excludes only static assets and the literal `auth/confirm` ([src/proxy.ts:15-17](src/proxy.ts#L15-L17)), and `isPublic` admits only `/`, `/login`, `/signup*` and `/auth/*` ([src/utils/supabase/proxy.ts:9-20](src/utils/supabase/proxy.ts#L9-L20)). A `/api/unsubscribe` would bounce a signed-out email click to a login page, and a `/api/drain` POST would be 307-redirected (method preserved) at a page route. Both fail as plumbing bugs, not as auth errors. Three known-good ways through, with `auth/confirm` as the precedent for the strongest one.

4. **"A failure is visible" has no precedent to copy — it is a new capability.** `grep -rn "console\." src/` returns **zero matches** repo-wide. Today an AI failure is visible only because a human is watching a form; a send has no such watcher. The only durable-failure-recording precedent in the project is the corpus manifest, and the closest schema precedent is `ai_enrichment_calls` ([20260910101500_add_enrichment_quota.sql](supabase/migrations/20260910101500_add_enrichment_quota.sql)) — whose RLS and atomicity are worth copying and whose three-column shape is not (it records attempts, not outcomes).

5. **`onboarding@resend.dev` delivers only to the Resend account owner's own address.** That restriction, which is usually an obstacle, is the answer to the roadmap's F-02 unknown here: the project has exactly one real user — the owner. F-02 can therefore be built, tested and demonstrated end to end **with no domain and no DNS decision at all**, and the sending-identity question becomes a launch-day decision rather than a blocker. Recommended provider: **Resend** (free tier 3,000/month, 100/day, HTTP API, Vercel Marketplace provisioning that injects `RESEND_API_KEY`). Runner-up: **Postmark**.

6. **The FR-005 preference probably does not belong on `profiles`.** The column-grant convention on that table is exhaustive revoke-then-grant ([20260910190000_add_profile_onboarded_at.sql:12-15](supabase/migrations/20260910190000_add_profile_onboarded_at.sql#L12-L15)), and the table-wide `select` grant is also what `"Signed-in users can read artist profiles"` rides on — so a preference column added there becomes readable by every signed-in user on every artist row. An opaque `onboarded_at` timestamp was judged acceptable that way; a notification preference carries more privacy weight. And the unsubscribe write must be performable by `anon`, which every policy on `profiles` forbids.

## Detailed Findings

### 1. The integration pattern F-02 must fit: `src/lib/ai/`

The project has exactly one module that talks to a third party, and it is a deliberate, well-documented template. A new `src/lib/email/` should mirror it structurally.

**Barrel discipline.** [src/lib/ai/index.ts:1-7](src/lib/ai/index.ts#L1-L7) is a pure re-export whose docblock explains that importing it pulls in `server-only`; the one piece of pure data carries a counter-instruction to import it directly ([src/lib/ai/taxonomy.ts:14-17](src/lib/ai/taxonomy.ts#L14-L17)), and two client components honour that ([src/components/onboarding/StyleTermPicker.tsx:4](src/components/onboarding/StyleTermPicker.tsx#L4), [src/lib/onboarding/terms.ts:15](src/lib/onboarding/terms.ts#L15)). Internal constants — `MODELS`, `MAX_RETRIES`, `TIMEOUT_MS`, `PROMPT` — are module-private and never re-exported.

**The result shape is a closed union, and that is load-bearing.** [src/lib/ai/enrich.ts:68-76](src/lib/ai/enrich.ts#L68-L76):

```ts
export type EnrichmentFailure =
  | "unconfigured" | "timeout" | "rate_limited" | "unavailable" | "invalid_response";

export type EnrichmentResult =
  { ok: true; data: Enrichment } | { ok: false; reason: EnrichmentFailure };
```

`reason` is exhaustively mapped to user copy via `Record<EnrichmentFailure, string>` at [src/app/actions/enrichment.ts:37-46](src/app/actions/enrichment.ts#L37-L46), so adding a variant is a type error until copy exists for it. A `SendFailure` union should be built the same way. Note the two-layer shape: the typed `reason` never crosses to the browser — the action translates it into `SuggestionState` ([src/app/actions/enrichment.ts:16-18](src/app/actions/enrichment.ts#L16-L18)).

**"Never throws" is by construction, not enforced.** The `try/catch` wraps only the fallback-loop body ([src/lib/ai/enrich.ts:157-185](src/lib/ai/enrich.ts#L157-L185)); `createOpenRouter(...)` at [:152](src/lib/ai/enrich.ts#L152) and `AbortSignal.timeout(...)` at [:153](src/lib/ai/enrich.ts#L153) are outside it, as is module-load failure. The project compensates at the swallowing caller with a belt-and-braces wrapper ([src/lib/artworks/top-up.ts:41-43](src/lib/artworks/top-up.ts#L41-L43)), pinned by a test that rejects the mock ([test/lib/top-up.test.ts:56-60](test/lib/top-up.test.ts#L56-L60)). Any `sendEmail` making the same promise needs the same belt.

**The env-read discipline, verbatim** ([src/lib/ai/enrich.ts:147-150](src/lib/ai/enrich.ts#L147-L150)):

```ts
  // Read lazily, never at module scope: `next build` imports this file and CI
  // has no key. An unset key must degrade at call time, not break the build.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "unconfigured" };
```

The falsy check means `""` counts as unset, which is what lets [test/lib/ai.test.ts:120](test/lib/ai.test.ts#L120) assert the unconfigured path via `vi.stubEnv(..., "")`.

**Budget constants carry their measurement.** `TIMEOUT_MS = 25_000` at [:66](src/lib/ai/enrich.ts#L66) with the history at [:55-65](src/lib/ai/enrich.ts#L55-L65) (planned 12s, raised after live measurement); `MAX_RETRIES = 0` at [:53](src/lib/ai/enrich.ts#L53) because SDK retries would nest inside the shared timeout. One `AbortSignal` created before the loop makes the budget whole-chain rather than per-attempt. An email send needs a much smaller budget and should state it the same way.

**Never on the critical path.** This is a recorded lesson (`context/foundation/lessons.md`, first entry) and the post-fix arrangement is [src/app/actions/artworks.ts:178-195](src/app/actions/artworks.ts#L178-L195) — the row is inserted first, then `after()` from `next/server` defers the model call past the response. The lesson's rule generalises verbatim from "AI call" to "third-party call", so a send belongs in `after()` or behind a queue, never awaited inside the mutation.

**Helpers stay out of `"use server"` modules.** [src/lib/artworks/top-up.ts:16-18](src/lib/artworks/top-up.ts#L16-L18) states why: every export of such a module is a callable endpoint. The same argument, applied to email, is sharper — an exported `sendEmail` would be a POST endpoint any authenticated user could use to send mail on the project's provider quota. The quota migration was written for exactly this threat model ([src/app/actions/enrichment.ts:59-65](src/app/actions/enrichment.ts#L59-L65)).

**Config conventions.** `.env.example` is the single tracked env document (`.gitignore` allows exactly `.env*` + `!.env.example`), and it documents variables destined for _other_ files too — `PUSH_*` vars live there even though they belong in `.env.push.local`. The convention for a second scope is **different variable names**, not a second file with the same names, so a wrong env file cannot silently take effect. Note: `.env.push.example` exists on disk but is gitignored and stale; do not create a `.env.email.example`, it would be silently ignored the same way. Add an email block to `.env.example` following the `OPENROUTER_API_KEY` comment template (purpose, "Server-only: deliberately NOT NEXT_PUBLIC_", what degrades when unset, provider rate limits).

### 2. The hard wall: nobody can read a recipient's address

`profiles.email` exists ([20260909144939_add_user.sql:5](supabase/migrations/20260909144939_add_user.sql#L5)) and is populated by a `security definer` trigger from `auth.users` ([:32-49](supabase/migrations/20260909144939_add_user.sql#L32-L49)). But [20260909160400_public_artist_profiles.sql:11-17](supabase/migrations/20260909160400_public_artist_profiles.sql#L11-L17) narrows the read to specific columns:

```sql
-- That policy is row-level, so on its own it would hand out the artist's email
-- along with their name. Column grants are the only thing that scopes a SELECT
-- to specific columns — nothing in the app reads `email` out of this table
-- (the signed-in user's own address comes from their JWT claims).
revoke select on public.profiles from authenticated;
grant select (id, display_name, role, created_at, updated_at)
  on public.profiles to authenticated;
```

Re-issued with `onboarded_at` added at [20260910190000_add_profile_onboarded_at.sql:27-29](supabase/migrations/20260910190000_add_profile_onboarded_at.sql#L27-L29). `email` has never been on the list.

Corroborating evidence that this is enforced discipline and not an accident:

- Every `profiles` read in the codebase selects an explicit narrow column list, never `*` — [src/lib/auth/dal.ts:74](src/lib/auth/dal.ts#L74), [src/lib/artworks/queries.ts:33-35](src/lib/artworks/queries.ts#L33-L35), [src/lib/auctions/queries.ts:45-47](src/lib/auctions/queries.ts#L45-L47).
- Both query modules explain why they avoid a PostgREST embed: _"`email` is withheld from `profiles` at the column-grant level, so the columns an embed may select are constrained in a way that is easier to state explicitly than to infer"_ ([src/lib/artworks/queries.ts:18-22](src/lib/artworks/queries.ts#L18-L22)).
- The type system encodes it — `ArtistSummary` is hand-written specifically so the app cannot assume it has an address ([src/types/domain.ts:18-27](src/types/domain.ts#L18-L27)).
- No service-role key exists in any runtime path. Both client factories read only the publishable key ([src/utils/supabase/server.ts:5-6](src/utils/supabase/server.ts#L5-L6), [src/utils/supabase/proxy.ts:5-6](src/utils/supabase/proxy.ts#L5-L6)). `.env.example` prohibits one three times; the push script actively refuses one ([scripts/build-corpus.ts:2198](scripts/build-corpus.ts#L2198)). `.env.local` / `.env.test.local` contain `SERVICE_ROLE_KEY` only because they are verbatim `supabase status -o env` dumps — no code reads either variable.

**And the recipient _set_ is equally unreadable.** `interactions` has owner-only policies and — unlike `artworks` and `auctions`, which both have `using (true)` read policies — **no blanket-read policy at all** ([20260909160200_add_interactions.sql:24-27](supabase/migrations/20260909160200_add_interactions.sql#L24-L27)). So "who liked this artwork" is invisible to everyone including the artwork's own artist. `bids` is the same, and that migration already anticipated this: _"S-03's close will run security definer and bypass RLS, so withholding the read here blocks no later slice"_ ([20260911190000_add_bids.sql:20-21](supabase/migrations/20260911190000_add_bids.sql#L20-L21)).

**Consequence:** resolving recipients requires a `security definer` function no matter where the send lives. `swipe_deck` is explicitly `security invoker` ([20260909160200_add_interactions.sql:48-49](supabase/migrations/20260909160200_add_interactions.sql#L48-L49)) and is therefore _not_ the model; the definer inventory to follow instead is `handle_new_user`, `private.is_artist`, `claim_enrichment_slot`, `create_auction`, `cancel_auction`, `place_bid`, `close_due_auctions` — every one of them `set search_path = ''` with an explicit `revoke`-then-`grant`, because `config.toml` leaves `auto_expose_new_tables` at the cloud default and a new `public` function is born granted to `anon`, `authenticated`, `service_role` and `public`.

**One data-integrity trap.** `handle_new_user` is `after insert` only — there is no `after update of email` trigger. So `profiles.email` is a **signup-time snapshot** that drifts if a user changes their address through Supabase's email-change flow. `auth.users.email` is the source of truth. A definer recipient function should read `auth.users`, or the project should add the missing update trigger.

### 3. The bridge: a close that happens inside Postgres

**What the close is.** [20260912120000_add_auction_close.sql:87-127](supabase/migrations/20260912120000_add_auction_close.sql#L87-L127) defines `close_due_auctions(p_now timestamptz default now()) returns integer`, `security definer`, `set search_path = ''`, as one CTE-driven `update` with `for update skip locked`. It is scheduled per-minute by [20260912120100_schedule_auction_close.sql:32-36](supabase/migrations/20260912120100_schedule_auction_close.sql#L32-L36).

**It is granted to nobody, deliberately** ([:129-132](supabase/migrations/20260912120000_add_auction_close.sql#L129-L132)):

```sql
-- Deliberately no `grant` after this -- see the comment above. The absence is
-- the access control.
revoke execute on function public.close_due_auctions(timestamptz)
  from public, anon, authenticated, service_role;
```

with the rationale at [:51-64](supabase/migrations/20260912120000_add_auction_close.sql#L51-L64) naming the only callers left: _"the cron job (running as `postgres`, which owns this function) and a direct postgres connection."_

**A trap worth writing into the plan.** `close_due_auctions` nonetheless appears in the generated types ([src/types/database.ts:281](src/types/database.ts#L281)) — generation reflects the catalog, not the grants. So `supabase.rpc("close_due_auctions")` from a Server Action **type-checks and passes `lint`/`typecheck`/`build`**, then fails at runtime with a permission error. The same will be true of any definer recipient function granted to nobody.

**What already exists that an outbox can hang off.** `closed_at` is written exactly once and never moved — the integration lane pins this and says so explicitly: a second sweep returns `0` and `closed_at` does not move, _"a re-close would move it, and S-04 will trigger on that timestamp being written exactly once"_ ([test/integration/auction-close.int.ts:339-352](test/integration/auction-close.int.ts#L339-L352)). There is also a partial-index precedent for exactly this shape of drain query ([20260912120000_add_auction_close.sql:36-38](supabase/migrations/20260912120000_add_auction_close.sql#L36-L38)):

```sql
create index auctions_due_close_idx on public.auctions (ends_at)
  where closed_at is null and cancelled_at is null;
```

A `closed_at is not null and notified_at is null` drain set needs its own partial index for the symmetric reason. And because the close's `update ... from winners w` already computes the whole notification payload in one statement, an outbox insert can ride inside that same transaction with no extra scan.

What does **not** exist: `grep -rn -i -E "notified_at|outbox|unsubscribe"` over `src/`, `supabase/migrations/`, `scripts/`, `test/` finds nothing relevant. No outbox table, no queue, no send record, no notified flag.

**What Postgres can actually do here.** Verified against the local stack:

- **Installed:** `pg_cron`, `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`. `grep -rn -i "create extension" supabase/migrations/` returns exactly one line — `create extension if not exists pg_cron` ([20260912120100:26](supabase/migrations/20260912120100_schedule_auction_close.sql#L26)).
- **Available but not installed:** `pg_net` 0.20.4, `http` 1.6, `pgmq` 1.5.1, `pg_tle` 1.4.0.
- **Database-webhook machinery is present but non-functional:** the `supabase_functions` schema holds `hooks`, `migrations` and the trigger function `http_request()`, whose body calls `net.http_get`/`net.http_post` — so a webhook raises _"schema net does not exist"_ until `pg_net` is installed. No project trigger uses it.
- `[edge_runtime] enabled = false` in `supabase/config.toml` and there is **no `supabase/functions/` directory** — Edge Functions are net-new and a second runtime.

So `pg_net` and database webhooks are both net-new migrations. The house style for adding an extension is established and explicit — no guard, fail loudly ([20260912120100:19-25](supabase/migrations/20260912120100_schedule_auction_close.sql#L19-L25)).

**Scheduling options.** No `vercel.json` and no `vercel.ts`. The pg_cron migration forbids substituting Vercel cron for the close, and says why ([:8-13](supabase/migrations/20260912120100_schedule_auction_close.sql#L8-L13)): _"Vercel Hobby cron was ruled out and cannot be substituted here -- it fires at most once a day, anywhere inside its scheduled hour... Do not 'simplify' this into a `vercel.ts` cron entry."_ That verdict is scoped to a per-minute latency requirement; an email drain has a different tolerance, so quote the verdict and its reason separately rather than over-applying it. GitHub Actions has two workflows, `verify.yml` and `migrations.yml`, **neither scheduled** — though `migrations.yml` already proves out `workflow_dispatch` plus a `production` environment holding DB credentials, which is a usable drain trigger with real limits (5-minute cron minimum, best-effort, auto-disabled after 60 days of repo inactivity, and a second deploy-coupled scheduler alongside pg_cron).

**The option space, and what each one spends:**

| Bridge | Status here | What it costs |
| --- | --- | --- |
| pg_cron → definer function | **in use**, the only scheduler | stays inside Postgres; cannot reach Node at all |
| `pg_net` → app route handler | available, not installed | new extension + a secret in `vault`; fire-and-forget (response lands in `net._http_response`, nothing to await); needs a proxy-exempt endpoint |
| `pg_net` → provider API directly | available, not installed | no Node in the path at all — but the send path is then SQL, so no templating, no typed failure, untestable in the default lane, and "one gated path" stops being an app-level promise |
| Database webhook (`supabase_functions.http_request`) | machinery present, **requires pg_net** | per-row trigger semantics on a set-based sweep |
| `http` extension (synchronous) | available, not installed | the sweep's duration becomes a function of the provider's latency |
| `pgmq` | available, not installed | a queue that still needs a drain caller |
| Supabase Edge Function | net-new, runtime disabled | a second runtime (Deno); would not be the Node send path |
| Route handler + direct `pg` connection | `pg` is already a devDependency; `DB_URL` precedent exists in the integration lane | the app would hold superuser DB credentials — arguably a larger privilege than the service-role key the project refuses |
| Scheduled GitHub Action | no scheduled workflow yet; secrets precedent exists | best-effort 5-min cron, second scheduler, drain lives outside the app |
| Poll from the app (status quo) | `getMyClosedAuctions` already reads closed outcomes ([src/lib/auctions/queries.ts:166](src/lib/auctions/queries.ts#L166)) | no send at all |

**The app-side caller, for contrast.** `createAuction` ([src/app/actions/auctions.ts:83-124](src/app/actions/auctions.ts#L83-L124)) runs `requireArtist()` → Zod → `rpc("create_auction")` → `revalidatePath` ×2 → `redirect("/auctions")`. A send would have to be inserted between the RPC error check and the revalidates: **not after the `redirect`**, because `redirect()` throws `NEXT_REDIRECT` and nothing after it runs — and a `try/catch` around that region would swallow the redirect's control flow. Note also that `AuctionFormState` ([:11-19](src/app/actions/auctions.ts#L11-L19)) has no channel for partial success: "listed, but notification failed" would either be swallowed or misreported as a listing failure. And `createAuction` is the wrong place to _resolve_ recipients anyway — it runs as the artist under RLS, who can read neither the likers nor anyone's address.

### 4. Every new endpoint is behind the login redirect

[src/proxy.ts:15-17](src/proxy.ts#L15-L17):

```js
matcher: [
  "/((?!_next/static|_next/image|favicon.ico|auth/confirm|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
],
```

[src/utils/supabase/proxy.ts:9-20](src/utils/supabase/proxy.ts#L9-L20):

```js
const PUBLIC_PATHS = ["/", "/login"];
const isPublic = (pathname: string) =>
  PUBLIC_PATHS.includes(pathname) ||
  pathname === "/signup" ||
  pathname.startsWith("/signup/") ||
  pathname.startsWith("/auth/");
```

and the redirect at [:54-60](src/utils/supabase/proxy.ts#L54-L60). Tracing `/api/unsubscribe`: the matcher's lookahead does not exclude it, `isPublic` is false on all four clauses, `isSignedIn` is false for an email click → redirect to `/login?next=/api/unsubscribe`, handler never runs. For a machine POST it is worse: `NextResponse.redirect` defaults to 307, which preserves the method, so the POST is re-issued against a page route. Also note every intercepted request costs a `supabase.auth.getClaims()` round trip before any path check ([src/utils/supabase/proxy.ts:49](src/utils/supabase/proxy.ts#L49)).

Three ways through, weakest to strongest:

1. **Put it under `/auth/`** — already public via the `startsWith("/auth/")` clause, no code change. Proxy still runs (session refresh, `getClaims()`). Cheapest; semantically odd for a drain.
2. **Add the path to `PUBLIC_PATHS`** or a new `isPublic` clause — explicit, one line, proxy still runs.
3. **Exclude it from the matcher**, the way `auth/confirm` is — the _only_ option that skips the proxy entirely (no `getClaims()`, no cookie writing). This is the right shape for a machine-to-machine endpoint authenticating by shared secret, and `auth/confirm`'s exclusion is the stated precedent for "this route does its own thing with credentials."

**The only existing route handler** is [src/app/auth/confirm/route.ts](src/app/auth/confirm/route.ts) — 32 lines, `GET` only, hand-rolled validation (not Zod, a deviation from the AGENTS.md rule that a new handler should _raise_ rather than match), no try/catch, no status codes, every failure falling through to one generic redirect at `/auth/auth-code-error`. Two patterns in it are directly reusable for a token link: it **blanks the query string before redirecting** — _"Never carry token_hash forward — it would end up in browser history and in the Referer header of the next page's requests"_ ([:22-23](src/app/auth/confirm/route.ts#L22-L23)) — and it validates `next` with `startsWith("/") && !startsWith("//")` against open redirects ([:25](src/app/auth/confirm/route.ts#L25)).

### 5. The FR-005 preference: where it goes

**The column precedent** is [20260910190000_add_profile_onboarded_at.sql](supabase/migrations/20260910190000_add_profile_onboarded_at.sql): a nullable `timestamptz` (justified over `boolean default false`), **no backfill** (justified — a blanket backfill would permanently exclude the accounts the change exists to serve), **no policy change** (the existing own-row update policy already scopes the write), and **both grants re-issued in full**. That last rule is stated as the convention at [:12-15](supabase/migrations/20260910190000_add_profile_onboarded_at.sql#L12-L15): _"Both grants on this table are exhaustive revoke-then-grant statements, so a new column is invisible and unwritable until each is re-issued in full."_

**But `profiles` is a questionable home for this particular column**, for two reasons the precedent itself surfaces:

- The table-wide `select` grant is what `"Signed-in users can read artist profiles"` ([20260909160400:6-9](supabase/migrations/20260909160400_public_artist_profiles.sql#L6-L9)) rides on. The onboarding migration noticed this and accepted it for an opaque timestamp. A notification preference readable by every signed-in user on every artist row is a different proposition.
- Every policy on `profiles` is `to authenticated`. A one-click unsubscribe is clicked by someone who is **not signed in**, so the write cannot go through those policies at all — it needs a definer function, and today `anon` is revoked from every function in the schema.

A separate owner-only table, or a definer function that owns both the read and the write, both avoid this. Either way, **the "off means off" enforcement point should be the `where` clause of the definer recipient function**, not a policy — because a definer function is already mandatory (§2), so putting the preference filter inside it makes the guardrail structural in exactly one place. That is the posture the auction migrations already take: _"one conditional update whose where clause **is** [the] rule"_ ([20260911120000_add_auctions.sql:143-144](supabase/migrations/20260911120000_add_auctions.sql#L143-L144)).

**The app-side mutation pattern to follow** is [src/app/actions/profile.ts](src/app/actions/profile.ts): module-level `const XSchema = z.object(...)` with user-facing `{ error: ... }` on every rule → `requireProfile()` first → `safeParse` → `z.flattenError(...).fieldErrors` on failure → `await createClient()` → `.update().eq("id", profile.id)` → error returns `{ message }` rather than throwing → `revalidatePath("/", "layout")`. The comment at [:33-36](src/app/actions/profile.ts#L33-L36) is the one a preference action should mirror, about RLS plus the column grant making the endpoint unforgeable. For non-form callers, `InteractionResult` ([src/app/actions/interactions.ts:9](src/app/actions/interactions.ts#L9)) is the typed-args precedent.

### 6. The unsubscribe token is net-new

**`verifyOtp` cannot carry it.** `EmailOtpType` is Supabase's closed set (`signup`, `invite`, `magiclink`, `recovery`, `email_change`, `email`), it mints a **session** on success, and it cannot express an arbitrary payload. Using it for unsubscribe would silently sign the clicker in — strictly worse than an unauthenticated preference write. It is also rate-limited (`token_verifications` 30 per 5 min per IP).

**No signing utility exists.** `package.json` has no `jose`, no `jsonwebtoken`, no signing library. `grep` across `src/`, `test/`, `scripts/` finds only `crypto.randomUUID()` for storage keys ([src/lib/artworks/upload.ts:62](src/lib/artworks/upload.ts#L62)) and `createHash` for corpus content hashing ([scripts/build-corpus.ts:45](scripts/build-corpus.ts#L45)). `node:crypto`'s `createHmac` + `timingSafeEqual` needs no new dependency and `build-corpus.ts` already establishes `node:crypto` as an acceptable import.

Two shapes, neither with in-repo precedent:

1. **Stateless HMAC** over `{ userId, preference, issuedAt }`, keyed by a new server-only env var read inside the function per the `OPENROUTER_API_KEY` discipline. No table, no cleanup; revocation is impossible without rotating the key.
2. **Stateful opaque token** — a table of random UUIDs consumed by a definer function granted to `anon`. Single enforcement point in the DB; adds a table and a cleanup concern, and is the one place `anon` would need a grant.

Either way the _write_ belongs in a definer function, consistent with [20260911120000_add_auctions.sql:52-54](supabase/migrations/20260911120000_add_auctions.sql#L52-L54) (_"Deliberately no insert, update, or delete policy. Both mutations go through ... which are security definer and re-verify auth.uid() themselves"_).

**Is one-click unsubscribe actually required?** Two separate questions, and they have different answers.

- **As a product requirement: yes, unconditionally.** FR-005 says so, and §Scope of Change records that FR-003 was _revised_ to be conditioned on it because "a like was never consent to be emailed". This is not negotiable on deliverability grounds.
- **As a mailbox-provider compliance requirement: not yet, and possibly never at this scale.** RFC 8058 (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) has been required by Gmail and Yahoo since February 2024 **for bulk senders — 5,000+ messages per day** to personal accounts at their domains. Genuinely transactional mail (password resets, receipts, shipping notices) is exempt. This project will not approach 5,000/day. However: an FR-004 taste-match notification about a piece the collector never engaged with is much closer to promotional than transactional, and the PRD already names this as _"the FR most likely to get the app's mail marked as spam, which would poison auth email too"_. Setting `List-Unsubscribe` and `List-Unsubscribe-Post` headers is harmless where not required and cheap to add, and the 48-hour honour window is trivially met by a synchronous preference write. Recommendation: set both headers from the start, and note that RFC 8058 requires the endpoint to act on a **POST without any confirmation step** — which interacts directly with §4 above, since a POST is exactly what the proxy 307-redirects.

### 7. "Visible rather than silent" is the part with no precedent

`grep -rn "console\." src/` → **zero matches**. There is no logger, no logging helper, and `eslint.config.mjs` has no `no-console` rule, so the absence is convention rather than enforcement. The only `console.*` outside `scripts/` lives in the smoke lane ([test/smoke/enrich.live.ts:55-58](test/smoke/enrich.live.ts#L55-L58)).

Today, a third-party failure is visible only where a human is watching a form. [src/lib/artworks/top-up.ts:33](src/lib/artworks/top-up.ts#L33) and [:41-43](src/lib/artworks/top-up.ts#L41-L43) discard the reason entirely. The one place a reason is durably recorded is the corpus manifest, and its rationale is exactly the argument for a send record ([scripts/build-corpus.ts:1356-1359](scripts/build-corpus.ts#L1356-L1359)): _"Recorded, not thrown. An empty array plus a reason is a pinned outcome: the piece is skipped by the next run rather than retried forever."_

Also worth copying from that script: it **pre-flights the config once** rather than discovering `unconfigured` per item ([:1559-1566](scripts/build-corpus.ts#L1559-L1566)) — _"without the key `enrichFromImage` returns `unconfigured` for every call, and the run would pin a thousand failures in seconds and look like it had done its job."_ A batch send needs the same pre-flight.

**The schema precedent is `ai_enrichment_calls`** ([20260910101500_add_enrichment_quota.sql](supabase/migrations/20260910101500_add_enrichment_quota.sql)). Copy its RLS and atomicity:

- Append-only enforced by **policy omission** — insert and select only, no update, no delete, with the reason stated in the header.
- `(select auth.uid())` subselect idiom throughout.
- An index leading with the query's first predicate, with a comment naming the query it serves.
- Check-and-insert in **one** `volatile security definer` function so two concurrent callers cannot both pass the check, with limits as **function parameters with defaults** rather than literals, so they are tunable per call site without a migration.
- `revoke execute ... from public, anon;` then `grant execute ... to authenticated;`.

Do **not** copy its column list — three columns with no outcome and no reason. It records that a slot was claimed, not what happened. A send record needs at least recipient, kind, provider message id, status and failure reason, precisely because visibility is the goal here and was not the goal there. Note there is no integration test of `claim_enrichment_slot` against real Postgres — a gap worth not repeating, since an append-only property and an atomicity property are both only provable against a real database.

### 8. Provider landscape and recommendation

| Provider | Free / entry tier | Domain required to send? | Notes |
| --- | --- | --- | --- |
| **Resend** | 3,000/month, **100/day**, 3 verified domains, 10 req/s | **No** — `onboarding@resend.dev` works, but delivers **only to the account owner's own address** (403 otherwise) | HTTP API + SDK returning a result object rather than throwing; Vercel Marketplace integration injects `RESEND_API_KEY` |
| **Postmark** | Free developer plan, **100/month**, no expiry | Yes for arbitrary recipients | Strong transactional reputation; enforces separate message streams for transactional vs broadcast, which aligns with the auth-poisoning concern |
| **AWS SES** | Sandbox: 200/24h, 1 msg/s | Sandbox sends **only to verified addresses**; production access is a request | Cheapest at volume, most setup; a poor fit for a 3-week budget |
| **SendGrid / Mailgun** | Trial-based, varies | Yes | No advantage here over the two above |
| **Supabase built-in auth email** | **2 per hour**, explicitly not for production | n/a | Not a candidate for notifications. Already configured in `supabase/config.toml` as `[auth.rate_limit] email_sent = 2` |
| **Supabase custom SMTP** | Provider's own limits; Supabase initially caps custom SMTP at 30/hour | Provider's requirement | Relevant later, for moving _auth_ email off the built-in service — not a path for notifications |

**Recommendation: Resend.** The deciding reasons are specific to this project:

- **It dissolves the roadmap's blocking-ish unknown.** The `resend.dev` restriction — delivery only to the account owner's address — is normally a limitation. Here, the project has exactly one real user, the owner. So F-02 can be built, smoke-tested and demonstrated end to end with **no domain, no DNS, and no sending-identity decision**, which moves that question to launch day. Nothing else on the list offers this: Postmark's free tier is 100/month total, and SES's sandbox needs each recipient verified.
- **The free tier is the right shape.** 3,000/month is far beyond this project's volume; the binding constraint is 100/day, which is still an order of magnitude above a demo.
- **HTTP API, not SMTP-only.** That keeps the `pg_net`-from-Postgres bridge open as an option instead of foreclosing it.
- **The SDK fits the existing wrapper shape.** Resend's Node SDK returns a result object with `data`/`error` rather than throwing, which maps almost directly onto `{ ok, reason }` — verify the exact shape against the installed version before relying on it. Nothing already in `package.json` can be reused; this is one new dependency, or zero if the HTTP API is called with `fetch`.
- **Vercel Marketplace provisioning** creates the account, injects `RESEND_API_KEY` into the project's env, and can configure DNS. Note the CLI is not installed on this machine and the Vercel MCP server is unauthorized in this session, so this would be done through the dashboard.

**Runner-up: Postmark**, if the 100/month cap is acceptable for the whole of F-02 + S-04 + S-05 development. Its message-stream separation is a real structural answer to the auth-poisoning risk.

**On the auth-email-poisoning risk.** Mailbox providers score the sending domain, and a subdomain builds its own reputation — but it also inherits from, and can damage, the organisational domain. The 2026 consensus is two subdomains from the start, one transactional and one marketing, each with its own SPF/DKIM/DMARC and its own warm-up. Applied here: if and when a custom domain is introduced, auction notifications should send from a dedicated subdomain distinct from whatever carries auth email. Today auth email goes through Supabase's built-in service, which is a different sending domain entirely — so **the two streams are already separated, and the risk only becomes live when a custom domain is configured.** That is an argument for deferring the domain decision, not for rushing it.

**Local development has a path that needs no provider at all.** `supabase/config.toml` has `[local_smtp] enabled = true` on port 54324 (the capture UI), with `smtp_port` / `pop3_port` commented out. Uncommenting `smtp_port` gives a local SMTP sink an integration test could read — worth knowing, though it only exercises SMTP, not the provider's HTTP API.

### 9. Test strategy across the three lanes

The three lanes are written standalone rather than via `mergeConfig`, and the reason is stated twice ([vitest.smoke.config.mts:12-15](vitest.smoke.config.mts#L12-L15)): merging concatenates `include` arrays, which would drag the mocked suite into every smoke run. `server-only` is aliased to [test/stubs/server-only.ts](test/stubs/server-only.ts) in all three.

**Default lane — `test/lib/email.test.ts`**, mirroring [test/lib/ai.test.ts](test/lib/ai.test.ts). Three moves to copy: `vi.hoisted` for the transport spy (because `vi.mock` factories are hoisted above module-level `const`s); **partial** mock via `importOriginal` spread so the provider's real error classes survive and the classifier is genuinely exercised; the provider factory fully faked. Then assert the whole failure matrix by mock **call count**, plus request shape via `spy.mock.calls[0][0]`, with `beforeEach` `vi.stubEnv` / `afterEach` `vi.unstubAllEnvs`.

**Default lane — action tests**, mirroring [test/actions/enrichment.test.ts](test/actions/enrichment.test.ts): mock `@/lib/email` at the barrel, mock the DAL and `@/utils/supabase/server` as a duck type, and pin the ordering invariants — auth gate first, Zod before any quota claim, quota refusal before any send, typed reason → user copy. Plus a `top-up.test.ts`-style test that the never-throws promise holds under `mockRejectedValue(new Error("boom"))`.

**Integration lane — `test/integration/email.int.ts`.** This lane never calls external providers; it tests the database half. The model is [test/integration/auction-close.int.ts](test/integration/auction-close.int.ts): `requireLocalRunningStack()` in `beforeAll`, `new Pool({ connectionString: requireLocalDatabaseUrl(), max: 1 })`, fixtures built through ordinary RLS-bound clients, and the raw connection used **only** for the deliberately ungranted call. Mint one set of users per file (`[auth.rate_limit] sign_in_sign_ups` is 30 per 5 min per IP). The assertions that matter: outbox rows appear as a **side effect of one real sweep** rather than being fabricated; a second sweep adds **zero** rows and does not move `closed_at`; the append-only property holds under real RLS; and a recipient function excludes an opted-out collector. If the outbox table follows this project's stance (grants revoked), no Supabase client will see it — read it over the pool, and say so in the migration the way `close_due_auctions` says it.

**Smoke lane — `test/smoke/email.live.ts`.** Gated by **filename**, not a skip condition — `.live.ts` is invisible to the default glob. And it must **throw rather than skip** when unconfigured, per the stated stance ([test/integration/setup.ts:11-13](test/integration/setup.ts#L11-L13)): _"a skipped suite reports green and a green suite that ran nothing is worse than a red one."_ Follow `enrich.live.ts`'s two-contract shape: with the key set, assert a real send returns `ok: true` and a provider message id; with it empty, assert exactly `{ ok: false, reason: "unconfigured" }`. Write the result to a gitignored `test/smoke/.last-*.json` because Vitest swallows stdout for passing tests. With Resend's shared domain, the recipient here is the account owner's own address — which is exactly what the lane is for.

**One asymmetry to plan for.** If the bridge is `pg_net`, `net.http_post` is asynchronous and fire-and-forget: it returns a `request_id` and the response lands later in `net._http_response`. There is nothing to await inside a transaction, so a test must poll. That is a materially worse testability profile than anything else in this repo, and it is a legitimate reason to prefer a drain the app controls.

## Code References

- `src/lib/ai/enrich.ts:68-76` — the `{ ok, reason }` result type with a closed failure union; the shape `SendResult` should copy
- `src/lib/ai/enrich.ts:147-150` — the lazy env read, with the `next build` / CI rationale in-comment
- `src/lib/ai/enrich.ts:157-185` — the try/catch-inside-the-loop that makes "never throws" true by construction
- `src/lib/ai/index.ts:1-7` — barrel discipline and the server-only contamination note
- `src/lib/artworks/top-up.ts:16-18` — why a helper lives in `src/lib/` rather than beside a `"use server"` export
- `src/lib/artworks/top-up.ts:41-43` — the belt-and-braces wrapper at a swallowing caller
- `src/app/actions/artworks.ts:178-195` — `after()` keeping a third-party call off a mutation's critical path
- `src/app/actions/enrichment.ts:37-46` — `Record<Failure, string>` making an unmapped reason a type error
- `src/app/actions/enrichment.ts:59-65` — the threat model for a send-triggering `"use server"` export
- `src/app/actions/auctions.ts:83-124` — S-05's trigger point; the send must land before `redirect()`
- `src/app/actions/profile.ts:21-72` — the canonical Zod-validated profile mutation
- `src/app/auth/confirm/route.ts:22-25` — query-blanking before redirect, and the open-redirect guard
- `src/proxy.ts:15-17` — the matcher; the only path-level exclusion is `auth/confirm`
- `src/utils/supabase/proxy.ts:9-20` — `isPublic`; `/auth/*` is already reachable signed out
- `src/utils/supabase/proxy.ts:54-60` — the redirect that would swallow a drain POST
- `src/lib/auth/dal.ts:42` — the app's only source of an email address: the caller's own JWT claims
- `src/types/domain.ts:18-27` — `ArtistSummary`, the template for a narrow hand-written `EmailRecipient`
- `src/types/database.ts:281` — `close_due_auctions` is in the generated types despite being granted to nobody
- `supabase/migrations/20260909144939_add_user.sql:32-55` — `handle_new_user`, `after insert` only, hence the email-drift trap
- `supabase/migrations/20260909160400_public_artist_profiles.sql:11-17` — the column grant that withholds `email` from everyone
- `supabase/migrations/20260909160200_add_interactions.sql:24-27` — owner-only reads; no blanket-read policy, so likers are unqueryable
- `supabase/migrations/20260910101500_add_enrichment_quota.sql` — the ledger + atomic definer RPC precedent
- `supabase/migrations/20260910180000_rank_swipe_deck.sql:22-32` — taste as an inline CTE pinned to `auth.uid()`; not reusable in reverse
- `supabase/migrations/20260910190000_add_profile_onboarded_at.sql:12-15` — the exhaustive revoke-then-grant convention
- `supabase/migrations/20260911190000_add_bids.sql:20-21` — a prior migration anticipating that the close would run definer
- `supabase/migrations/20260912120000_add_auction_close.sql:36-38` — the partial-index precedent a drain query should mirror
- `supabase/migrations/20260912120000_add_auction_close.sql:129-132` — "the absence is the access control"
- `supabase/migrations/20260912120100_schedule_auction_close.sql:8-13` — why Vercel cron was ruled out for the close
- `test/integration/auction-close.int.ts:339-352` — idempotency, with an explicit forward reference to S-04
- `test/lib/ai.test.ts:1-16` — `vi.hoisted` + `importOriginal` partial mock of a provider
- `test/smoke/enrich.live.ts:5-9` — filename-based gating of a live-provider check
- `test/integration/setup.ts:11-13` — throw rather than skip
- `scripts/build-corpus.ts:1356-1364` — recording a failure reason as a pinned outcome
- `scripts/build-corpus.ts:1559-1566` — pre-flighting config once instead of failing per item

## Architecture Insights

**F-02 must decide the bridge topology, but need not implement all of it.** Its literal outcome — one transactional message to one address through one gated path — is satisfiable with `src/lib/email/`, an env-gated provider, a send record, and a smoke-lane proof. But "one gated path" is a promise about callers that do not exist yet, and S-04's caller lives inside Postgres where no app code runs. If F-02 ships without settling how a DB-triggered event reaches the Node send path, S-04 will grow its own, and the "off means off, from any path" guardrail will have more than one place to fail. **Decide the topology in F-02; implement the minimum of it that F-02's own proof requires.**

**Exactly one new credential should cross the RLS boundary, and the choice of which is the plan's central decision.** The send path needs plaintext addresses in Node, and no Supabase client in this project can obtain them. That leaves three families: (a) give the app a credential that outranks RLS — a service-role key or a shared secret checked inside a definer function, both breaking a standing project policy that is documented three times in `.env.example`; (b) let Postgres make the HTTP call itself via `pg_net`, so addresses never leave the database for app code; (c) keep the send outside the app entirely — an Edge Function or a scheduled job with DB credentials. Each spends something real. The project's existing instinct, visible in `close_due_auctions`, is to solve access control by _removing_ grants rather than adding credentials — which argues for (b) at the bridge with the send itself still in Node, i.e. `pg_net` pushing a signal or payload to a proxy-exempt route handler.

**Enforcement belongs in the `where` clause of a definer function, not in a policy.** A definer recipient function is mandatory regardless, because `interactions` is unqueryable by anyone but each liker. Once it exists, putting the FR-005 preference filter inside it makes "off means off" structural in exactly one place — matching the stance already taken by `place_bid` and `cancel_auction`, where the mutation's `where` clause _is_ the rule and the tables carry no write policies at all.

**The generated types will not protect you.** `src/types/database.ts` reflects the catalog, not the grants: `close_due_auctions` is `rpc()`-callable at the type level and fails at runtime. Any definer function granted to nobody will behave the same way. The default test lane mocks Supabase entirely, so a wrongly-privileged call passes `format:check`, `lint`, `typecheck`, `test` and `build` and only fails against a real database — which is a specific argument for the integration lane carrying the grant assertions.

**Observability is the genuinely new thing.** The project has no logging at all, by convention. A send record row is the option with a precedent behind it (`ai_enrichment_calls`, the corpus manifest) and the only one that survives to be queried after the fact — which matters because the proof obligation is not just "a failure is visible" but "no untargeted collector was mailed", and that is a claim about history, not about a moment.

**The one structural asset already in place** is that `closed_at` is written exactly once and never moved, proven against real Postgres, with the integration test explicitly recording that S-04 will trigger on it — plus a partial-index precedent showing exactly how the symmetric drain set should be indexed. An outbox can ride the close's existing single `update` statement with no extra scan.

## Historical Context (from prior changes)

- `context/archive/2026-09-12-timed-auction-close/plan.md` — the change that introduced the first scheduled execution the project has ever had, and chose pg_cron over Vercel cron. Its reasoning is the direct upstream of §3's bridge problem: the trigger deliberately lives in the database, which is what puts it out of reach of app code.
- `context/archive/2026-09-11-sealed-bidding/plan.md` — established the "withhold the read, let a definer function bypass RLS later" posture that F-02 now depends on ([20260911190000_add_bids.sql:20-21](supabase/migrations/20260911190000_add_bids.sql#L20-L21) anticipates exactly this slice).
- `context/archive/2026-09-11-list-artwork-for-auction/plan.md` — denormalised `seller_id` onto `auctions` specifically so S-04 could find the seller after an artwork row is gone; the send path inherits that affordance.
- `context/archive/2026-09-09-ai-artwork-enrichment/plan.md` — the origin of the `{ ok, reason }` / never-throws / lazy-env-read pattern F-02 should mirror, and of the `ai_enrichment_calls` quota ledger.
- `context/archive/2026-09-10-testing-upload-consistency/research.md` — the prior art for reasoning about which test lane can answer which question; its integration-lane conclusions apply unchanged to an outbox.
- `context/foundation/lessons.md`, first entry — "Never block a user-visible mutation on a third-party AI call". The rule generalises verbatim to a send, and its "Applies to" clause already reaches any future third-party call on a mutation path.
- `context/foundation/infrastructure.md` — the Hobby-tier constraints, the `waitUntil`-is-best-effort warning (which applies equally to `after()`), and the recorded caution that a dropped deferred call "leaves no trace". That caution is the strongest argument in the repo for a durable send record rather than fire-and-forget.

## Related Research

- `context/archive/2026-09-10-testing-upload-consistency/research.md` — test-lane boundaries and what only a real Supabase stack can prove
- `context/archive/2026-09-10-add-onboarding-flow-for-collector/research.md` — the `profiles` column-addition and grant-reissue path, which §5 builds on
- No prior research exists on outbound messaging, scheduling beyond the auction close, or `pg_net`. F-01 (`shared-taste-definition`) has no research artifact yet, and its outcome — a reusable, reversible taste definition — is what S-06's recipient function will consume; §2's conclusion that the reverse lookup must be `security definer` is a constraint F-01's plan should know about.

## Open Questions

1. **Which credential or mechanism is allowed to cross the RLS boundary?** The load-bearing decision. The project refuses a service-role key in three places; a shared secret checked inside a definer function, a `pg_net` push, a direct `pg` connection held by the app, and an Edge Function with its own secret all have different costs (§3 table). This needs an explicit sanction, not a default. — Owner: user. **Block: yes**, for anything past the send module itself.
2. **Does the FR-005 preference live on `profiles` or in its own table?** The precedent says `profiles` + exhaustive grant reissue; the privacy weight of the column and the `anon`-writes-it requirement both argue for a separate owner-only table. — Owner: user/plan. Block: no.
3. **Stateless HMAC or stateful opaque token for the unsubscribe link?** Neither has in-repo precedent; `node:crypto` makes the first free of dependencies, the second makes revocation possible. — Owner: plan. Block: no.
4. **Does the send record hold recipient addresses?** If it does, it is a table of email addresses with the same disclosure weight as `profiles.email`, and it needs the same grant treatment — plus an answer for how the drain reads it. Storing only a `user_id` and resolving the address at send time avoids that entirely. — Owner: plan. Block: no.
5. **How does a failure become visible to a human?** A send record makes it queryable but nothing surfaces it. The options are an account-page surface, a periodic check, or accepting "queryable after the fact" as the whole of F-02's promise. The roadmap's wording is "visible rather than silent", which the record satisfies literally. — Owner: user. Block: no.
6. **Resend's exact SDK result shape.** The recommendation in §8 assumes a non-throwing `{ data, error }` return; verify against the installed version before designing `SendResult` around it. If it throws, the wrapper absorbs that — no change to the plan, only to the classifier.
7. **Is `profiles.email`'s drift worth fixing here?** `handle_new_user` is `after insert` only, so an address changed through Supabase's email-change flow leaves the column stale. A recipient function can read `auth.users` instead, or F-02 can add the missing update trigger. Either is small; doing neither means mailing stale addresses. — Owner: plan. Block: no.
8. **Which sending identity/domain, eventually?** Deliberately downgraded from the roadmap's framing. `onboarding@resend.dev` unblocks all of F-02, S-04 and S-05 development because the only real user is the account owner, and auth email currently leaves from Supabase's domain, so the two streams are already separated. This becomes a launch-day decision with a known answer (a dedicated subdomain, separate from whatever carries auth email). — Owner: user. Block: no.

## Follow-up Research 2026-09-12T17:05+03:00

**Question:** is there a platform-native (Supabase or Vercel) path that makes the DB→app bridge easy, rather than the option-space of §3?

**Answer: yes, on the Supabase side, and it collapses Open Question 1 from five options to one recommended shape. Vercel contributes nothing to the bridge.**

### Vercel: not the answer

- **Vercel Cron is still unusable here.** Hobby allows a cron expression no more frequent than **once per day**, and Vercel may fire it anywhere inside the scheduled hour. The per-_project_ cap rose to 100 on all plans (Jan 2026) but the Hobby _frequency_ restriction did not change. §Guardrails requires a notification to reach recipients "promptly after the auction opens" — once a day, ±1 hour, fails that by orders of magnitude. This is the same verdict [20260912120100_schedule_auction_close.sql:8-13](supabase/migrations/20260912120100_schedule_auction_close.sql#L8-L13) already recorded for the close, and it holds for notifications too. Pro ($20/seat) lifts it to any expression.
- **Vercel Queues** (public beta) would work for the S-05 half, but the app has to enqueue — which does nothing for S-04, where the trigger is inside Postgres. It would add a beta dependency to solve the half that is already easy.
- **What Vercel does usefully contribute:** Marketplace provisioning of Resend (creates the account, injects `RESEND_API_KEY` into project env, can configure DNS), and `after()` — already the repo's established pattern for keeping a third-party call off a mutation's critical path.

### Supabase: Database Webhooks are the bridge

A **Database Webhook** is Supabase's convenience wrapper around a `for each row` trigger calling `supabase_functions.http_request(...)`, which uses `pg_net` underneath. Verified against the docs:

- It can POST to an **arbitrary external HTTPS URL** — not only to an Edge Function. So a Next.js route handler is a legitimate target.
- **Custom HTTP headers are supported**, including an `Authorization` bearer token.
- The payload is per-row and fixed: `{ type, table, schema, record, old_record }` — on `INSERT`, `record` is the inserted row and `old_record` is `null`.
- It is a per-row trigger, and it can be created **in SQL**, therefore in a migration — which matters, because dashboard-created webhooks would be untracked drift against a repo where `.github/workflows/migrations.yml` is the deployment path for schema.
- The docs state no timeout, retry, or delivery guarantee. "Logging history of webhook calls is available" is the whole of the failure story.

### The recommended shape

Put the recipient's address **in the outbox row**, and the webhook hands it to the sender. That is what makes the credential problem disappear:

1. **`email_outbox`** — `id`, `recipient_email`, `kind`, `payload jsonb`, `status`, `sent_at`, `error`, `created_at`. RLS enabled with **no policies at all**, the stance `auctions` already takes for writes ([20260911120000_add_auctions.sql:52-54](supabase/migrations/20260911120000_add_auctions.sql#L52-L54)) — invisible and unwritable from every client. Partial index on `(created_at) where status = 'pending'`, mirroring [auctions_due_close_idx](supabase/migrations/20260912120000_add_auction_close.sql#L36-L38).
2. **A `security definer` resolver** that joins `interactions` → `auth.users`, filters on the FR-005 preference, and **inserts outbox rows, returning only a count — never addresses**. This is where "off means off" lives, as a `where` clause. For S-04 it is called by `close_due_auctions` inside the same transaction that writes `closed_at`, so enqueue is exactly-once for free. For S-05 it can be granted to `authenticated` safely, precisely because it returns a count.
3. **A webhook on `insert into email_outbox`**, defined in a migration, POSTing `record` to a route handler with `Authorization: Bearer <secret>`.
4. **The route handler** verifies the secret with `timingSafeEqual`, then calls `src/lib/email/send.ts` — the one gated path, typed `{ ok, reason }`, fully mockable in the default Vitest lane. **It needs no database read privileges whatsoever**, because the address arrived in the payload. It must be **excluded from the proxy matcher** the way `auth/confirm` is (§4, option 3).
5. **Write-back** via one narrow definer function `record_send_outcome(p_secret, p_id, p_status, p_reason)` that verifies the same secret. This is the single credential that crosses the boundary, and it buys two narrow functions rather than a blanket key.
6. **At-least-once**, cheaply: a second `pg_cron` job re-posts rows still `pending` after N minutes. `pg_net` has no retries, so without this a failed POST leaves a row pending forever. This job is also the visibility query — `select * from email_outbox where status = 'pending' and created_at < now() - interval '15 minutes'` is the answer to "did a message fail", and it is a claim about history, which is what §7 argued for.

**Total new infrastructure:** one extension (`pg_net`), one table, two definer functions, one trigger, one `pg_cron` entry, one route handler, one lib module. No second runtime, no service-role key, no Vercel plan change, no new scheduler — it reuses the pg_cron that S-03 already installed.

### The alternative, and why not

Supabase's own documented email pattern is **webhook → Edge Function → Resend** ([docs](https://supabase.com/docs/guides/functions/examples/send-emails)), with `RESEND_API_KEY` in Edge Function secrets. It is genuinely easier on three counts: no proxy exemption, no shared secret (Edge Functions get `SUPABASE_SERVICE_ROLE_KEY` injected inside Supabase, so the resolver can be called directly and the write-back is free), and Supabase documents it end to end.

It is rejected because of what it costs **this** project:

- It is a **second runtime** (Deno). `[edge_runtime] enabled = false` in `supabase/config.toml` and there is no `supabase/functions/` directory — all net-new.
- The send path leaves the Node app, so `src/lib/email/` stops being the choke point. F-02's outcome is "every caller routed through the same choke point"; a sender that lives outside the app cannot be that, and `src/lib/ai/`'s pattern has nothing to say about it.
- **It is untestable in the lanes this project has.** The default Vitest suite cannot load a Deno function; the integration lane drives Postgres and PostgREST. A three-lane test discipline that AGENTS.md spells out in detail would simply not cover the most failure-prone part of the feature.
- The Supabase doc's prerequisites require a **verified domain**, which re-introduces the decision that §8 showed is avoidable.

If the shared-secret write-back in step 5 is judged unacceptable, the Edge Function is the fallback — and the trade is explicit: a second runtime and a test-coverage hole in exchange for not holding a secret in the app.

### What this changes upstream

Open Question 1 is no longer open-ended. The recommended answer is **(b) from §"Architecture Insights"** — let Postgres make the HTTP call, keep the send in Node — implemented as a Database Webhook rather than hand-rolled `pg_net` calls. What remains for the user to sanction is narrower: **is a shared secret, verified inside two definer functions, an acceptable credential for this project?** The alternative is the Edge Function with the costs above.

One testability caveat to carry into the plan: the **webhook hop itself** is awkward to integration-test, because `pg_net` is fire-and-forget (it returns a `request_id`; the response lands later in `net._http_response`) and a local test would need a listener on the other end. The split that works: the outbox insert, the resolver's preference filter, the exactly-once property and the no-policy invisibility all go in the integration lane against real Postgres; the send module and its failure matrix go in the default lane with mocks; the webhook hop is proven once by hand and by the smoke lane.

**Sources:** [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Vercel cron changelog, Jan 2026](https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan) · [Supabase Database Webhooks](https://supabase.com/docs/guides/database/webhooks) · [Supabase send-email example](https://supabase.com/docs/guides/functions/examples/send-emails)
