---
project: ArtSwipe
version: 1
status: draft
created: 2026-09-09
context_type: brownfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  delivery_weeks: 3
  hard_deadline: null
  after_hours_only: false
---

# ArtSwipe — AI Enrichment for Artwork Uploads

## Current System Overview

- **Purpose:** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.
- **Architecture:** Next.js 16 (App Router) web app deployed on Vercel; Supabase as the backend (Postgres, Auth, Storage). Server Actions handle mutations.
- **Tech stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod, Vercel Analytics. Artwork images are stored in a Supabase Storage bucket (`ARTWORKS_BUCKET`) and served via public object URLs.
- **Users:** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.
- **Core functionality today:**
  - **Artist mode:** upload artwork image(s) with a title and description; manage own pieces (studio / artist routes).
  - **Collector mode:** swipe through artworks, express interest (like), view liked artworks (`discover` / `liked` routes).
  - **Recommendations:** there is no recommendation algorithm yet — swipe surfaces artworks without personalized ranking. A tag-aware recommender is planned as a separate future change.
  - **Transactions:** collectors reach out to buy, or reach out to auction on external platforms. All payment/auction activity happens off-platform.
  - **Auth:** email/password authentication (signup / login / email confirm), with collector and artist onboarding flows.

## Problem Statement & Motivation

Artists posting to ArtSwipe won't do manual metadata work. Every extra field on the upload screen is a reason to abandon a post, so pieces arrive with thin, inconsistent, free-text descriptions and no structured attributes. ArtSwipe's value proposition — matching the right collector to the right piece — depends on a dense, normalized descriptive signal per artwork, and today that signal does not exist. The gap is sharpest for brand-new uploads: with no swipe history and no structured tags, a new piece has nothing for a future recommendation capability to work with. There is no current workaround — pieces are either tagged manually (rare) or go effectively untagged.

This change is worth making now because the recommendation work that depends on this signal is the next major step, and starting that work against thin data would waste it. The insight: the structured signal can be derived from the uploaded image itself, automatically, instead of asked of the artist. This change adds an AI enrichment capability that the existing upload flow calls to suggest descriptive text and tags from the image, and that fills in baseline tags automatically when the artist's own tags are too few — keeping artist effort near zero while giving every piece a consistent descriptive signal from the moment it exists.

## User & Persona

**Primary persona — the artist.** An independent visual artist posting a finished piece to ArtSwipe to get it in front of collectors. The moment that matters is the upload screen: they want to post the image and move on, not fill out a tagging form. This change removes that form work by doing it for them. Their experience changes directly: assistance controls appear on the description and tags fields, and pieces they publish are consistently tagged.

**Secondary persona — the collector.** Someone swiping to discover art to buy or bid on. Their experience does not change in this release. They benefit later and indirectly: once a recommendation capability exists, the AI-derived tags make matches sharper, especially for fresh uploads. (During shaping the owner rated both personas equally important; the artist is named primary because both the friction and the insight live at upload.)

## Success Criteria

### Primary

- The assistance-enabled upload flow works end to end: an artist uploading a piece can fill the description field and the tags field from the image with a single action each, edit the results freely, and publish. Any piece whose artist-entered tags are below the minimum count still ends up adequately tagged via automatic baseline tagging at publish.

### Secondary

# TODO: secondary success outcome — see Open Questions

### Guardrails

- Upload stays fully usable when the AI is unavailable, failing, or slow — AI is never a hard dependency of publishing a piece. A failed or timed-out suggestion surfaces as a non-blocking, recoverable state on the affected field.
- Publishing is not visibly slower after this change; no step in the upload flow blocks waiting on an AI response.
- A single-field suggestion resolves quickly enough that the artist keeps working in the same session, with continuous visible progress from the request until it resolves or fails. (Exact latency target — Open Questions.)
- The AI never overwrites content the artist has entered or edited; every suggestion is opt-in per field and remains editable.
- The number of AI operations triggered by one artwork upload is bounded and known regardless of artist behavior — no path to runaway per-artwork cost.
- The existing upload, studio-management, and collector swipe/like flows continue to work with no behavioral change.

## User Stories

### US-01: Artist fills upload fields with AI assistance

- **Given** an authenticated artist on the artwork upload form with an image selected
- **When** they trigger the assistance control on the description field or the tags field
- **Then** that field populates with an image-derived suggestion they can edit or clear, while the rest of the form stays interactive and the publish action stays enabled

_Before this change: the artist typed every field manually with no assistance; artworks carried only a free-text description and whatever tags the artist chose to add._

#### Acceptance Criteria

- The assistance control is available on the description field and the tags field. The title field has no assistance control.
- Triggering assistance shows a visible progress indication on that field only; all other fields remain editable and publish is never disabled by an in-flight AI request.
- An AI suggestion never replaces text the artist has already entered or edited in a field without an explicit action on that field's control.
- If an AI request fails, the field shows a non-blocking error and the artist can type the value manually.
- A piece published with fewer than the minimum tag count receives baseline tags automatically at publish, so no artwork is published under-tagged.

## Scope of Change

### New

- FR-001: An artist can request an AI suggestion for the description field and the tags field via each field's assistance control. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "only tags carry recommendation signal — title/description assist is scope for little gain." Resolution: narrowed. Assistance covers **description + tags** only this change; the title stays the artist's own voice; broader text assist is deferred (see Non-Goals).
- FR-002: An artist can edit or discard any AI suggestion before publishing; accepting a suggestion is per-field and optional. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "pure opt-in keeps the tag signal thin — artists will ignore suggestions." Resolution: kept as opt-in. FR-003's automatic baseline tagging is the coverage backstop, so opt-in on the artist-facing controls is safe.
- FR-003: The system generates a baseline set of tags for an artwork at publish time when the artist-entered tags are below a minimum count, so no piece is published with too few tags. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "an AI operation on every publish is the cost/latency exposure the guardrails flag." Resolution: revised. The baseline operation runs only when the artwork has fewer than N tags after artist input — artists who tag well incur no AI operation. N is an Open Question.
- FR-004: The system persists the resulting tags on the artwork record as a simple list, so a future recommendation capability can consume them. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "designing storage for a recommender that isn't defined risks the wrong shape." Resolution: kept, minimal. Persist a loose list of string tags on the artwork — no recommender-specific modeling; the future change owns any richer structure.

### Preserved

- FR-005: An artist can complete an upload and publish a piece with the AI unavailable or failing, filling every field manually. Priority: must-have. Change: preserved
  > Socrates: No counter-argument; stands as written.
- FR-006: The existing artwork upload, studio management, and collector swipe/like flows continue to function with no behavioral change from this work. Priority: must-have. Change: preserved
  > Socrates: Counter-argument considered: "the swipe flow SHOULD change to use the new tags." Resolution: kept frozen for this change. Consuming tags in swipe ranking is the future recommendation work's job (see Non-Goals).

### Removed from planned scope

- "Bulk" assistance that fills all empty fields in one action — considered during shaping, then cut to protect the delivery window. Recorded as a Non-Goal.

Note: the artist-facing tags field is a free-text multi-input; AI tag suggestions populate that same free-text field. This change adds no new fields to the upload form; it does add a persisted tag list on the artwork record.

## Constraints & Compatibility

- **Backward-compatible artwork records:** the artwork record gains a persisted list of tags. Existing artworks must remain valid with no tags — absent or empty tags is a normal state, not an error.
- **No new hard dependency for the core flow:** if the AI capability is unconfigured or unreachable, enrichment is unavailable but upload and publish continue to work (ties to FR-005).
- **Image storage and serving preserved:** enrichment reads artwork images through the existing image storage and serving mechanism; this change does not alter how images are stored or served.
- **Existing artworks preserved:** pieces uploaded before this change remain fully viewable and manageable with no tags unless a retro-tagging pass is run later (out of scope here — see Non-Goals and Open Questions).
- **Existing flows preserved:** upload, studio-management, and collector swipe/like flows must continue to work with no behavioral change.

## Business Logic Changes

This change **adds a new domain rule**. The current system makes no algorithmic decision about content (no recommender, no classification).

**The rule:** ArtSwipe derives a normalized set of descriptive tags for every artwork from its image, so each piece carries a consistent descriptive signal regardless of how much text its artist supplied.

The rule consumes the artwork image the artist uploads, together with whatever description and tags the artist chooses to type or accept. Its output is a list of descriptive tags stored with the artwork, plus optional draft text offered for the description field. The artist encounters it as per-field suggestions they accept or edit while completing the upload form; at publish, when the artist's own tags are below the minimum count, the rule fills the gap so no piece is published under-tagged. Collectors do not encounter the rule directly today — they will feel it later, as sharper matches, once a recommendation capability consumes the tags.

## Access Control Changes

No access control changes — the current model is preserved.

For reference, the preserved model: email/password authentication; every authenticated user is a collector by default (swipe, like, view, reach out); becoming an artist is a one-step capability unlock on the same account, not a separate account type; a single account can be both. The AI enrichment features are available to every artist and operate entirely within the existing "authenticated artist acting on their own artwork" boundary.

## Non-Goals

- **Not building the recommendation engine.** This change produces and stores the tag signal only. Consuming tags in swipe ranking is a separate future change. Rationale: no recommender is defined yet; keeping this change narrow protects the delivery window.
- **No "bulk" assistance action.** Filling all empty fields with one action is out of scope (cut during shaping). Rationale: delivery-window protection; per-field assistance delivers the core value.
- **No AI assistance on the title field.** Assistance covers description and tags only. Rationale: the title is the artist's voice and carries little recommendation signal.
- **No retro-tagging of existing artworks.** Enrichment applies only to new uploads; pieces uploaded before this change are not revisited. Rationale: retro-tagging is a separable batch job with its own cost profile.
- **No change to the collector swipe/like experience.** Rationale: swipe behavior change belongs to the future recommendation work.
- **No new user roles and no auth changes.** Rationale: the feature fits within the existing authenticated-artist boundary.

## Open Questions

1. **Does automatic baseline tagging use a controlled vocabulary, or free text like the artist-facing tags field?** — Owner: user. Consequence: determines how useful the persisted tags are to the future recommendation capability.
2. **What is the minimum tag count (N) below which automatic baseline tagging runs (FR-003)?** — Owner: user.
3. **What is the latency target for a single-field suggestion?** "Feels prompt" was accepted during shaping; the Guardrail needs a number. — Owner: user.
4. **Should artist images sent for AI analysis carry a data-retention / no-training guarantee from the third-party processor?** Not selected as a hard requirement during shaping; confirm whether it belongs in this PRD. — Owner: user.
5. **Which fields' prior AI suggestions count as "content the artist entered" for the no-overwrite rule** (e.g. does an untouched earlier suggestion block a re-run)? — Owner: user.
6. **Is there a Secondary success outcome for this change?** The original nice-to-have ("bulk" assistance) became a Non-Goal and no replacement was chosen; `### Secondary` is a TODO until this resolves. — Owner: user.
7. **Can a logged-out visitor swipe or view artwork pages, or is all of it behind authentication?** Does not affect this change but the PRD should state it. — Owner: user.
8. **What happens to artworks uploaded before this change — is retro-tagging planned as a follow-up?** — Owner: user. (Related to Non-Goals.)
9. **Whether "improve collector recommendations" belongs in this change** — resolved during shaping: out of scope, recorded as a Non-Goal. Listed here for traceability; no action needed.

_Shaping quality cross-check passed with all six brownfield elements present (Access Control, Business Logic, project artifacts, timeline-cost acknowledgement, Non-Goals, preserved behavior). No cross-check gaps to mirror._
