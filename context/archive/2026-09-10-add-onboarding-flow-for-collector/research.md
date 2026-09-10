---
date: 2026-09-10T17:16:46+0300
researcher: Claude (Opus 5)
git_commit: 85270a001c8eb822a784cdba0188084ac5e5f59d
branch: main
repository: artswipe
topic: "Add onboarding flow for collector — taste bootstrap (cold start) and first-run orientation"
tags: [research, codebase, onboarding, cold-start, swipe-deck, taxonomy, auth, rls]
status: complete
last_updated: 2026-09-10
last_updated_by: Claude (Opus 5)
---

# Research: Add onboarding flow for collector

**Date**: 2026-09-10T17:16:46+0300
**Researcher**: Claude (Opus 5)
**Git Commit**: `85270a001c8eb822a784cdba0188084ac5e5f59d`
**Branch**: `main`
**Repository**: artswipe

## Research Question

What exists in the codebase and the decision record that bears on adding an onboarding
flow for a new collector, scoped to two surfaces:

1. **Taste bootstrap (cold start)** — seeding preferences before the collector has liked anything.
2. **First-run orientation** — teaching the swipe UI on first contact.

## Summary

**There is no onboarding anything today, and no prior decision anticipates one.** An
exhaustive grep of `context/` for `onboard|cold.start|first.run|tutorial|welcome|questionnaire|preference|taste|threshold`
returns zero hits proposing a collector onboarding flow, a taste picker, or a first-run
tutorial — not in the PRDs, not in the roadmap, not even in a Non-Goal or Parked list. The
word "onboarding" appears twice in the tree and both are something else: the
collector→artist role opt-in ([prd-v2.md:127](context/foundation/prd-v2.md#L127)) and
*agent* onboarding ([health-check.md:188](context/foundation/health-check.md#L188)). The
codebase agrees — no flag, no counter, no timestamp check anywhere distinguishes a new
user from an established one.

Three findings shape everything downstream:

1. **The two chosen surfaces sit at completely different layers.** First-run orientation is
   pure client UI inside a component that already renders the whole deck. Taste bootstrap has
   no place to store its output — the schema cannot express "this collector likes *abstract*"
   without a migration, because `interactions.artwork_id` is `not null` and `action` is
   constrained to `'like' | 'skip'`.
2. **Taste bootstrap collides head-on with recorded PRD decisions.** `prd-v2.md` states that a
   collector's preferences come **only** from their own likes (FR-003), that "Every collector
   begins with no learned taste and reaches ranking through new likes only"
   ([prd-v2.md:111](context/foundation/prd-v2.md#L111)), and lists "No collector-facing
   controls over ranking" as a Non-Goal ([prd-v2.md:131](context/foundation/prd-v2.md#L131)).
   A taste picker is a preference source that is not a like, operated by the collector. See
   [Conflicts](#conflicts-with-the-recorded-decision-record).
3. **Taste bootstrap is an unproposed answer to the question that blocks slice S-03.** PRD Open
   Question 2 — "How many likes switch ranking on?" — blocks
   [`cold-start-and-untagged-placement`](context/foundation/roadmap.md#L124). Seeding taste at
   signup dissolves that question rather than answering it. Nobody has written this down.

## Detailed Findings

### 1. What a brand-new collector experiences today

The full path, end to end:

| Step | Where | What happens |
| --- | --- | --- |
| Submit signup | [actions/auth.ts:82-98](src/app/actions/auth.ts#L82-L98) | `supabase.auth.signUp`, then `redirect(data.session ? "/app" : "/signup/check-email")` — the branch depends on whether email confirmation is enabled in the Supabase dashboard |
| Profile row created | [20260909144939_add_user.sql:32-49](supabase/migrations/20260909144939_add_user.sql#L32-L49) | `on_auth_user_created` trigger (`security definer`) inserts `(id, email)`. `display_name` is **null**; `role` defaults to `'collector'` ([20260909160000_add_profile_role.sql:5-8](supabase/migrations/20260909160000_add_profile_role.sql#L5-L8)) |
| Land on `/app` | [(app)/app/page.tsx:8-12](<src/app/(app)/app/page.tsx#L8-L12>) | Pure role router: `redirect(profile.role === "artist" ? "/studio" : "/discover")`. No other logic. |
| `/discover` renders | [(app)/discover/page.tsx:12-26](<src/app/(app)/discover/page.tsx#L12-L26>) | `force-dynamic`; `getSwipeDeck()` with no argument → 20 cards. Static subcopy renders identically for everyone. |
| Deck is built | [20260909160200_add_interactions.sql:57-68](supabase/migrations/20260909160200_add_interactions.sql#L57-L68) | `order by a.created_at desc`, anti-joined against `interactions`. For a zero-interaction user the anti-join is **vacuous** — they get the newest 20 artworks, full stop. |
| Swiping | [SwipeDeck.tsx:27-43](src/components/artworks/SwipeDeck.tsx#L27-L43) | Optimistic: `index` advances before the write; rolls back on failure. |
| Deck exhausted | [SwipeDeck.tsx:169-182](src/components/artworks/SwipeDeck.tsx#L169-L182) | `EmptyDeck`: *"Nothing left to rate — You've seen everything in the catalog for now."* with a link to `/liked`. **No refill exists**; only a full page reload produces new cards. |

Two consequences worth naming:

- **`EmptyDeck` lies to a new collector.** It fires on `index >= deck.length`, which is
  exhaustion of the *fixed 20-card snapshot*, not of the catalogue. A new collector who swipes
  20 cards is told they have "seen everything" when they have seen 20 items. (This is the gap
  slice `S-02: continuous-deck-refill` exists to close — status `ready`,
  [roadmap.md:112-122](context/foundation/roadmap.md#L112-L122).)
- **The only new-user-aware copy in the product is on the wrong page.**
  [(app)/liked/page.tsx:26-34](<src/app/(app)/liked/page.tsx#L26-L34>) has a genuine zero-state
  ("Pieces you like while swiping collect here"), reachable only by navigating *away* from the
  swipe surface.

**No first-run detection exists anywhere.** A grep across `src/` and `supabase/migrations/` for
`onboard|first.run|welcome|isNew|new.?user|zero.?state|cold.start` returns only the login page's
"Welcome back" copy and the Postgres `handle_new_user()` trigger name. `profiles.created_at`
exists and is granted for select ([20260909160400_public_artist_profiles.sql:16-17](supabase/migrations/20260909160400_public_artist_profiles.sql#L16-L17))
but is never read by any query or component.

### 2. Where an onboarding gate could physically slot in

Four candidate insertion points, in increasing order of reliability:

1. **`src/proxy.ts` / `updateSession`** — [utils/supabase/proxy.ts:54-67](src/utils/supabase/proxy.ts#L54-L67)
   holds the existing redirect logic (`PUBLIC_PATHS`, `SIGNED_OUT_ONLY_PATHS`). It runs on
   every request including public ones ([proxy.ts:15-17](src/proxy.ts#L15-L17)). Gating here
   would add a DB read to every request, and the codebase explicitly labels this layer
   **optimistic**: *"The proxy already redirected signed-out visitors, but that check is
   optimistic. This is the one that actually guards the segment."*
   ([(app)/layout.tsx:6-8](<src/app/(app)/layout.tsx#L6-L8>)).
2. **`(app)/layout.tsx`** — the real guard, calls `requireProfile()` on every authenticated
   page. Gating here catches deep links, but the layout also renders the nav, so an onboarding
   screen shown from here inherits the app chrome.
3. **`(app)/app/page.tsx`** — already the post-login funnel and already a redirect-only router.
   The narrowest natural insertion point, but it is bypassed by any direct navigation to
   `/discover`.
4. **`src/lib/auth/dal.ts`** — the DAL already owns this pattern:
   [`requireArtist`](src/lib/auth/dal.ts#L98-L106) redirects a non-artist to `/account`. A
   `requireOnboarded` would be the idiomatic sibling. Note `getProfile` is `cache()`-wrapped
   ([dal.ts:62](src/lib/auth/dal.ts#L62)) and currently selects only `display_name, role`
   ([dal.ts:72](src/lib/auth/dal.ts#L72)) — a new column would need adding there.

**RLS constraint on any new `profiles` column**: the table's update grant is column-scoped —
`grant update (display_name, role) on public.profiles to authenticated`
([20260909160000_add_profile_role.sql:16-18](supabase/migrations/20260909160000_add_profile_role.sql#L16-L18)).
An onboarding-completion flag on `profiles` would need its own explicit grant, and the select
grant ([20260909160400_public_artist_profiles.sql:16-17](supabase/migrations/20260909160400_public_artist_profiles.sql#L16-L17))
would need widening too. There is **no insert policy** on `profiles` — rows exist only via the
trigger.

### 3. The form pattern a new onboarding screen must follow

The closest precedent is the collector→artist opt-in — the only guided one-step flow in the
product:

- **Server Action** [`becomeArtist`](src/app/actions/profile.ts#L37-L73): `requireProfile()` →
  early `redirect` if already in the target state → Zod `safeParse` → return
  `{ errors: z.flattenError(...).fieldErrors }` on failure → Supabase update → return
  `{ message }` on DB error → `revalidatePath("/", "layout")` → `redirect`.
- **Client form** [`BecomeArtistForm`](src/components/account/BecomeArtistForm.tsx#L7-L31):
  `useActionState(action, undefined)`, `<Field>` per input, `role="alert"` paragraph for
  `state.message`, submit button disabled on `pending` with swapped label.
- **State type** [`ProfileFormState`](src/app/actions/profile.ts#L9-L15): a union with optional
  `errors` / `message` / `success`, defaulting to `undefined`.

**Nothing exists to build a tag picker out of.** No component library is installed — the full
dependency list is Next, React, Supabase, `ai` + OpenRouter, Zod, Vercel Analytics
(`package.json`). Everything is hand-rolled Tailwind v4.
[`Field`](src/components/ui/Field.tsx#L34-L127) supports input / textarea / file only, with no
multi-select or chip variant. A grep for `wizard|stepper|useState.*step|<dialog|role="dialog"`
across `src/**/*.tsx` returns **nothing** — there is no multi-step form, stepper, progress
indicator, modal, or dialog anywhere in the product. Even artwork tags are entered as a
comma-separated free-text field ([ArtworkForm.tsx:250-256](src/components/artworks/ArtworkForm.tsx#L250-L256)),
not a picker. The only tag *display* primitive is `TagList`, exported from
[ArtCard.tsx:79-92](src/components/artworks/ArtCard.tsx#L79-L92).

### 4. The raw material for a taste bootstrap

**The vocabulary is ready-made.** [`src/lib/ai/taxonomy.ts:19-130`](src/lib/ai/taxonomy.ts#L19-L130)
defines `TAXONOMY_BY_FACET` — **5 facets × 20 terms = 100 tags**:

| Facet | Terms |
| --- | --- |
| `medium` | oil painting, acrylic, watercolour, gouache, ink, charcoal, graphite, pastel, collage, mixed media, screenprint, lithograph, etching, linocut, digital painting, photography, sculpture, ceramic, textile, mural |
| `style` | abstract, figurative, realism, hyperrealism, impressionist, expressionist, surrealist, minimalist, geometric, cubist, pop art, folk art, art nouveau, art deco, brutalist, naive, psychedelic, street art, illustrative, gestural |
| `subject` | portrait, self portrait, figure study, nude, landscape, seascape, cityscape, architecture, still life, botanical, floral, animal, bird, wildlife, interior, crowd, machinery, food, celestial, map |
| `palette` | monochrome, black and white, sepia, warm palette, cool palette, pastel palette, earth tones, jewel tones, neon, high contrast, muted, desaturated, vivid, primary colours, complementary, gradient, metallic, red dominant, blue dominant, green dominant |
| `mood` | serene, melancholic, joyful, dramatic, tense, dreamlike, nostalgic, playful, solemn, romantic, eerie, energetic, contemplative, chaotic, intimate, monumental, whimsical, brooding, hopeful, austere |

Critically, the module is **deliberately free of `server-only`**
([taxonomy.ts:14-16](src/lib/ai/taxonomy.ts#L14-L16)) so client components can import it
directly — a taste picker can render the vocabulary without a round trip. Exports include
`FACETS`, `ARTWORK_TAGS` (flattened non-empty tuple, so `z.enum` consumes it as a literal
union), and the `ArtworkTag` type.

**Artwork-side matching material.** `artworks.tags text[] not null default '{}'` with a GIN
index `artworks_tags_idx` ([20260909160100_add_artworks.sql:10,29](supabase/migrations/20260909160100_add_artworks.sql#L10))
and a cardinality cap raised 10→20 to let generated and artist tags coexist
([20260909214144_raise_artwork_tag_limit.sql:12-16](supabase/migrations/20260909214144_raise_artwork_tag_limit.sql#L12-L16)).
Generated tags are constrained to the 100-term enum at the model boundary
([schema.ts:23-35](src/lib/ai/schema.ts#L23-L35), min 5 / max 12) and normalized
trim + lowercase + dedupe ([schema.ts:56-59](src/lib/ai/schema.ts#L56-L59)); artist free text
is *not* constrained, so `tags` mixes both by design.

**But there is nowhere to put a collector's answer.** The only per-user taste table is
`interactions`:

```sql
create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  artwork_id uuid not null references public.artworks (id) on delete cascade,
  action text not null check (action in ('like', 'skip')),
  created_at timestamptz not null default now(),
  unique (user_id, artwork_id)
);
```
— [20260909160200_add_interactions.sql:4-14](supabase/migrations/20260909160200_add_interactions.sql#L4-L14)

`artwork_id` is `not null` with an FK to a real row, and `action` admits exactly two values. A
row **cannot** express "I like *geometric*" independent of a specific artwork. There is no
facet column, no weights table, no preference table, and no onboarding-state column anywhere in
the migration set. `ai_enrichment_calls` is per-user but is a rate-limit ledger, not taste.

**Conventions any new table must follow**: RLS enabled; every policy `to authenticated` with an
`auth.uid()` ownership predicate in `using` / `with check`; `uuid primary key default gen_random_uuid()`;
`created_at timestamptz not null default now()`; check constraints or a Postgres enum for closed
vocabularies; GIN index for tag-array containment. Migrations are `<timestamp>_<name>.sql`,
applied in timestamp order, auto-deployed on merge to `main`.

**Two designs avoid a migration entirely** and are worth naming because the schema permits them
as-is:

- *Rate real artworks during onboarding* — an onboarding screen that shows N starter pieces and
  writes ordinary `interactions` rows. Zero schema change, and the output is literally "their own
  likes", which sidesteps the FR-003 conflict below. Note `recordInteraction` upserts on
  `(user_id, artwork_id)` ([actions/interactions.ts:36-43](src/app/actions/interactions.ts#L36-L43)),
  so this is idempotent.
- *Derive taste on read* — no stored preference at all, just an ordering that reads
  `interactions` (what `S-01` already plans to do).

### 5. Prior decisions this work touches

**The seed corpus already models the cold collector.** `F-01: ranking-eval-corpus` (done,
archived) built 54 artworks — 48 tagged in four clusters of twelve, six untagged — plus a *warm*
collector with 8 likes and a **cold collector with none**
([judgment.md:12-13](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L12-L13),
[plan.md:286-287](context/archive/2026-09-10-ranking-eval-corpus/plan.md#L286-L287)). Any
onboarding work has a ready-made fixture in `seed-collector-cold@artswipe.local`.

**A recorded baseline says the cold deck must not change.** `judgment.md` Walk B:

> **Pre- and post-S-01 expectation:** identical. With no likes there is nothing to match on, so
> the cold-start deck should stay newest-first and **not change** between the two runs. If S-01
> alters this deck, that is a cold-start regression.
> — [judgment.md:52-54](context/archive/2026-09-10-ranking-eval-corpus/judgment.md#L52-L54)

That expectation was written to catch an S-01 bug. A taste bootstrap **deliberately** changes
the cold collector's deck, so it invalidates this recorded check rather than violating it — but
the walkthrough would need updating in the same change, or the next person to run it will read a
success as a regression.

**Open Question 2 is the live one.** *"How many likes switch ranking on?"* — owner: user, blocks
`S-03` ([roadmap.md:150](context/foundation/roadmap.md#L150)). FR-005 verbatim:

> A collector who has not liked enough artworks yet is served the existing unranked ordering
> until ranking has something to work with.
> — [shape-notes.md FR-005](context/foundation/shape-notes.md)

No document proposes onboarding as an alternative. A taste bootstrap would make the threshold
question mostly moot — every collector arrives with signal — which is a genuinely different
resolution to a question currently recorded as blocking a slice.

### Conflicts with the recorded decision record

A **taste bootstrap** must be reconciled with four written positions before it can be planned:

| Recorded position | Where | Tension |
| --- | --- | --- |
| "a collector's preferences come **only** from their own likes — never from a global or cross-collector popularity signal" (FR-003) | [prd-v2.md:87](context/foundation/prd-v2.md#L87) | A tag picker is neither a like nor a cross-collector signal. The rule's *intent* (no shared feed) survives; its *letter* does not. |
| "Every collector begins with no learned taste and reaches ranking through new likes only. No migration or backfill of historical likes." | [prd-v2.md:111](context/foundation/prd-v2.md#L111) | Directly contradicted — onboarding means a collector begins *with* taste. |
| Non-Goal: "No collector-facing controls over ranking. No filters, no 'show me more like this', no tuning… ranking is invisible and automatic in v1" | [prd-v2.md:131](context/foundation/prd-v2.md#L131) | A picker is a collector-facing control over ranking, exercised once. |
| "Existing unranked ordering must survive as a fallback: it becomes the cold-start path" | [prd-v2.md:114](context/foundation/prd-v2.md#L114) | Onboarding replaces the cold-start path instead of preserving it. |

**First-run orientation** conflicts with none of these — it changes no ordering and stores no
preference. The one guardrail it touches is *"Liking, the liked-artworks view, and the swipe
interaction itself remain intact and functional"* ([prd-v2.md:62](context/foundation/prd-v2.md#L62)),
which constrains *how* it may modify `SwipeDeck`, not whether.

## Code References

- [supabase/migrations/20260909160200_add_interactions.sql:4-14](supabase/migrations/20260909160200_add_interactions.sql#L4-L14) — `interactions` schema; `artwork_id not null`, `action in ('like','skip')`
- [supabase/migrations/20260909160200_add_interactions.sql:57-68](supabase/migrations/20260909160200_add_interactions.sql#L57-L68) — `swipe_deck` RPC, `security invoker`, `order by a.created_at desc`, limit clamped `[1,50]`
- [supabase/migrations/20260909144939_add_user.sql:32-49](supabase/migrations/20260909144939_add_user.sql#L32-L49) — `handle_new_user` trigger creating the profile row at signup
- [supabase/migrations/20260909160000_add_profile_role.sql:16-18](supabase/migrations/20260909160000_add_profile_role.sql#L16-L18) — column-scoped update grant (`display_name`, `role` only)
- [src/lib/ai/taxonomy.ts:19-130](src/lib/ai/taxonomy.ts#L19-L130) — the 100-term, 5-facet controlled vocabulary; importable from client code
- [src/lib/artworks/queries.ts:53-64](src/lib/artworks/queries.ts#L53-L64) — `getSwipeDeck(limit = 20)`, the only deck entry point
- [src/components/artworks/SwipeDeck.tsx:169-182](src/components/artworks/SwipeDeck.tsx#L169-L182) — `EmptyDeck`, the sole terminal state
- [src/app/(app)/app/page.tsx:8-12](<src/app/(app)/app/page.tsx#L8-L12>) — post-login role router, the narrowest gate candidate
- [src/lib/auth/dal.ts:98-106](src/lib/auth/dal.ts#L98-L106) — `requireArtist`, the pattern a `requireOnboarded` would follow
- [src/utils/supabase/proxy.ts:54-67](src/utils/supabase/proxy.ts#L54-L67) — existing path-based redirect logic
- [src/app/actions/profile.ts:37-73](src/app/actions/profile.ts#L37-L73) — `becomeArtist`, the guided-flow Server Action precedent
- [src/components/ui/Field.tsx:34-127](src/components/ui/Field.tsx#L34-L127) — the only form primitive; input / textarea / file, no multi-select

## Architecture Insights

- **RLS is the security boundary, everywhere.** Every table gates on `auth.uid()`; `swipe_deck`
  is `security invoker` *deliberately* so it "grants no access the caller does not already have".
  Any onboarding table inherits this contract — an ownership predicate on all four verbs.
- **Auth decisions never read the JWT's user-editable parts.** `getAuthUser` returns a narrow DTO
  and `role` is read from `profiles`, never from claims ([dal.ts:36-37, 54-58](src/lib/auth/dal.ts#L36-L37)).
  An onboarding-state flag must follow the same rule: DB-authoritative, not metadata.
- **Two-layer guarding.** The proxy redirect is optimistic; the layout's `requireProfile()` is
  authoritative. An onboarding gate placed only in the proxy would be bypassable.
- **The deck is a one-shot server fetch.** `/discover` is `force-dynamic`, the client holds a
  fixed array, and `recordInteraction` revalidates only `/liked`. Onboarding that changes what
  the deck contains takes effect on the *next* page load, not mid-stack.
- **Ordering is the only gap.** The roadmap's baseline analysis found FR-004 and FR-006 already
  satisfied; the real gaps are the `created_at desc` sort and the missing refill
  ([roadmap.md:74-79](context/foundation/roadmap.md#L74-L79)).

## Historical Context (from prior changes)

- [context/archive/2026-09-10-ranking-eval-corpus/judgment.md](context/archive/2026-09-10-ranking-eval-corpus/judgment.md) — the manual walkthrough and its recorded pre-S-01 baseline, including the "cold-start deck must not change" expectation (Walk B) and the answer to Open Question 4 (untagged pieces sit wherever `created_at` puts them: positions 7, 13, 16)
- [context/archive/2026-09-10-ranking-eval-corpus/plan.md:286-287](context/archive/2026-09-10-ranking-eval-corpus/plan.md#L286-L287) — the warm/cold collector split in the seed corpus
- [context/foundation/roadmap.md:124-136](context/foundation/roadmap.md#L124-L136) — `S-03: cold-start-and-untagged-placement`, status `blocked` on Open Questions 2 and 4
- [context/foundation/roadmap.md:112-122](context/foundation/roadmap.md#L112-L122) — `S-02: continuous-deck-refill`, status `ready`; explains the premature-`EmptyDeck` behavior a new collector hits
- [context/foundation/lessons.md](context/foundation/lessons.md) — "Never block a user-visible mutation on a third-party AI call"; relevant only if onboarding ever calls `src/lib/ai/`
- [context/foundation/test-plan.md:31,33](context/foundation/test-plan.md#L31-L33) — Risks 3 and 5: one collector's taste leaking to another user, and a lost/double-written swipe verdict corrupting the taste signal with no un-like affordance

## Related Research

None — this is the first research artifact for this change, and the first anywhere in
`context/` to address collector onboarding.

## Open Questions

1. **Is this change one thing or two?** Taste bootstrap needs a migration, an RLS policy, a new
   UI primitive, and reconciliation with four PRD positions. First-run orientation needs a copy
   change and a zero-state branch in an existing component. They share only the trigger
   ("collector is new") and could ship independently.
2. **Does the taste bootstrap write `interactions` rows or a new preference store?** Rating real
   starter artworks needs no schema change and keeps FR-003 literally true; a tag picker needs a
   migration and contradicts it. This is the single biggest fork in the design space.
3. **Does onboarding supersede PRD Open Question 2 (the like threshold)?** If every collector
   arrives with signal, the threshold that currently blocks `S-03` may not need an answer — but
   `S-03` is a roadmap slice, so this is a roadmap decision, not a plan decision.
4. **Is onboarding mandatory or skippable?** This determines whether a gate is needed at all, and
   if so at which of the four insertion points. A skippable flow re-raises the cold-start
   fallback question for anyone who skips.
5. **How does `S-02: continuous-deck-refill` interact?** It is `ready` and unblocked, and it fixes
   the misleading `EmptyDeck` a new collector hits after 20 cards — which is arguably a
   first-run problem being solved by a different slice already.
6. **Who updates `judgment.md`?** The Walk B expectation ("cold-start deck must not change")
   becomes wrong the moment a taste bootstrap ships. Left unamended, the next run reads success
   as a regression.
