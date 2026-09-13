---
project: ArtSwipe
context_type: brownfield
created: 2026-09-10
updated: 2026-09-10
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "ranking signal"
      decision: "personalized tag-match to collector's own liked artworks, not global popularity"
    - topic: "deck refresh"
      decision: "revised in Socrates round — continuous automatic refill, not an explicit request"
    - topic: "MVP scope"
      decision: "keep v1 simple — no explanations, no scoring"
    - topic: "cold start"
      decision: "collectors without enough likes get the existing unranked ordering"
    - topic: "preference signal stored"
      decision: "revised in Socrates round — likes only for v1; passes not stored"
    - topic: "scope of preservation"
      decision: "revised in Socrates round — liking and swipe interaction preserved; ordering explicitly changes"
  frs_drafted: 7
  quality_check_status: accepted
---

# Shape Notes — ArtSwipe Recommendation Engine (brownfield)

Shaping a new recommendation service that learns from a collector's likes and orders artworks by tag-match to those likes. Body sections below are ordered to match the 11-section brownfield PRD template.

## PRD frontmatter scaffold (product-level priors)

- `project`: ArtSwipe
- `context_type`: brownfield
- `product_type`: web-app _(existing; unchanged by this work)_
- `target_scale`: `{ users: small, qps: low, data_volume: small }` _(no real user base yet; unchanged by this work)_
- `timeline_budget`: `{ delivery_weeks: 3, hard_deadline: null, after_hours_only: false }`

## Current System

- **Purpose:** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.
- **Architecture:** Next.js 16 (App Router) web app deployed on Vercel; Supabase as the backend (Postgres, Auth, Storage). Server Actions used for mutations.
- **Tech stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod, Vercel Analytics. Artwork images are stored in a Supabase Storage bucket, served via public object URLs.
- **Current user base:** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.
- **Core functionality today:**
  - **Artist mode:** upload artwork with AI-assisted tagging; manage own pieces.
  - **Collector mode:** swipe through artworks (unranked), express interest (like), view liked artworks.
  - **AI enrichment:** (recently added) artworks have persisted AI-derived tags from image analysis; baseline tags auto-applied at publish if artist's tags are sparse.
  - **Auth:** Supabase email/password, split into collector and artist flows.
  - **Transactions:** collectors reach out to buy/auction off-platform.

## Vision & Problem Statement

Every collector is served artworks in the same order today, with no relationship to what that collector has liked. With the AI enrichment work now live, every artwork carries normalized, machine-readable tags — so the signal needed to order pieces per collector exists, and nothing consumes it. The missing piece is a recommendation service that learns from a collector's own likes and orders what they are served by how well each piece's tags match the tags on the pieces they liked.

Without personalization, collectors face discovery friction: they swipe past many unrelated pieces to reach art they would actually like. With tag-based ordering, collectors reach matching work sooner, and artists whose work matches a collector's demonstrated taste get more visibility to that collector.

## User & Persona

**Primary persona — the collector.** Someone swiping to discover art to buy or bid on. They've been liking pieces over time; the recommender learns from those likes and surfaces new pieces tagged similarly, cutting discovery friction.

**Secondary persona — the artist.** An independent visual artist whose work now ranks higher when it matches collectors' demonstrated taste, gaining visibility to interested buyers.

## Access Control

No changes planned — current model preserved. Authentication remains Supabase email/password; all authenticated users are collectors by default and can become artists via one-step onboarding. No new roles and no shifted role boundaries. The recommender operates entirely within the existing "authenticated collector acting on their own history" boundary: a collector's preferences are derived from their own likes and applied only to what they are served.

## Success Criteria

### Primary

A collector who keeps swiping is served artworks ordered by how well each piece's tags match the tags on the pieces they have liked, and that ordering sharpens as they like more. Personalization is per-collector, never a global popularity ranking. (Revised during the Socrates round: decks refill continuously as the collector swipes rather than on an explicit request — see FR-001.)

### Secondary

Keep v1 simple — no explanations, no recommendation scoring, no secondary outcomes.

### Guardrails

- Liking, the liked-artworks view, and the swipe interaction itself remain intact and functional. (Ordering and composition of what a collector is served are explicitly in scope to change — see FR-007.)
- A collector's likes and derived taste stay private to that collector.
- The project is in dev — acceptable to iterate and refactor for good reason; not production-critical.

## Functional Requirements

### Recommendation (new)

- FR-001: A collector is served further artworks automatically as they swipe, without asking for a new deck. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "an explicit deck request is friction — it adds a decision and a control the collector has to find." Resolution: revised. The original shape had the collector requesting a new deck every 10–20 cards; that request is dropped. Artworks refill continuously as they swipe, so ranking is felt rather than operated.
- FR-002: The system orders artworks by how closely each piece's tags match the tags on the artworks that collector has liked. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "raw tag overlap ranks crudely — it treats every tag as equally important, so 'blue' weighs the same as 'oil-on-canvas'." Resolution: kept for v1; simple tag-match is what ships in three weeks. How tags are weighted is unresolved and routed to Open Questions.
- FR-003: For this change, a collector's preferences come only from their own likes — never from a global or cross-collector popularity signal. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "ruling out global signal forever over-commits — a blend might be right once there are real users." Resolution: narrowed. The exclusion binds this change only; a future blend is left open rather than ruled out. Avoiding everyone-sees-the-same-feed remains the product stance for v1.
- FR-004: The system persists each collector's likes so preferences accumulate across sessions. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "passes carry little signal for the cost of storing them — a pass can mean 'not now', 'wrong mood', or a mis-swipe." Resolution: revised. v1 persists likes only; passes are not stored as preference signal.
- FR-005: A collector who has not liked enough artworks yet is served the existing unranked ordering until ranking has something to work with. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "'enough likes' is undefined, so the fallback never clearly ends and the behavior is untestable." Resolution: kept as a rule; the like-count threshold that switches ranking on is routed to Open Questions.
- FR-006: Artworks the collector has already liked are not served again. Whether artworks they passed on reappear is unresolved. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "re-showing a passed artwork reads as the app ignoring you, not as a deliberate second chance." Resolution: unresolved. Both positions recorded — permanent exclusion risks a small catalogue running dry; reappearance risks reading as a bug. Routed to Open Questions.

### Preserved

- FR-007: Liking, the liked-artworks view, and the swipe interaction itself continue to work unchanged. The composition and ordering of what a collector is served is explicitly in scope to change. Priority: must-have. Change: preserved
  > Socrates: Counter-argument considered: "the swipe flow must change — changing what a collector is served is the whole feature, so claiming no behavioral change is a contradiction." Resolution: narrowed. Preservation now covers liking, liked-artworks history, and the swipe interaction; ordering and composition are named as in-scope changes.

## User Stories

### US-01: Collector is served artworks matching their taste

- **Given** an authenticated collector who has swiped through artworks and liked several of them
- **When** they keep swiping
- **Then** the artworks they are served are ordered by how well each piece's tags match the tags on the pieces they have liked, and pieces they have already liked are not served again

_Before this change: every collector was served artworks in the same order, with no relationship to what that collector had liked._

## Business Logic

ArtSwipe orders what a collector is served based on previous likes and the metadata associated to those previous likes.

This **adds a new domain rule** alongside the existing one. ArtSwipe already derives a normalized set of descriptive tags for every artwork from its image; that rule is unchanged. The new rule consumes the output of the old one.

The rule consumes the artworks a collector has liked, together with the tags carried by those artworks. Its output is an ordering over the artworks that collector has not yet liked. The collector encounters it as the sequence in which pieces arrive while they swipe — there is no control to operate and nothing to configure. A collector who has not liked enough yet falls back to the existing ordering until the rule has something to work with.

## Constraints & Preserved Behavior

- **Preference collection starts fresh:** likes recorded before this change are not treated as preference signal. Every collector begins with no learned taste and reaches ranking through new likes only. No migration or backfill of historical likes.
- **Depends on the enrichment work being live:** ranking is only meaningful for artworks that carry tags. Pieces without tags need a defined position in the ordering (see Open Questions).
- **Liking and liked-artworks preserved:** the like action and the liked-artworks view continue to work exactly as they do today. Ordering and composition of what a collector is served are explicitly in scope to change.
- **Dev-stage tolerance:** the project has no real user base, so refactors and behavior changes are acceptable where they are justified. This is not a production system with users to protect.

## Non-Functional Requirements

- A collector's likes, and any taste derived from them, are visible only to that collector — no other user, artist included, can see them.
- Swiping is never blocked waiting for ordering work; where the collector must wait between batches, the wait is brief and visibly signposted rather than silent.

## Non-Goals

- **No collector-facing controls over ranking.** No filters, no "show me more like this", no tuning, no way to reset learned taste. Rationale: ranking is invisible and automatic in v1; controls are a whole product surface of their own.
- **No explanation of why a piece was served.** No match score, no "because you liked X". Rationale: v1 is deliberately simple; explanation implies a defensible scoring model that does not exist yet.
- **No changes to the artist side.** Artists get no visibility into how ranking treats their work, no analytics, and no way to influence placement. Rationale: the artist is a secondary beneficiary of this change, not a participant in it.
- **No cross-collector or popularity signal.** Ranking never blends in what other collectors liked. Rationale: everyone's feed looking the same is the outcome this change exists to avoid.
- **No migration of historical likes.** Likes recorded before this change do not seed preferences. Rationale: preference collection starts fresh; backfill is separable work.

## Open Questions

1. **How are tags weighted when matching?** Raw overlap treats every tag as equally important, which the Socrates round flagged as producing arbitrary rankings. Whether weighting is needed for v1, and what form it takes, is unresolved. — Owner: user.
2. **How many likes switch ranking on?** FR-005 falls back to the existing ordering until a collector has liked "enough"; the threshold is undefined, which makes the behavior untestable as written. — Owner: user.
3. **Do artworks a collector passed on reappear, and after how long?** Permanent exclusion risks a small catalogue running dry; immediate reappearance reads as the app ignoring the collector. Both positions recorded, neither chosen. — Owner: user.
4. **Where do untagged artworks sit in the ordering?** Ranking is only meaningful for pieces carrying tags. Artworks predating the enrichment work, or otherwise untagged, need a defined position. — Owner: user.

## Quality cross-check

All six brownfield elements present at finalize — no gaps. `quality_check_status: accepted`.

- Access Control — present
- Business Logic (one-sentence rule) — present
- Project artifacts — present
- Timeline-cost acknowledged — present (delivery_weeks: 3)
- Non-Goals — present
- Preserved behavior — present

Noted at finalize, not a cross-check failure: FR-006 states its own decision as unresolved, and Open Questions 2 and 3 (like threshold, passes reappearing) leave FR-005 and FR-006 untestable as written. The user chose to carry both into the PRD rather than settle them during shaping.
