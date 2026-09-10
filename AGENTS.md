<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project conventions (ArtSwipe)

### Stack

Next.js 16 App Router · React 19 · TypeScript (strict) · Supabase (Postgres + Auth + Storage) · Tailwind v4 · Zod · deployed on Vercel.

Node is pinned in `.nvmrc` / `engines` (currently 24 LTS — `nvm use` picks it up). ESLint stays on 9.x and TypeScript on 5.x: `eslint-config-next@16.3.4` bundles a `typescript-eslint` that caps at TS `<6.1.0`, and ESLint 10 breaks its React plugin.

### Version discipline — this is Next.js 16, not 13/14/15

- Request interception lives in `src/proxy.ts` (this version's name for middleware). There is no `middleware.ts`.
- Before writing or changing routing, caching, `cookies()`/`headers()` usage, Server Actions, or `next/image`, read the matching guide under `node_modules/next/dist/docs/`. Do not rely on memory of older Next.js.
- `cookies()` and `headers()` are async — always `await` them.

### Directory map

- `src/app/(app)/**` — authenticated area (redirects to `/login` when signed out). `src/app/(auth)/**` — login/signup, signed-out only.
- `src/app/actions/*.ts` — Server Actions, grouped by domain (`artworks`, `auth`, `interactions`, `profile`). All mutations go through a Server Action.
- `src/lib/**` — data-access helpers and pure logic. `src/lib/artworks/queries.ts` is `server-only`.
- `src/components/**` — grouped by domain (`artworks`, `auth`, `account`, `ui`).
- `src/types/database.ts` — GENERATED, never hand-edit. `src/types/domain.ts` — hand-written domain types.
- `src/utils/supabase/` — client factories (see below).

### Supabase client — pick the right factory

- Browser / Client Components → `createClient` from `src/utils/supabase/client.ts`.
- Server Components, Server Actions, route handlers → `await createClient()` from `src/utils/supabase/server.ts` (cookie-aware).
- Session refresh in `src/proxy.ts` → `updateSession` from `src/utils/supabase/proxy.ts`.
- Row-Level Security is the security boundary. Ownership filters in queries are for correctness/performance, not security — never rely on them for access control.

### Database changes

- Add a migration: create `supabase/migrations/<timestamp>_<name>.sql`. Migrations apply in timestamp order.
- After changing schema, regenerate types: `npm run db:types:local` (local) or `npm run db:types` (linked).
- Pushing migration files to `main` auto-deploys them via `.github/workflows/migrations.yml`. Never edit an already-applied migration — add a new one.

### Validation

- Validate all external input (form data, Server Action args, request bodies) with Zod at the boundary before use.

### Formatting

- Prettier owns formatting (`.prettierrc.json`); ESLint defers to it via `eslint-config-prettier`. Run `npm run format` before committing, or `npm run format:check` to verify. `.editorconfig` mirrors the core rules for editors.
- `.prettierignore` excludes generated (`src/types/database.ts`), vendored (`.agents/`, `.claude/`), and 10x workflow (`context/`) files.

### Tests

Three lanes, each with its own Vitest config and its own file glob so one can never pick up another's specs. Only the first runs in CI.

**Default suite — `npm run test`** (`vitest.config.mts`, `test/**/*.test.ts`, Node environment, no jsdom; `npm run test:watch` while iterating).

- A thin smoke layer over Server Actions and `src/lib` helpers: the Zod validation gates and the happy path with Supabase / `next/*` / the auth DAL mocked. **Supabase is never hit for real in this lane** — that is what lets it run deterministically in CI.
- `import "server-only"` is aliased to a stub in the config so `src/lib/**` modules load under Node.
- `vi.mock` factories are hoisted — share fixtures into them via `vi.hoisted`, not module-level `const`s.

**Real-boundary lane — `npm run test:integration`** (`vitest.integration.config.mts`, `test/integration/**/*.int.ts`). Opt-in, local only, never in CI.

- Talks to a real Supabase stack — real Postgres, Storage, Auth and RLS — because questions about what the storage boundary actually does cannot be answered by mocking it.
- **Refuses to run against anything but a local stack.** `test/integration/setup.ts` throws unless the URL's hostname is loopback; the lane creates users and uploads objects, and `.env.local` points at the linked project.
- Credentials come from `.env.test.local` (gitignored), which you generate yourself:
  ```bash
  npx supabase start
  npx supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
    --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY > .env.test.local
  ```
- No service-role key. Fixtures run under the same RLS a real user has. Mint **one test user per file** — `[auth.rate_limit] sign_in_sign_ups` is 30 per 5 minutes per IP.

**Live smoke checks — `npm run test:smoke`** (`vitest.smoke.config.mts`, `test/smoke/**/*.live.ts`). Opt-in, never in CI.

- Calls a real external provider (currently OpenRouter, via `.env.local`). For manually confirming an integration works end to end, not for assertions anyone else has to keep green.

### Verify before calling a change done

Run and pass all of: `npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run test` · `npm run build`.
CI (`.github/workflows/verify.yml`) runs the same set on every PR and push to `main`. Do not assume a change works without running them.
