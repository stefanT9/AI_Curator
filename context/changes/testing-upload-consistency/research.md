---
date: 2026-09-10T11:24:50Z
researcher: stefanT9
git_commit: 5fa1c1926b36b2186c862ea89acd0bcd718f5e4f
branch: main
repository: artswipe
topic: "Rollout Phase 1 — real-boundary lane and upload/publish consistency (Risk #1)"
tags: [research, codebase, artworks, storage, supabase, testing, rls]
status: complete
last_updated: 2026-09-10
last_updated_by: stefanT9
---

# Research: Real-boundary lane and upload consistency (test-plan Phase 1, Risk #1)

**Date**: 2026-09-10T11:24:50Z
**Researcher**: stefanT9
**Git Commit**: `5fa1c1926b36b2186c862ea89acd0bcd718f5e4f`
**Branch**: `main`
**Repository**: artswipe

## Research Question

Ground rollout Phase 1 of `context/foundation/test-plan.md`.

Risk #1 — an artwork is published whose stored image key resolves to nothing, so the card renders broken for every collector and the artist's piece is effectively lost.

Verify (not blindly accept) the response guidance: prove a published artwork always has a retrievable image and that a failed upload never leaves a published row behind; challenge "the existence check passed, so the object is there"; avoid mocking the storage client. Ground every error path and whether each cleans up, whether the existence check can succeed for an unusable object, and what happens if the object is removed after publish. Establish what it takes to stand up the real-boundary lane, including amending the AGENTS.md rule that Supabase is never hit for real.

## Summary

Risk #1 is real, but **the test plan points at the wrong half of it**, and the correction matters for what Phase 1 should build.

1. **The direction the plan worries about is already structurally safe.** "A failed upload leaves a published row behind" cannot happen: the object is uploaded from the browser *before* the Server Action runs, and the row is inserted last ([artworks.ts:113-129](src/app/actions/artworks.ts#L113-L129)). No upload, no row.

2. **The dangerous direction is the mirror image, and it is the compensating cleanup itself.** When the insert reports an error, the action deletes the object ([artworks.ts:131-136](src/app/actions/artworks.ts#L131-L136)) and the client deletes it again ([ArtworkForm.tsx:48-55](src/components/artworks/ArtworkForm.tsx#L48-L55)). If the insert *committed* and still reported an error — a dropped connection after commit is enough, since `postgrest-js` surfaces a fetch rejection as `error` — the row survives and both deleters remove its image. That is Risk #1 exactly, produced by the code written to prevent it.

3. **The existence check is weaker than "not atomic". It probes a different endpoint than the collector's browser.** `exists()` sends `HEAD /storage/v1/object/artworks/<key>` — the *authenticated* route, subject to RLS `select` on `storage.objects`. The card fetches `/storage/v1/object/**public**/artworks/<key>` ([images.ts:13-14](src/lib/artworks/images.ts#L13-L14)) — a different route with different authorization. **No migration defines a `select` policy on `storage.objects`** (only insert/update/delete, [20260909160300_add_artworks_storage.sql:24-51](supabase/migrations/20260909160300_add_artworks_storage.sql#L24-L51)). So the check's answer today rests on an unverified assumption about how storage-api treats the authenticated route for a public bucket. **This is the single highest-value thing the real-boundary lane can pin, and it is unknowable from the mocked suite.**

4. **A missing object is silent.** No read path filters on `image_path`, `ArtCard` has no `onError`, and the deck keeps working — the collector swipes and `recordInteraction` records a verdict on art they never saw. The failure produces training data, not an error.

5. **The lane is buildable today with no new dependency**, following the `.live.ts` precedent verbatim. `@supabase/supabase-js` is a direct dependency, the CLI is pinned at 2.117.0 in devDeps *and* already used in CI, `[storage]`/`[auth]`/`[db]` are enabled locally, and `auth.email.enable_confirmations = false` means a test can mint a signed-in user in one call. The blockers are conventions and helpers, not capability.

## Detailed Findings

### The write path, end to end

Three actors touch the object, in this order:

| Step | Where | Actor |
| --- | --- | --- |
| 1. Upload object | [upload.ts:35-72](src/lib/artworks/upload.ts#L35-L72) | browser, artist's session |
| 2. Shape + folder gate | [artworks.ts:98-109](src/app/actions/artworks.ts#L98-L109) | Server Action |
| 3. Existence check | [artworks.ts:113-121](src/app/actions/artworks.ts#L113-L121) | Server Action, artist's session |
| 4. Insert row | [artworks.ts:123-129](src/app/actions/artworks.ts#L123-L129) | Server Action |
| 5a. Cleanup on insert error | [artworks.ts:134](src/app/actions/artworks.ts#L134) | Server Action |
| 5b. Cleanup on any error state | [ArtworkForm.tsx:48-55](src/components/artworks/ArtworkForm.tsx#L48-L55) | browser |

Step 1 happens in the browser because Server Action bodies cap at 1 MB while the bucket accepts 10 MiB — the fix that landed in `d715bda` the day before the test plan. Rationale is recorded at [ai-artwork-enrichment/plan.md:198](context/changes/ai-artwork-enrichment/plan.md#L198): every photo over 1 MB "died with a raw 413 before the Zod gate ran". Raising `serverActions.bodySizeLimit` was considered and rejected.

That fix is what turned an atomic `upload()`-inside-the-action into today's **check-then-insert**, and it is why Risk #1 exists in its current shape.

### Enumerated failure paths (the "ground every error path" question)

**P1 — insert commits, reports error, both cleanups fire. → broken card. HIGH value.**
[artworks.ts:131-136](src/app/actions/artworks.ts#L131-L136) removes the object whenever `insertError` is truthy. A connection dropped after commit yields exactly that. Then [ArtworkForm.tsx:48-55](src/components/artworks/ArtworkForm.tsx#L48-L55) fires a second `removeArtworkImage` because `state.message` is set. Result: a live row whose object is gone, permanently, with no detection anywhere. The compensating action has no guard that the row is actually absent.

**P2 — `exists()` probes the wrong route. → unknown, possibly systemic. HIGHEST value.**
Verified in the vendored client ([`node_modules/@supabase/storage-js/dist/index.mjs`](node_modules/@supabase/storage-js/dist/index.mjs), `async exists`): it HEADs `${url}/object/${bucket}/${path}` — the authenticated route — and returns `data: false` **only** for status 400/404, throwing on anything else. The collector's URL is the `/object/public/...` route. With no `select` policy on `storage.objects` anywhere in `supabase/migrations/`, whether these two agree is an empirical property of storage-api v1.73.1, not of this repo. Both branches are bad news of different kinds:
- if the authenticated route denies → storage-api answers 404 → `exists()` returns false → **every publish fails** with "The image upload did not finish";
- if it allows (public-bucket short-circuit) → today works, but a future storage upgrade or a stricter policy migration silently flips publish to always-failing, and nothing in CI can see it.

**P3 — `exists()` throws. → orphan + generic error page. MEDIUM.**
The call destructures only `data` and drops `error` ([artworks.ts:113-115](src/app/actions/artworks.ts#L113-L115)), but the client *throws* on 401/403/5xx/network. There is no try/catch, so the Server Action rejects: the artist gets a generic error, no state is returned, and because [ArtworkForm.tsx:51](src/components/artworks/ArtworkForm.tsx#L51) keys on `state?.errors || state?.message`, the client cleanup never runs and the object is orphaned forever.

**P4 — `exists()` true for an unusable object. → broken card. LOW likelihood, confirmed possible.**
The answer to "can the existence check succeed for an unusable object" is **yes**: `exists()` is a HEAD, and says nothing about byte count or actual content. The 0-byte and MIME guards live in the browser ([upload.ts:36-46](src/lib/artworks/upload.ts#L36-L46)) and the file's own comment calls them "a courtesy, not the gate"; the bucket's `allowed_mime_types` constrains the *declared* content type, not the bytes. An artist's session can write any object under `${uid}/` per the insert policy.

**P5 — object removed after publish. → broken card, undetected. MEDIUM.**
`deleteArtwork` is ordered safely (read key → delete row → remove object, [artworks.ts:194-215](src/app/actions/artworks.ts#L194-L215)), so it orphans objects, never rows. But the storage delete policy grants an artist permanent delete rights over `${uid}/*` with no "not referenced by a row" condition, and `publicImageUrl` reads `NEXT_PUBLIC_SUPABASE_URL` at render time — so an environment or project swap breaks every card at once. Nothing filters, alerts, or tests for it.

**P6 — the database permits an unrenderable row. → broken card. Cheapest to close.**
`image_path text not null` is the only constraint ([20260909160100_add_artworks.sql](supabase/migrations/20260909160100_add_artworks.sql)); `''` is legal, and `publicImageUrl('')` yields a bucket-root URL. `IMAGE_PATH_PATTERN` ([images.ts:36-37](src/lib/artworks/images.ts#L36-L37)) and the folder gate live only in app code, so any non-action writer — a seed file, a future admin path, the planned corpus — can create a structurally broken row.

**P7 — TOCTOU between check and insert. LOW.**
The literal reading of the plan's "not atomic". The window is milliseconds and the only actors with delete rights are the artist's own session and the form's own cleanup. Real, but the least likely of the set — and P1 is the same non-atomicity with a much wider window.

### What a collector actually sees

`publicImageUrl` is the sole converter ([images.ts:13-14](src/lib/artworks/images.ts#L13-L14)) and its only read-path caller is [ArtCard.tsx:36](src/components/artworks/ArtCard.tsx#L36). Every surface funnels through that one card: discover/deck, liked, artwork detail, artist page, studio grid.

- `next.config.ts` sets `remotePatterns` for `/storage/v1/object/public/**` with no custom loader, so the browser requests `/_next/image?url=…`; a missing object makes the optimizer fail with `upstream image response failed`.
- `ArtCard` is deliberately stateless ([ArtCard.tsx:21](src/components/artworks/ArtCard.tsx#L21) — "No 'use client': it holds no state"), so there is **no `onError`, no placeholder, no fallback**. The visible result is the wrapper's own `bg-black/5` grey box at the right aspect ratio.
- Server render never fails; the deck stays fully swipeable, `deck.length - index` still counts down, and `recordInteraction` records verdicts on invisible art.
- No query filters on `image_path` — `getSwipeDeck`/`getArtwork`/`getLikedArtworks`/`getArtistArtworks` all pass rows through, and the `swipe_deck` RPC has no image predicate.

**Blast radius: one silent grey card, not a crash.** Which is worse for a product whose ranking will be trained on those interactions.

### Why the current suite cannot see any of this

[test/actions/artworks.test.ts:6-10](test/actions/artworks.test.ts#L6-L10) mocks `createClient` to `throw new Error("no test reaches Supabase")`. Every existing assertion therefore stops at the Zod gate or the folder check — the three `createArtwork` tests all assert paths that return *before* line 111. Steps 3-5 of the write path have zero coverage, by construction. [test/lib/images.test.ts](test/lib/images.test.ts) tests `publicImageUrl` as string concatenation only.

The plan's premise is confirmed verbatim: the mocks sit exactly on the seam the risk lives in.

### Standing up the lane

**The precedent to copy** is the live-smoke lane, and its commit message (`ec1e70c`) already states the design rule: *"its own config, and a `.live.ts` suffix that the main include pattern does not match. `npm run test` and CI can never pick it up by accident."* `vitest.smoke.config.mts` is deliberately standalone rather than `mergeConfig`'d, because merging concatenates `include` arrays.

**What already exists**: `@supabase/supabase-js` as a direct dependency; the CLI pinned to 2.117.0 in devDeps *and* in `migrations.yml` via `supabase/setup-cli@v3`; `[db]`, `[auth]`, `[storage]` all enabled in `supabase/config.toml`; `auth.email.enable_confirmations = false` (`config.toml:225`) so a test can sign a user up and use the session immediately; `supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL` as the sanctioned key-extraction path; `[db.seed] enabled = true, sql_paths = ["./seed.sql"]` (`config.toml:67-70`) wired to a file that does not exist yet; a `.gitignore` precedent for lane output.

**What is missing**: `supabase/seed.sql`; any service-role key env var; a health-check/skip helper; a test-user factory and teardown; a `test:integration` script and third config; and the AGENTS.md rule.

**Authentication approach**: `src/utils/supabase/server.ts` needs `await cookies()` and `client.ts` needs `document.cookie`, so neither works in Node. A test constructs a plain `createClient<Database>(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })` and signs in — **the JWT then makes RLS apply exactly as in production, which is the entire point**. Two targets, two shapes:
- `src/lib/artworks/upload.ts` and the storage policies — pure supabase-js, needs no Next runtime at all. Cheapest and highest-value.
- `createArtwork` end to end — the hybrid: mock `@/utils/supabase/server` to hand back a *real* Node client while keeping `next/navigation` and `next/cache` mocked, which [test/actions/artworks.test.ts:11-12](test/actions/artworks.test.ts#L11-L12) already precedents.

**Isolation.** The `on delete cascade` chain from `auth.users` → `profiles` → `artworks`/`interactions` means deleting a user removes its whole row graph — but that needs a service-role key, and [.env.example:2-3](.env.example#L2-L3) explicitly warns against introducing one. **Recommended alternative: skip the secret.** A signed-in test user can delete its own artworks and its own storage objects under RLS; the residue is `auth.users`/`profiles` rows in a local database that `supabase db reset` clears anyway. Two further operational facts: `supabase db reset` **also clears Storage objects**, and `[auth.rate_limit] sign_in_sign_ups = 30` per 5 min per IP (`config.toml:205-206`) will flake a suite that mints a fresh user per test — prefer a small pool created once.

**CI is a genuine tension, not a detail.** `verify.yml` today declares placeholder Supabase vars with the comment "CI never talks to Supabase (tests mock it)". A stack-backed job is feasible (`ubuntu-latest` has Docker; `supabase/setup-cli@v3` is already proven in `migrations.yml`) at roughly **2-4 minutes of cold image pull per run**, plus a new class of flake. Set against that: `migrations.yml` currently pushes migrations straight to production on merge to `main` with no rehearsal beyond `migration list` — so a stack-backed job is the only thing that could ever gate it. That gating is Risk #4 / Phase 4's job, not Phase 1's.

## Code References

- `src/app/actions/artworks.ts:113-121` — the existence check; `error` discarded, no try/catch
- `src/app/actions/artworks.ts:131-136` — server-side cleanup that can delete a live row's object (P1)
- `src/app/actions/artworks.ts:194-215` — `deleteArtwork`, safely ordered row-then-object
- `src/components/artworks/ArtworkForm.tsx:48-55` — second, client-side deleter keyed on any error state
- `src/components/artworks/ArtworkForm.tsx:71-104` — upload-then-dispatch submit wrapper
- `src/lib/artworks/upload.ts:35-72` — browser upload; size/MIME guards described as "a courtesy, not the gate"
- `src/lib/artworks/images.ts:13-14` — `publicImageUrl`, the `/object/public/` route
- `src/lib/artworks/images.ts:36-37` — `IMAGE_PATH_PATTERN`, enforced in app code only
- `src/components/artworks/ArtCard.tsx:35-43` — stateless `next/image`, no `onError`
- `supabase/migrations/20260909160300_add_artworks_storage.sql:24-51` — insert/update/delete policies; **no select policy**
- `supabase/migrations/20260909160100_add_artworks.sql` — `image_path text not null`, no shape constraint
- `test/actions/artworks.test.ts:6-10` — `createClient` mocked to throw
- `vitest.smoke.config.mts` / `package.json:14` — the opt-in second-config precedent
- `supabase/config.toml:67-70, 205-206, 225` — seed hook, signup rate limit, confirmations off
- `AGENTS.md:59` — "Supabase is never hit for real."
- `.github/workflows/verify.yml:16-19` / `migrations.yml:32-34` — placeholder-env comment; proven CLI-in-CI step

## Architecture Insights

- **Publication is row existence.** No `status`/`published`/`deleted_at` column. "Published" means the row is there and `"Signed-in users can read all artworks" using (true)` lets anyone see it. So there is no state in which a row is safely half-created.
- **The write path spans three trust domains** (browser storage write → Server Action check → Server Action insert) with a compensating delete instead of a transaction. Storage and Postgres cannot share a transaction, so *some* compensation is unavoidable — the question is only whether the compensation is guarded.
- **The one guarantee nobody wrote down.** Neither `prd-v2.md`, `shape-notes.md` nor `roadmap.md` states that a published artwork's image must be retrievable; they say only that images are "served via public object URLs". The guarantee exists solely as test-plan Risk #1. Phase 1 is where it becomes an executable contract.
- **RLS-as-boundary meets a check that bypasses it.** AGENTS.md declares RLS the security boundary, and the folder check at `artworks.ts:107` is correctly labelled the security one. But `exists()` interrogates a route whose authorization nobody has specified.

## Verification of the plan's response guidance

| Plan says | Verdict | Correction |
| --- | --- | --- |
| Prove "a published artwork always has a retrievable image" | **Refine** | Must assert a 200 with non-zero bytes from `publicImageUrl(row.image_path)` — the collector's route. Asserting via `.exists()` would re-use the very check under suspicion. |
| Prove "a failed upload never leaves a published row behind" | **Correct the direction** | Structurally impossible today (row is written last). The live risk is the mirror: a failed-looking insert removing the object out from under a row that *did* land (P1). Phase 1 should assert that direction. |
| Challenge "the existence check passed, so the object is there" | **Right, understated** | The sharper challenge: the check probes a *different endpoint under different authorization* than the card fetches (P2). Atomicity is the second-order problem. |
| Cheapest layer: real-boundary integration | **Confirmed, with a cheaper complement** | A `check` constraint on `image_path` shape closes P6 in a migration with no test at all. Everything else genuinely needs the lane. |
| Anti-pattern: mocking the storage client | **Confirmed** | The current suite is the proof: `createClient` throws, so no assertion reaches steps 3-5. |
| Hot-spot `src/app/actions/` | **Confirmed as an anchor too** | `artworks.ts:113-136` is where the risk actually lives — the hot-spot evidence and the failure surface coincide here, which is not always the case. |

## Historical Context (from prior changes)

- [context/changes/ai-artwork-enrichment/plan.md:198](context/changes/ai-artwork-enrichment/plan.md#L198) — full rationale for the 1 MB body-limit fix that created today's check-then-insert shape; `:463` states plainly "Integration Tests: Not applicable — the project has no integration test layer."
- [context/changes/ai-artwork-enrichment/change.md:16](context/changes/ai-artwork-enrichment/change.md#L16) — **hard constraint**: `npm run db:types:local` crashes and overwrites `src/types/database.ts`. Do not run it in this repo.
- [context/changes/ranking-eval-corpus/plan.md](context/changes/ranking-eval-corpus/plan.md) — `status: planned`, nothing implemented, no `supabase/seed.sql` on disk. It documents the seeding workflow Phase 1 can reuse: profiles arrive only via the `on_auth_user_created` trigger; a password login needs an `auth.identities` row, not just `auth.users`; `seed.sql` cannot create Storage objects, so images go up via `npx supabase storage cp --local -r supabase/seed-assets/<uuid> ss:///artworks/<uuid>`; and `supabase db reset` clears Storage as well as the database. Its placeholder filenames are already UUID-shaped so they satisfy `IMAGE_PATH_PATTERN`.
- The same plan (`:390`) **explicitly refuses** to build this lane — "Adding a test would mean adding a real-database integration lane, which is explicitly out of scope" — and its `change.md` warns the corpus "must stay a corpus, not become a general fixtures framework." Phase 1 should build the lane *beside* it, not inside it.
- `git log --all -- test/ vitest*.mts .github/` shows **no prior attempt** at a real-database lane. `ec1e70c` (the live-smoke harness) is the closest precedent and the template to follow.

## Open Questions

1. **Does `.exists()` succeed against a real local stack given no `select` policy on `storage.objects`?** The first thing the lane should answer; both answers change what Phase 1 must fix. Not resolvable from source — nothing is listening on `127.0.0.1:54321` right now.
2. **Can `insertError` be non-null with the row committed in practice?** P1's severity hinges on it. Worth a deliberate fault-injection test rather than reasoning.
3. **Should Phase 1's lane be CI-blocking?** `test-plan.md` §5 says "required after §3 Phase 1", but the evidence favours landing it as a local opt-in lane and deciding CI in Phase 4 alongside the migration gate. Flagged as a backport candidate.
4. **Fix or only observe?** P1 and P6 have obvious cheap fixes (guard the cleanup on a verified-absent row; add a `check` constraint). Whether Phase 1 ships fixes or only the failing tests that prove them is a plan-level call.
5. **Does a `select` policy need adding to `storage.objects`?** Answering Q1 decides this — and it is Risk #3's territory, so it may belong to Phase 3.
