---
project: ArtSwipe
context_type: brownfield
created: 2026-09-09
updated: 2026-09-09
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "AI scope for this change"
      decision: "auto-tag art from image; draft artist title/description; persist tags for a future recommender"
    - topic: "change framing"
      decision: "new standalone AI enrichment module invoked by the existing upload flow"
    - topic: "primary persona"
      decision: "artist (upload-time friction); collector is secondary beneficiary"
    - topic: "insight"
      decision: "artists won't do manual tagging; derive the signal from the image instead"
  frs_drafted: 6
  quality_check_status: accepted
---

# Shape Notes — ArtSwipe (brownfield)

Discovery complete (phases 1–7). Ready for `/10x-prd`. Body sections below are ordered to match the 11-section brownfield PRD template.

## PRD frontmatter scaffold (product-level priors)

- `project`: ArtSwipe
- `context_type`: brownfield
- `product_type`: web-app _(existing; unchanged by this work)_
- `target_scale`: `{ users: small, qps: low, data_volume: small }` _(no real user base yet; confirm in Phase 6)_
- `timeline_budget`: `{ delivery_weeks: 3, hard_deadline: null, after_hours_only: false }` _(owner confirmed 3 weeks feasible in Phase 3; Phase 6: worked as part of day-job, not after-hours)_

## Current System

- **Purpose:** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.
- **Architecture:** Next.js 16 (App Router) web app deployed on Vercel; Supabase as the backend (Postgres, Auth, Storage). Server Actions used for mutations.
- **Tech stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod, Vercel Analytics. Artwork images are stored in a Supabase Storage bucket (`ARTWORKS_BUCKET`), served via public object URLs.
- **Users:** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.
- **Core functionality today:**
  - **Artist mode:** upload artwork image(s) with a title and description; manage own pieces (studio / artist routes).
  - **Collector mode:** swipe through artworks, express interest (like), view liked artworks (`discover` / `liked` routes).
  - **Recommendations:** there is **no recommendation algorithm yet** — swipe currently surfaces artworks without personalized ranking. A tag-aware recommender is planned as a separate future change.
  - **Transactions:** collectors reach out to buy, or reach out to auction on external platforms. All payment/auction activity happens off-platform.
  - **Auth:** Supabase email/password (signup / login / email confirm), split into collector and artist flows.

## Vision & Problem Statement

Artists posting to ArtSwipe won't do manual metadata work. Every extra field on the upload screen is a reason to abandon a post, so pieces arrive with thin, inconsistent, free-text descriptions and no structured attributes. ArtSwipe's value proposition — matching the right collector to the right piece — depends on a dense, normalized signal per artwork, and today that signal doesn't exist. The problem is sharpest for brand-new uploads: with no swipe history and no structured tags, a new piece has nothing for a future recommender to work with.

The insight driving this change: the structured signal can be derived from the uploaded image itself, automatically, instead of asked of the artist. This change adds a **new AI enrichment module**. The existing upload flow calls it to (a) suggest descriptive tags for the tags field and (b) draft editable text for the description field, both derived from the image; and at publish it fills in baseline tags when the artist's own tags are too few. The tags are persisted on the artwork so a future recommendation engine can consume them. The title field, the collector swipe flow, and the external buy/auction hand-off are unchanged by this work.

## User & Persona

**Primary persona — the artist.** An independent visual artist posting a finished piece to ArtSwipe to get it in front of collectors. The moment that matters is the upload screen: they want to post the image and move on, not fill out a tagging form. This change removes that form by doing the work for them.

**Secondary persona — the collector.** Someone swiping to discover art to buy or bid on. Benefits indirectly and later: once a recommender exists, the AI-derived tags make matches sharper, especially for fresh uploads. (The owner rated both personas equally important; the artist is named primary because both the friction and the insight live at upload.)

## Access Control

**Current model (unchanged by this work).** Supabase email/password auth. One account type — every authenticated user is a collector by default (can swipe, like, view artworks, reach out). Becoming an artist is a capability unlock, not a separate account: the user completes one extra onboarding step, after which they can upload and manage their own artworks. A single account can be both collector and artist.

**Changes in this work:** none. No new roles, no changed role boundaries. Every artist can use the AI enrichment features; the feature operates entirely within the existing "authenticated artist acting on their own artwork" boundary. `No access control changes — current model preserved.`

## Success Criteria

### Primary

- The sparkle-assisted upload flow works end to end: an artist uploading a piece can fill the description field and the tags field from the image with a single click each, edit the results freely, and publish. Any piece whose artist-entered tags are below the minimum count still ends up adequately tagged via server-side baseline tagging at publish.

### Secondary

- _(The Phase-3 nice-to-have "bulk sparkle" was cut during the Socrates round and recorded as a Non-Goal. No replacement secondary outcome was set — see Open Question 9.)_

### Guardrails

- Upload stays fully usable when the AI is unavailable, failing, or slow — AI is never a hard dependency of publishing a piece.
- Publishing is not visibly slower after this change; no step in the upload flow blocks waiting on an AI response.
- The AI never overwrites content the artist has entered or edited; every suggestion is opt-in per field and remains editable.
- Per-upload AI cost stays bounded and predictable — no path to runaway cost per artwork.

## Functional Requirements

### AI enrichment (new module)

- FR-001: An artist can request an AI suggestion for the description field and the tags field via each field's sparkle control. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "only tags carry recommendation signal — title/description assist is scope for little gain." Resolution: narrowed. Sparkle assist covers **description + tags** only this change; the title stays the artist's own voice; broader text assist is deferred (see Non-Goals).
- FR-002: An artist can edit or discard any AI suggestion before publishing; accepting a suggestion is per-field and optional. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "pure opt-in keeps the tag signal thin — artists will ignore suggestions." Resolution: kept as opt-in. FR-003's server-side baseline tagging is the coverage backstop, so opt-in on the artist-facing controls is safe.
- FR-003: The system generates a baseline set of tags for an artwork at publish time when the artist-entered tags are below a minimum count, so no piece is published with too few tags. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "an AI call on every publish is the cost/latency exposure the guardrails flag." Resolution: revised. The baseline call runs only when the artwork has fewer than N tags after artist input — artists who tag well incur no call. N is an Open Question.
- FR-004: The system persists the resulting tags on the artwork record as a simple list, so a future recommendation engine can consume them. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "designing storage for a recommender that isn't specced risks the wrong shape." Resolution: kept, minimal. Persist a loose list of string tags on the artwork — no recommender-specific modeling; the future change owns any richer structure.

### Preserved

- FR-005: An artist can complete an upload and publish a piece with the AI unavailable or failing, filling every field manually. Priority: must-have. Change: preserved
  > Socrates: No counter-argument; stands as written.
- FR-006: The existing artwork upload, studio management, and collector swipe/like flows continue to function with no behavioral change from this work. Priority: must-have. Change: preserved
  > Socrates: Counter-argument considered: "the swipe flow SHOULD change to use the new tags." Resolution: kept frozen for this change. Consuming tags in swipe ranking is the deferred recommender's job (see Non-Goals).

Dropped during Socrates: former FR "bulk sparkle — fill all empty fields at once" (was nice-to-have). Cut to protect the 3-week budget; recorded as a Non-Goal / future addition.

Note: the artist-facing tags field is a free-text multi-input (chips); AI tag suggestions populate that same free-text field. This change adds no new fields to the upload form; it does add a persisted tag list on the artwork record.

## User Stories

### US-01: Artist fills upload fields with AI assistance

- **Given** an authenticated artist on the artwork upload form with an image selected
- **When** they click the sparkle control on the description field or the tags field
- **Then** that field populates with an image-derived suggestion they can edit or clear, while the rest of the form stays interactive and the publish action stays enabled

#### Acceptance Criteria

- The sparkle control is available on the description field and the tags field. The title field has no sparkle control.
- Clicking a sparkle shows an inline loading state on that field only; all other fields remain editable and publish is never disabled by an in-flight AI call.
- An AI suggestion never replaces text the artist has already entered or edited in a field without an explicit click on that field's control.
- If an AI request fails, the field shows a non-blocking error and the artist can type the value manually.
- A piece published with fewer than the minimum tag count receives server-side baseline tags at publish, so no artwork is published under-tagged.

## Business Logic

ArtSwipe derives a normalized set of descriptive tags for every artwork from its image, so each piece carries a consistent descriptive signal regardless of how much text its artist supplied.

This is a **new domain rule** — before this change ArtSwipe made no algorithmic decision about content (no recommender, no classification).

The rule consumes the artwork image the artist uploads, together with whatever description and tags the artist chooses to type or accept. Its output is a list of descriptive tags persisted with the artwork, plus optional draft text offered for the description field. The artist encounters it as per-field suggestions they accept or edit while completing the upload form; at publish, when the artist's own tags are below the minimum count, the rule fills the gap so no piece is published under-tagged. Collectors do not encounter the rule directly today — they will feel it later, as sharper matches, once a recommendation engine consumes the tags.

## Constraints & Preserved Behavior

- **Artwork schema change:** persisting the tag list requires a schema change / migration on the artworks table. Existing artwork rows must remain valid with no tags (absent/empty tags is a normal state, not an error).
- **No new hard deploy-time dependency for the core flow:** if an AI provider credential is missing or the provider is unreachable, enrichment degrades to unavailable but upload and publish continue to work (ties to FR-005).
- **Image storage/serving preserved:** enrichment reads artwork images from the existing Supabase Storage bucket and public-URL scheme; this change does not alter how images are stored or served.
- **Pre-change artworks preserved:** artworks uploaded before this change remain fully viewable and manageable with no tags unless a backfill is run later (backfill is a Non-Goal for this change; see Open Questions).

## Non-Functional Requirements

- A single-field sparkle suggestion resolves quickly enough that the artist keeps working in the same session; the field shows continuous visible progress from the click until the suggestion resolves or fails. (Exact latency target — Open Question.)
- The number of AI model calls triggered by one artwork upload is bounded and known regardless of artist behavior — there is no path to unbounded per-artwork AI spend.
- An AI request that fails or times out surfaces as a non-blocking, recoverable state on the affected field and never prevents the artist from publishing.

## Non-Goals

- **Not building the recommendation engine.** This change produces and persists the tag signal only. Consuming tags in swipe ranking is a separate future change. Rationale: no recommender is specced; keeping this change narrow protects the timeline.
- **No "bulk sparkle" action.** Filling all empty fields with one click is out of scope (dropped during the Socrates round). Rationale: budget protection; per-field assist delivers the core value.
- **No AI assistance on the title field.** Sparkle assist covers description + tags only. Rationale: the title is the artist's voice; title carries little recommendation signal.
- **No backfill of existing artworks.** Enrichment is forward-only for new uploads; pieces uploaded before this change are not retro-tagged. Rationale: backfill is a separable batch job with its own cost profile.
- **No change to the collector swipe/like experience.** Rationale: swipe behavior change belongs to the deferred recommender.
- **No new user roles or auth changes.** Rationale: the feature fits entirely within the existing authenticated-artist boundary.

## Open Questions

1. ~~Does "improve collector recommendations" belong in this change?~~ **RESOLVED (Phase 3): out of scope.** This change produces and persists the tag signal only. Building the recommender that consumes it is a separate future change. Recorded as a Non-Goal.
2. **Does the backend baseline auto-tagging (FR-003) use any normalized vocabulary?** The artist-facing tags field is free text (resolved Phase 4). Open: whether server-side baseline tags are also free text or drawn from a controlled set of dimensions (style, medium, subject, palette, mood) for future recommender quality. — Owner: user.
3. **What happens to artworks uploaded before this change?** Backfill enrichment, or forward-only? — Owner: user.
4. **Can a logged-out visitor swipe or view artwork pages, or is all of it behind auth?** Not confirmed this session; doesn't affect the AI change but the PRD should state it. — Owner: user.
5. **What is the minimum tag count (N) below which server-side baseline tagging runs (FR-003)?** — Owner: user.
6. **Which fields' AI suggestions count as "content the artist entered" for the no-overwrite rule?** e.g. does a prior AI suggestion the artist left untouched block a re-run? — Owner: user.
7. **What is the latency target for a single-field sparkle suggestion?** "Feels prompt" accepted in Phase 5; needs a number for the PRD NFR. — Owner: user.
8. **Should artist images sent for AI analysis have a data-retention / no-training guarantee from the provider?** Not selected as a hard NFR in Phase 5; confirm whether it belongs in the PRD. — Owner: user.
9. **Is there a Secondary success outcome for this change?** The original nice-to-have (bulk sparkle) became a Non-Goal; no replacement was chosen. — Owner: user.

## Quality cross-check

All six brownfield elements present at finalize — no gaps. `quality_check_status: accepted`.

- Access Control — present
- Business Logic (one-sentence rule) — present
- Project artifacts — present
- Timeline-cost acknowledged — present (delivery_weeks: 3)
- Non-Goals — present
- Preserved behavior — present

Open Questions above are ordinary unknowns for `/10x-prd` to route, not cross-check failures.
