---
project: ArtSwipe
version: 1
status: draft
created: 2026-09-09
updated: 2026-09-09
prd_version: 1
main_goal: market-feedback
top_blocker: external
---

# Roadmap: ArtSwipe — AI Enrichment for Artwork Uploads

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

ArtSwipe matches independent artists' pieces to collectors, and that matching depends on
a dense, consistent descriptive signal per artwork. Today that signal does not exist:
artists won't do metadata work, so pieces arrive with thin free-text descriptions and few
or no tags. This change derives the signal from the uploaded image instead of asking the
artist for it — per-field suggestions on the upload form, plus an automatic top-up at
publish so no piece lands under-tagged. It produces the tag signal only; consuming it in
swipe ranking belongs to a separate future change.

## North star

**S-01: Artist fills the tags field from the image** — the first moment a human judges real
model output, which is the one thing Phase 1 could not prove on its own.

> "North star" here means: the smallest end-to-end slice whose successful delivery would
> prove the core product bet — placed as early as its Prerequisites allow, because
> everything downstream only matters if this works. The bet is that image-derived tags are
> good enough that an artist accepts them rather than retyping. The riskiest assumption —
> the belief that, if wrong, invalidates the most downstream work — is exactly that, and
> it stays untested until a suggestion appears on a real upload form.

## At a glance

| ID   | Change ID                      | Outcome (user can …)                                             | Prerequisites | PRD refs                       | Status   |
| ---- | ------------------------------ | ---------------------------------------------------------------- | ------------- | ------------------------------ | -------- |
| S-01 | `tags-assist-on-upload`        | Fill the tags field from the uploaded image and edit the result   | —             | US-01, FR-001, FR-002, FR-004, FR-005, FR-006 | ready    |
| S-02 | `description-assist-on-upload` | Fill the description field from the uploaded image and edit it    | S-01          | US-01, FR-001, FR-002, FR-005, FR-006 | proposed |
| S-03 | `publish-time-baseline-tagging`| Publish a thinly-tagged piece and still have it land well tagged  | S-01          | FR-003, FR-004, FR-005, FR-006 | proposed |

## Baseline

What's already in place in the codebase as of `2026-09-09` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Next.js 16 App Router, React 19, Tailwind v4. Upload form at
  `src/components/artworks/ArtworkForm.tsx`; shared input at `src/components/ui/Field.tsx`.
- **Backend / API:** present — Server Actions in `src/app/actions/` (`artworks.ts` owns
  create/update/delete); request interception in `src/proxy.ts`.
- **Data:** present — Supabase Postgres, 8 migrations. `artworks.tags text[]` with a GIN
  index (`20260909160100_add_artworks.sql`), ceiling already raised to 20
  (`20260909214144_raise_artwork_tag_limit.sql`). FR-004's storage shape exists.
- **Auth:** present — Supabase email/password, DAL at `src/lib/auth/dal.ts`, RLS as the
  security boundary. PRD declares no access-control changes.
- **Deploy / infra:** present — Vercel, with `.github/workflows/verify.yml` and
  `migrations.yml` green on every push.
- **Observability:** partial — `@vercel/analytics` only. No error tracking and no logging of
  enrichment outcomes (see Open Roadmap Question 6).
- **AI enrichment service:** present — Phase 1 of `context/changes/ai-artwork-enrichment`
  merged in PR #4. `src/lib/ai/enrich.ts` is a complete OpenRouter vision call (three-model
  fallback chain, 25s shared budget, never throws — failure is returned as data),
  `src/lib/ai/schema.ts` holds the JSON contract and `MIN_GENERATED_TAGS = 5`,
  `src/lib/ai/taxonomy.ts` holds a 5-facet controlled vocabulary. Unit-tested in
  `test/lib/ai.test.ts` with an opt-in live harness at `test/smoke/enrich.live.ts`.
  **Not wired to anything** — no transport, no form controls, no publish-time top-up.

## Foundations

**None.** This is deliberate, not an omission.

The only genuine cross-cutting enabler this PRD implies — a single, failure-tolerant place
that turns an artwork image into a validated suggestion — already landed and is recorded
under `## Baseline` above. Every remaining piece of work (the Server Action transport, the
client-side downscale, controlled-value support in `Field`) has exactly one first consumer,
S-01, and postponing it would not make S-01 unplannable, unsafe or unverifiable. Per the
progressive-disclosure rule those elements are introduced inside S-01 rather than promoted
to a foundation that would deliver no user-visible outcome of its own.

## Slices

### S-01: Artist fills the tags field from the image

- **Outcome:** An artist on the upload form can trigger assistance on the tags field and get
  image-derived tags they can edit, extend or clear before publishing, while every other
  field stays interactive and publish stays enabled.
- **Change ID:** `tags-assist-on-upload`
- **PRD refs:** US-01, FR-001 (tags half), FR-002, FR-004, FR-005, FR-006
- **Prerequisites:** — (the enrichment service is present per `## Baseline`)
- **Parallel with:** —
- **Blockers:** OpenRouter free vision roster availability. `src/lib/ai/enrich.ts` pins three
  free models and its own comment flags the roster as volatile; if all three 404, every
  slice on this roadmap stalls until the catalogue is re-checked and re-measured. Not
  unilaterally resolvable — it is a third party's model catalogue.
- **Unknowns:**
  - Does an untouched earlier AI suggestion count as "content the artist entered" for the
    no-overwrite rule — i.e. may a re-run replace it? (PRD Open Question 5) — Owner: user.
    Block: no. A defensible default exists (a re-run replaces a suggestion the artist never
    touched, never one they edited); `/10x-plan` can proceed on it and the answer changes a
    behaviour detail, not the slice's shape.
  - Does the free-tier daily request cap (50/day) need lifting before this can be exercised
    live? `change.md` records an intent to buy $10 of OpenRouter credit for 1000/day —
    Owner: user. Block: no. Resolvable unilaterally; only affects how much live testing fits
    in a day.
- **Risk:** Sequenced first because it is the north star and has no prerequisites — the
  model call, its vocabulary and its latency are already proven, so this is the first slice
  that tests the part Phase 1 could not: whether the output is good enough for an artist to
  keep. The thing that could go wrong is a quality verdict, not a technical one — if tags
  read as generic, that finding arrives before S-02 and S-03 are built on the same pattern,
  which is precisely why it goes first.
- **Status:** ready

### S-02: Artist fills the description field from the image

- **Outcome:** An artist can trigger assistance on the description field and get an
  image-derived paragraph they can edit or discard, with the same non-blocking progress and
  recoverable-error behaviour as the tags field.
- **Change ID:** `description-assist-on-upload`
- **PRD refs:** US-01, FR-001 (description half), FR-002, FR-005, FR-006
- **Prerequisites:** S-01 (reuses its transport and its assistance-control pattern)
- **Parallel with:** S-03
- **Blockers:** — (inherits S-01's roster exposure; nothing additional)
- **Unknowns:**
  - Same no-overwrite question as S-01 (PRD Open Question 5), and it bites harder here: a
    description is long free text an artist may have half-typed, where tags are discrete —
    Owner: user. Block: no.
- **Risk:** Sequenced after S-01 because it reuses that slice's transport and control
  pattern, and because tags carry the recommendation signal the PRD exists to produce while
  description does not. It is not a leftover: generated prose is the output an artist is
  most likely to reject on voice grounds, and it carries its own concerns — the 2000-char
  cap in `MAX_DESCRIPTION_LENGTH`, and partial-edit overwrite semantics on a long field.
  Running it against S-01's verdict is cheaper than discovering both problems at once.
- **Status:** proposed

### S-03: No piece is published under-tagged

- **Outcome:** An artist who publishes a piece with fewer than the minimum tags still ends
  up with a well-tagged artwork, without any extra step and without a slower publish.
- **Change ID:** `publish-time-baseline-tagging`
- **PRD refs:** FR-003, FR-004, FR-005, FR-006
- **Prerequisites:** S-01 (the suggestion already fetched on the form is carried into the
  submission, so the common case costs no second model call)
- **Parallel with:** S-02
- **Blockers:** —
- **Unknowns:**
  - Should the top-up merge only vocabulary tags, or may an artist's free-text tags count
    toward the minimum on their own? (PRD Open Question 1 is answered for *generated* tags —
    the controlled vocabulary shipped in `taxonomy.ts` — but the merge rule across the two
    kinds is not) — Owner: user. Block: no. The shipped `MIN_GENERATED_TAGS = 5` and the
    20-tag ceiling bound the answer.
- **Risk:** Sequenced after S-01 so the cached-suggestion path exists and the guardrail
  "the number of AI operations per upload is bounded and known" is satisfiable by design
  rather than by hope. The failure mode to watch is publish latency: this runs on the
  publish path, and the PRD guardrail says publishing must not get visibly slower, so a
  top-up failure has to be swallowed rather than surfaced. Parallel with S-02 because
  neither touches the other's surface — a separate agent run can take it.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                       | Suggested issue title                                        | Ready for `/10x-plan` | Notes |
| ---------- | ------------------------------- | ------------------------------------------------------------ | --------------------- | ----- |
| S-01       | `tags-assist-on-upload`         | Add AI tag assistance to the artwork upload form              | yes                   | Overlaps Phases 2 + 3 (tags half) of the existing `context/changes/ai-artwork-enrichment` plan — continue that change with `/10x-implement` instead of re-planning, unless you want the narrower slice boundary. |
| S-02       | `description-assist-on-upload`  | Add AI description assistance to the artwork upload form      | no                    | Blocked on S-01 only. Corresponds to the description half of that plan's Phase 3. |
| S-03       | `publish-time-baseline-tagging` | Top up artwork tags at publish when the artist supplied few   | no                    | Blocked on S-01 only. Corresponds to that plan's Phase 4. Runs parallel with S-02. |

## Open Roadmap Questions

1. **Should artist images sent for AI analysis carry a data-retention / no-training
   guarantee from the third-party processor?** — Owner: user. Block: roadmap-wide. This is
   the one open question that could invalidate the current free-model roster outright and
   therefore every slice; it was not selected as a hard requirement during shaping, so
   confirm whether it belongs in the PRD at all.
2. **Which fields' prior AI suggestions count as "content the artist entered" for the
   no-overwrite rule?** — Owner: user. Block: S-01, S-02 (non-blocking; a default exists).
3. **Is there a Secondary success outcome for this change?** `### Secondary` in the PRD is
   still a TODO after the original nice-to-have became a Non-Goal — Owner: user. Block: none.
4. **What happens to artworks uploaded before this change — is retro-tagging planned as a
   follow-up?** — Owner: user. Block: none (Non-Goal here; affects the roadmap after this one).
5. **Can a logged-out visitor swipe or view artwork pages, or is all of it behind
   authentication?** — Owner: user. Block: none. Does not affect these slices; the PRD
   should state it.
6. **How is a model-roster failure or a per-upload operation count observed in production?**
   — Owner: user. Block: none. Raised by this roadmap, not the PRD: the guardrail "the
   number of AI operations triggered by one artwork upload is bounded and known" implies
   some signal, and `## Baseline` reports observability as partial. Not scoped as a slice
   here because no PRD requirement demands it.

**Resolved by shipped code — recorded for PRD reconciliation, no action needed:**
PRD Open Question 1 (controlled vocabulary vs free text) — answered: generated tags draw
from the controlled vocabulary in `src/lib/ai/taxonomy.ts`, artist-typed tags stay free
text. PRD Open Question 2 (minimum tag count N) — answered: `MIN_GENERATED_TAGS = 5` in
`src/lib/ai/schema.ts`. PRD Open Question 3 (latency target) — answered: a 25s shared budget
across the fallback chain, set from live measurement (`src/lib/ai/enrich.ts`). PRD Open
Question 9 — resolved during shaping.

## Parked

- **The recommendation engine.** Why parked: PRD §Non-Goals — this change produces and
  stores the tag signal only; consuming it in swipe ranking is a separate future change and
  no recommender is defined yet.
- **A "bulk" assistance action that fills all empty fields at once.** Why parked: PRD
  §Non-Goals — cut during shaping to protect the three-week delivery window.
- **AI assistance on the title field.** Why parked: PRD §Non-Goals — the title is the
  artist's own voice and carries little recommendation signal.
- **Retro-tagging of existing artworks.** Why parked: PRD §Non-Goals — a separable batch job
  with its own cost profile. See Open Roadmap Question 4.
- **Any change to the collector swipe/like experience.** Why parked: PRD §Non-Goals — swipe
  behaviour change belongs to the future recommendation work.
- **New user roles or auth changes.** Why parked: PRD §Non-Goals — the feature fits inside
  the existing authenticated-artist boundary.

## Done

(Empty on first generation. `/10x-archive` appends here when a change whose Change ID
matches a roadmap item is archived.)
