---
project: artswipe
researched_at: 2026-09-09
recommended_platform: Vercel
runner_up: Cloudflare Workers
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Next.js 16.3.4 (App Router) / React 19.2.8
  runtime: Node.js 24 LTS
---

## Recommendation

**Deploy on Vercel.**

ArtSwipe is already live on Vercel with green CI, and nothing surfaced in this research
argues for moving it. Vercel is the only candidate where the framework and the platform
ship together — Next.js 16.3 and Node 24 are both GA on Vercel today, so the pinned
`next@16.3.4` / `react@19.2.8` / Node 24 combination needs no adapter, no Dockerfile and
no compatibility matrix to track. It also satisfies the two loudest interview answers at
once: cost is $0 while this stays non-commercial coursework, and it is the platform the
developer already knows. The decisive caveat is not the platform but the plan: the Hobby
tier's hard **10s function timeout** sits directly on top of the AI vision call this change
introduces, so the enrichment feature must be built to survive it (see the Risk Register).

## Platform Comparison

| Platform | CLI-first | Managed/Serverless | Agent-readable docs | Stable deploy API | MCP / Integration | Total |
|---|---|---|---|---|---|---|
| **Vercel** | Pass | Pass | Pass | Pass | Partial | **4.5** |
| Cloudflare Workers | Pass | Pass | Pass | Partial | Pass | 4.5 |
| Netlify | Pass | Partial | Pass | Pass | Pass | 4.5 |
| Railway | Pass | Pass | Pass | Pass | Pass | 5.0 |
| Render | Pass | Pass | Pass | Partial | Pass | 4.5 |
| Fly.io | Pass | Partial | Pass | Pass | Partial | 4.0 |

Raw criterion scores are close — all six are genuinely agent-operable. The decision was made
by the interview weights and by stack fit, not by the totals. Railway scores highest on the
raw criteria and still lost, which is the clearest evidence the totals alone do not decide
this.

**Vercel** — `vercel deploy` / `vercel rollback` / `vercel logs` / `vercel env` cover the full
operational loop from a terminal (CLI-first: Pass). Fluid Compute is the default and abstracts
all infrastructure (Managed: Pass). Docs publish `llms.txt`, `llms-full.txt` and `.md` endpoints
site-wide, plus a formal Agent Readability spec (Docs: Pass). Deploys are one deterministic
command returning a URL, with `vercel promote` and `vercel rollback` as first-class inverses
(Deploy API: Pass). Vercel MCP exists but has been in **public beta since Aug 2025** and is
read-heavy — writes still go through CLI output parsing (MCP: Partial).

**Cloudflare Workers** — `wrangler deploy` / `rollback` / `tail` / `secret put` is a complete
CLI loop, docs offer per-product `llms.txt` plus `Accept: text/markdown`, and the official
hosted MCP servers are GA. Deploy API is marked Partial *for this stack specifically*: the
Next.js path runs through the third-party `@opennextjs/cloudflare` adapter, which supports
Next.js 16 minors but carries an **open compatibility issue for Next.js 16's proxy
architecture** (`workers-sdk#13755`) — and this repo's request interception lives in
`src/proxy.ts`. There are also open ISR-caching bugs in the adapter. Note the genuine
strength: CPU-time billing means `await`ing a slow vision API costs nothing while it waits,
and Paid has no enforced wall-clock cap.

**Netlify** — Next.js 16 runtime is GA (OpenNext-based, zero-config), Node 24 is the default
for new sites, the CLI is complete, `llms.txt` is published, and the Netlify MCP server is
production-track. Managed is marked Partial for one reason that matters here: **synchronous
functions cap at 10s by default and 26s maximum on Pro**. Server Actions run as functions, so
the AI vision call has a hard ceiling that cannot be raised; Background Functions reach 15
minutes but are fire-and-forget and cannot return a suggestion to the waiting artist.

**Railway** — the strongest raw score: always-on containers (no function timeout at all),
Railpack builds Node 24, `railway up` / `logs` / `variables` plus CLI-available rollback, an
OAuth remote MCP server at `mcp.railway.com`, and published `llms.txt`. It lost on the stated
top priority: there is no usable free tier (Free plan grants $1 credit/month), so a small
always-on Next.js service realistically runs $5–15/mo against Vercel's $0. `NEXT_PUBLIC_*`
vars also bake at build time, and there is no built-in image CDN.

**Render** — GA CLI with `render logs --tail`, `render.yaml` blueprints, deploy hooks, GA MCP
server, and `llms.txt`. Deploy API is Partial because rollback has no confirmed CLI verb — it
goes through the REST API or the dashboard. The free instance spins down after ~15 min idle
with a ~1 min cold start (unusable for a demoed app), Starter is $7/mo, and **preview
environments require the Pro plan ($25+/mo)** — which would cost more than the app.

**Fly.io** — full CLI (`fly deploy` / `releases` / `logs` / `secrets`) and `llms.txt`, but it
ranks last for this project. Managed is Partial: it needs a hand-maintained Dockerfile and an
`output: "standalone"` build, with no built-in CDN and no `next/image` optimization layer. Its
MCP server is explicitly labelled **experimental** with infrastructure-mutation risk. There is
no meaningful free tier since Oct 2024, and Managed Postgres and Tigris storage are **beta**.

### Shortlisted Platforms

#### 1. Vercel (Recommended)

Wins on the two hard facts about this project: it is already the live deployment target for a
brownfield app with green CI, and it is the only platform where Next.js 16.3 + React 19 +
Node 24 is a first-party GA path with no adapter in between. Cost is $0 today under Hobby;
familiarity is high; `llms.txt` and `.md` doc endpoints make it directly readable by an agent.
Fluid Compute's Active CPU pricing ($0.128/Active-CPU-hr) is also structurally right for this
workload — the seconds spent waiting on a vision API are not billed as CPU. The single
material gap is Hobby's 10s function ceiling, which is a design constraint on the enrichment
feature rather than a reason to move platforms.

#### 2. Cloudflare Workers

The cheapest predictable *paid* path at ~$5/mo for 10M requests, with the best cost model for
this specific workload: CPU-time billing plus no wall-clock cap on Paid means a 20-second
vision call is neither expensive nor fatal — the exact problem Vercel Hobby and Netlify both
have. Bundle limits were raised to 64 MiB uncompressed in Sept 2026, Node 24 is the Workers
Builds default, and `@supabase/supabase-js` is HTTP-based so it avoids the TCP/connection-pool
trap entirely. The gap: Next.js support is a third-party adapter with an open Next.js 16
proxy-architecture issue and open ISR bugs, on a repo that uses `src/proxy.ts`. That is a
migration with a real spike attached, not a swap — worth it only if Vercel's plan economics
stop working.

#### 3. Netlify

Familiar, free, GA Next.js 16 runtime, Node 24 default, complete CLI, and the most mature
MCP + agent-runner story of the three. It ranks third because its constraint is the same
shape as Vercel's but strictly worse: 10s default and **26s maximum** on synchronous
functions, unraisable on any plan, with Background Functions unable to return a result to the
artist waiting on a suggestion. Choosing Netlify would trade one timeout ceiling for a lower
one. Its 2026 credit-based pricing is also harder to forecast than Vercel's published limits.

## Anti-Bias Cross-Check: Vercel

### Devil's Advocate — Weaknesses

1. **The Hobby 10s function timeout caps the one new workload this change adds.** Server
   Actions are functions; an image→tags vision call routinely takes 3–15s. `maxDuration` is
   clamped on Hobby, not honored — the 300s default is Pro-only. The free tier that makes
   Vercel the cost winner is precisely the tier that cannot run this feature reliably.
2. **The Hobby plan's non-commercial clause is a latent forced upgrade.** The PRD says a
   public launch is possible later. Any revenue signal — a donation link, a paid listing,
   collectors transacting on-platform — moves the project to Pro at $20/seat under Fair Use.
   The "$0" recommendation has an expiry date nobody has scheduled.
3. **`waitUntil` is best-effort with no retries and no dead-letter.** If FR-003's baseline
   tagging at publish is deferred via `waitUntil` to satisfy the "publish never blocks on AI"
   guardrail, dropped invocations publish artworks under-tagged — silently violating the exact
   rule the feature exists to enforce.
4. **Turbopack is mandatory from Next.js 16.2 with no `--webpack` fallback**, and there are
   reports of OOM on Vercel's default 8GB builder plus stale `.next/cache` reuse serving stale
   prerendered HTML. A bundler-level build break has no escape hatch on a platform where you
   cannot shell into the builder.
5. **Image optimization is billed per transformation ($0.05/1k) on a swipe UI** — the highest
   image-throughput interface shape there is — and each miss pulls the original from Supabase
   Storage, burning Supabase's separate egress allowance. Two vendors' meters, one user gesture.

### Pre-Mortem — How This Could Fail

Six months on, the team assumed Hobby was the plan. Enrichment shipped and worked locally,
where the vision call took eight seconds and nobody noticed. In production it hit the 10s
ceiling under real image sizes and returned a truncated function error, so the description
assist failed for roughly one upload in four — recoverable by design, so nobody escalated it;
the tags field simply stayed empty and the "no piece published under-tagged" rule quietly
stopped holding. To keep publish non-blocking, baseline tagging was moved behind `waitUntil`,
which is best-effort: a further slice of artworks landed with no tags and no error anywhere,
because a dropped `waitUntil` leaves no trace. Meanwhile the swipe feed's image transformations
climbed, pulling originals through Supabase Storage until its egress allowance ran out
mid-month and images 404'd for everyone. The recommendation work that this change existed to
feed started against a tag corpus that was maybe 60% populated — and, because nothing had ever
alerted, nobody knew which 40% was missing or why. The migration to Pro happened eventually,
under pressure, at the worst moment.

### Unknown Unknowns

- **Fluid Compute reuses function instances across concurrent requests.** Any per-request state
  held in module scope — a Supabase client carrying a session, a cached auth token — can bleed
  between users. This is not how classic one-request-per-instance serverless behaved, and it is
  the sharpest footgun for a Supabase-auth app on today's Vercel. It reinforces the existing
  rule in AGENTS.md: always construct the client per request via `createClient()`.
- **Preview deployments on Hobby are publicly reachable by URL.** Deployment Protection
  (Vercel Authentication / password) is a Pro feature. Every PR preview of a pre-launch product
  is an unlisted public site.
- **Active CPU pricing means waiting on the AI API is nearly free** (CPU idles during I/O) —
  but provisioned memory is still billed by GB-hr for the whole wall-clock wait. Long vision
  calls are cheap, not free, and that cost scales with configured memory, not with work done.
- **Vercel MCP is public beta and read-heavy.** The agent can inspect deployments and logs
  through typed tools, but writes still go through `vercel` CLI output parsing — so the MCP
  criterion is a weaker signal here than the scoring matrix suggests.
- **Hobby log retention is very short** (roughly an hour of runtime logs) and Hobby caps deploys
  per day. Combined with the existing GitHub Actions verify gate, every push builds twice —
  once in CI, once on Vercel — against both quotas.
- **`runtime = 'edge'` is no longer the right default on Vercel.** Streaming and SSE work on the
  default Node.js runtime under Fluid Compute with zero config; reaching for the edge runtime
  for a "streaming" AI suggestion would cost full Node API access for nothing.

## Operational Story

- **Preview deploys**: the Vercel Git integration builds every push and every PR branch to a
  unique preview URL automatically; no CI wiring needed beyond the existing
  `.github/workflows/verify.yml` gate. **On Hobby these preview URLs are public to anyone who
  has the link** — Deployment Protection is Pro-only. Fork PRs do not receive previews with
  access to environment secrets.
- **Secrets**: environment variables live in the Vercel project dashboard / `vercel env`, scoped
  per environment (Production / Preview / Development). Pull them locally with
  `vercel env pull .env.local` rather than hand-copying. The Supabase service-role key and any
  AI provider key are Production/Preview-scoped server-only vars and must never carry the
  `NEXT_PUBLIC_` prefix. Rotation is `vercel env rm <NAME> <env>` then `vercel env add <NAME>
  <env>`, followed by a redeploy — env changes do not apply to already-built deployments.
  Supabase migration credentials stay in GitHub Secrets for `migrations.yml`; they are a
  separate store from Vercel's, and rotating one does not rotate the other.
- **Rollback**: `vercel rollback` reverts production to the previous deployment, or
  `vercel promote <deployment-url>` pins a specific known-good build. Both are near-instant —
  the artifact already exists, nothing rebuilds. **Data caveat:** Supabase migrations pushed to
  `main` are applied by `.github/workflows/migrations.yml` and do **not** roll back with the
  deployment. Any migration must be forward-compatible with the previous app build, or a code
  rollback will meet a schema it does not expect.
- **Approval**: an agent may deploy previews, read logs, run `vercel env pull`, and inspect
  deployments unattended. A human confirms: promoting to production, adding or rotating any
  secret, changing the plan tier, and — per this project's standing convention — running any
  Supabase or container lifecycle command locally. Migration files reaching `main` auto-deploy
  to the database, so the PR merge *is* the approval gate for schema changes; treat it as one.
- **Logs**: `vercel logs <deployment-url>` tails runtime logs; `vercel inspect --logs
  <deployment-url>` returns build logs for a specific deployment; `vercel ls` enumerates recent
  deployments. All are read-only and safe for an agent to run unattended. Vercel MCP (public
  beta) exposes the same deployment/log surface as typed tools once authorized. **The Vercel CLI
  is not currently installed on this machine** — see Getting Started.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Hobby's 10s function timeout truncates the AI vision call, so description/tag suggestions fail intermittently in production but pass locally | Devil's advocate | H | H | Set an explicit client-side AI timeout **below** 10s in `src/lib/ai/` and treat expiry as the FR-005 manual-entry fallback. Measure real p95 vision latency against real artwork images before shipping; if p95 approaches the ceiling, move to Pro (300s default) rather than tuning around it. |
| Baseline tagging deferred via `waitUntil` is dropped silently, publishing under-tagged artworks and violating FR-003 | Devil's advocate / Pre-mortem | M | H | Do not rely on `waitUntil` as the only path. Persist an explicit per-artwork enrichment state (e.g. `pending` / `done` / `failed`) in Postgres so a missing tag set is queryable, and add a reconciliation query before the recommendation work consumes the corpus. |
| Hobby's non-commercial clause forces an unplanned move to Pro ($20/seat) the moment ArtSwipe carries any revenue signal | Devil's advocate | M | M | Treat Pro as the launch-day cost, not an emergency. Record the trigger conditions (donations, payments, paid listings, client work) in this file and re-check before any public launch. The upgrade is a plan change, not a migration. |
| Preview deployments are publicly accessible by URL on Hobby, exposing a pre-launch product and its preview data | Unknown unknowns | M | M | Point Preview environment variables at a non-production Supabase project so a leaked preview URL reaches no real data. Enable Deployment Protection if/when the project moves to Pro. |
| Per-request Supabase state placed in module scope bleeds across users under Fluid Compute's instance reuse | Unknown unknowns | L | H | Already covered by the AGENTS.md rule — construct the client per request via `await createClient()` from `src/utils/supabase/server.ts`; never cache a session-bearing client at module scope. Add it to review checks for any new `src/lib/ai/` module. |
| Turbopack build OOM or stale `.next/cache` on Vercel's builder, with no `--webpack` fallback in Next.js 16 | Devil's advocate | L | M | The existing `npm run build` gate in `verify.yml` catches build breaks before merge. If a Vercel-only OOM appears, clear the build cache from the deployment settings and, if it persists, raise builder memory (Pro) rather than reworking the bundler. |
| Image-optimization transformations on the swipe feed generate surprise cost and exhaust Supabase Storage egress | Devil's advocate / Pre-mortem | M | M | Constrain `next/image` `sizes` and the served variants to a small fixed set so transformations cache and repeat. Watch Supabase egress alongside Vercel usage — this is a two-vendor meter and neither dashboard shows the other. |
| Next.js 16 `src/proxy.ts` is a moving target across platforms; a future adapter or platform change breaks request interception | Research finding | L | M | Non-issue on Vercel (first-party). Recorded because it is the concrete blocker on the Cloudflare fallback path — re-verify `workers-sdk#13755` before any migration. |
| Vercel MCP stays in public beta and cannot perform writes, so agent operations remain CLI-string-parsing | Research finding | M | L | Rely on the `vercel` CLI as the primary agent interface and treat MCP as a convenience for reads. No architectural dependency on MCP. |

## Getting Started

ArtSwipe already deploys on Vercel, so these are hardening steps for the enrichment change,
not a first-time setup. Commands are checked against this repo's pinned versions
(`next@16.3.4`, `react@19.2.8`, Node 24 from `.nvmrc`) as of 2026-09-09.

1. **Install the Vercel CLI** — it is not on this machine today, and every operational step
   below depends on it:
   `npm i -g vercel`, then `vercel login` and `vercel link` to bind the repo to the existing project.
2. **Pull the environment locally instead of hand-editing `.env.local`**:
   `vercel env pull .env.local`. Then add the new AI provider key to all three environments —
   `vercel env add AI_API_KEY production` (repeat for `preview`, `development`) — as a
   server-only variable with no `NEXT_PUBLIC_` prefix. Keep `.env.example` updated to match.
3. **Do not add a platform-native dev command.** `npm run dev` (Next.js 16 + Turbopack) is the
   development loop for this project; `vercel dev` is redundant for a Next.js app on Vercel and
   is slower. Local runtime fidelity comes from the framework, not from the platform CLI.
4. **Configure function duration explicitly rather than inheriting it.** Prefer `vercel.ts` over
   `vercel.json` — it is the current recommended project-configuration format, typed via
   `@vercel/config` (`npm i -D @vercel/config`). Whatever duration you set, remember Hobby
   clamps to 10s; the config documents the intent, the plan enforces the ceiling. Stay on the
   default Node.js runtime — do **not** set `runtime = 'edge'`; streaming works on Node under
   Fluid Compute and edge would cost full Node API access for nothing.
5. **Verify against a real preview before merging.** Push the branch, let the Vercel Git
   integration build a preview, and exercise a real image upload through the enrichment path
   there — the 10s ceiling and the real vision latency only show up off localhost. Read the
   result with `vercel logs <preview-url>`. Keep running the full local gate first:
   `npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build`.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup
- Production-scale architecture (multi-region, HA, DR)
