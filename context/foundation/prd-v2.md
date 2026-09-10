---
project: ArtSwipe
version: 2
status: draft
created: 2026-09-10
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

# ArtSwipe — Recommendation Engine

## Current System Overview

**Purpose.** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.

**Key architecture.** Next.js 16 (App Router) web app deployed on Vercel, with Supabase as the backend (Postgres, Auth, Storage). Server Actions are used for mutations.

**Tech stack.** Next.js 16, React 19, TypeScript, Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod, Vercel Analytics. Artwork images are stored in a Supabase Storage bucket and served via public object URLs.

**Current user base.** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.

**Core functionality today.**

- **Artist mode:** upload artwork with AI-assisted tagging; manage own pieces.
- **Collector mode:** swipe through artworks (unranked), express interest (like), view liked artworks.
- **AI enrichment:** (recently added) artworks have persisted AI-derived tags from image analysis; baseline tags are auto-applied at publish if the artist's tags are sparse.
- **Auth:** Supabase email/password, split into collector and artist flows.
- **Transactions:** collectors reach out to buy/auction off-platform.

## Problem Statement & Motivation

Every collector is served artworks in the same order today, with no relationship to what that collector has liked. With the enrichment work now live, every artwork carries normalized, machine-readable tags — so the signal needed to order pieces per collector exists, and nothing consumes it. The missing piece is a recommendation service that learns from a collector's own likes and orders what they are served by how well each piece's tags match the tags on the pieces they liked.

Without personalization, collectors face discovery friction: the current workaround is simply to keep swiping past many unrelated pieces to reach art they would actually like, at the cost of attention and patience. With tag-based ordering, collectors reach matching work sooner, and artists whose work matches a collector's demonstrated taste get more visibility to that collector.

## User & Persona

**Primary persona — the collector.** Someone swiping to discover art to buy or bid on. They've been liking pieces over time; the recommender learns from those likes and surfaces new pieces tagged similarly, cutting discovery friction. This is the existing user whose experience changes: what they are served, and in what order.

**Secondary persona — the artist.** An independent visual artist whose work now ranks higher when it matches collectors' demonstrated taste, gaining visibility to interested buyers. The artist's own experience of the product is unchanged by this work.

## Success Criteria

### Primary

A collector who keeps swiping is served artworks ordered by how well each piece's tags match the tags on the pieces they have liked, and that ordering sharpens as they like more. Personalization is per-collector, never a global popularity ranking. (Revised during the Socrates round: decks refill continuously as the collector swipes rather than on an explicit request — see Scope of Change.)

### Secondary

Keep v1 simple — no explanations, no recommendation scoring, no secondary outcomes.

### Guardrails

- Liking, the liked-artworks view, and the swipe interaction itself remain intact and functional. (Ordering and composition of what a collector is served are explicitly in scope to change.)
- A collector's likes, and any taste derived from them, are visible only to that collector — no other user, artist included, can see them.
- Swiping is never blocked waiting for ordering work; where the collector must wait between batches, the wait is brief and visibly signposted rather than silent.
- The project is in dev — acceptable to iterate and refactor for good reason; not production-critical.

## User Stories

### US-01: Collector is served artworks matching their taste

- **Given** an authenticated collector who has swiped through artworks and liked several of them
- **When** they keep swiping
- **Then** the artworks they are served are ordered by how well each piece's tags match the tags on the pieces they have liked, and pieces they have already liked are not served again

_Before this change: every collector was served artworks in the same order, with no relationship to what that collector had liked._

## Scope of Change

- [new] A collector is served further artworks automatically as they swipe, without asking for a new deck. Priority: must-have

  > Socrates: Counter-argument considered: "an explicit deck request is friction — it adds a decision and a control the collector has to find." Resolution: revised. The original shape had the collector requesting a new deck every 10–20 cards; that request is dropped. Artworks refill continuously as they swipe, so ranking is felt rather than operated.

- [new] The system orders artworks by how closely each piece's tags match the tags on the artworks that collector has liked. Priority: must-have

  > Socrates: Counter-argument considered: "raw tag overlap ranks crudely — it treats every tag as equally important, so 'blue' weighs the same as 'oil-on-canvas'." Resolution: kept for v1; simple tag-match is what ships in three weeks. How tags are weighted is unresolved and routed to Open Questions.

- [new] For this change, a collector's preferences come only from their own likes — never from a global or cross-collector popularity signal. Priority: must-have

  > Socrates: Counter-argument considered: "ruling out global signal forever over-commits — a blend might be right once there are real users." Resolution: narrowed. The exclusion binds this change only; a future blend is left open rather than ruled out. Avoiding everyone-sees-the-same-feed remains the product stance for v1.

- [new] The system persists each collector's likes so preferences accumulate across sessions. Priority: must-have

  > Socrates: Counter-argument considered: "passes carry little signal for the cost of storing them — a pass can mean 'not now', 'wrong mood', or a mis-swipe." Resolution: revised. v1 persists likes only; passes are not stored as preference signal.

- [new] A collector who has not liked enough artworks yet is served the existing unranked ordering until ranking has something to work with. Priority: must-have

  > Socrates: Counter-argument considered: "'enough likes' is undefined, so the fallback never clearly ends and the behavior is untestable." Resolution: kept as a rule; the like-count threshold that switches ranking on is routed to Open Questions.

- [new] Artworks the collector has already liked are not served again. Whether artworks they passed on reappear is unresolved. Priority: must-have

  > Socrates: Counter-argument considered: "re-showing a passed artwork reads as the app ignoring you, not as a deliberate second chance." Resolution: unresolved. Both positions recorded — permanent exclusion risks a small catalogue running dry; reappearance risks reading as a bug. Routed to Open Questions.

- [modified] The composition and ordering of what a collector is served. Was: every collector served the same unranked ordering. Now: ordered per collector by tag-match against their own likes, with the unranked ordering retained as the cold-start fallback. Priority: must-have

- [preserved] Liking, the liked-artworks view, and the swipe interaction itself continue to work unchanged. Priority: must-have

  > Socrates: Counter-argument considered: "the swipe flow must change — changing what a collector is served is the whole feature, so claiming no behavioral change is a contradiction." Resolution: narrowed. Preservation now covers liking, liked-artworks history, and the swipe interaction; ordering and composition are named as in-scope changes.

## Constraints & Compatibility

- **Preference collection starts fresh:** likes recorded before this change are not treated as preference signal. Every collector begins with no learned taste and reaches ranking through new likes only. No migration or backfill of historical likes.
- **Depends on the enrichment work being live:** ranking is only meaningful for artworks that carry tags. Pieces without tags need a defined position in the ordering (see Open Questions).
- **Liking and liked-artworks preserved:** the like action and the liked-artworks view continue to work exactly as they do today. Ordering and composition of what a collector is served are explicitly in scope to change.
- **Existing unranked ordering must survive as a fallback:** it is not replaced, it becomes the cold-start path for collectors without enough likes.
- **Dev-stage tolerance:** the project has no real user base, so refactors and behavior changes are acceptable where they are justified. This is not a production system with users to protect.

## Business Logic Changes

ArtSwipe orders what a collector is served based on previous likes and the metadata associated to those previous likes.

This **adds a new domain rule** alongside the existing one. ArtSwipe already derives a normalized set of descriptive tags for every artwork from its image; that rule is unchanged. The new rule consumes the output of the old one.

The rule consumes the artworks a collector has liked, together with the tags carried by those artworks. Its output is an ordering over the artworks that collector has not yet liked. The collector encounters it as the sequence in which pieces arrive while they swipe — there is no control to operate and nothing to configure. A collector who has not liked enough yet falls back to the existing ordering until the rule has something to work with.

## Access Control Changes

No access control changes — current model preserved. Authentication remains email/password; all authenticated users are collectors by default and can become artists via one-step onboarding. No new roles and no shifted role boundaries. The recommender operates entirely within the existing "authenticated collector acting on their own history" boundary: a collector's preferences are derived from their own likes and applied only to what they are served.

## Non-Goals

- **No collector-facing controls over ranking.** No filters, no "show me more like this", no tuning, no way to reset learned taste. Rationale: ranking is invisible and automatic in v1; controls are a whole product surface of their own.
- **No explanation of why a piece was served.** No match score, no "because you liked X". Rationale: v1 is deliberately simple; explanation implies a defensible scoring model that does not exist yet.
- **No changes to the artist side.** Artists get no visibility into how ranking treats their work, no analytics, and no way to influence placement. Rationale: the artist is a secondary beneficiary of this change, not a participant in it.
- **No cross-collector or popularity signal.** Ranking never blends in what other collectors liked. Rationale: everyone's feed looking the same is the outcome this change exists to avoid.
- **No migration of historical likes.** Likes recorded before this change do not seed preferences. Rationale: preference collection starts fresh; backfill is separable work.
- **No storage of passes as preference signal.** Only likes are persisted as taste input. Rationale: a pass is ambiguous — "not now", "wrong mood", or a mis-swipe — and carries little signal for the cost.

## Open Questions

1. **How are tags weighted when matching?** Raw overlap treats every tag as equally important, which the Socrates round flagged as producing arbitrary rankings. Whether weighting is needed for v1, and what form it takes, is unresolved. — Owner: user.
2. **How many likes switch ranking on?** The cold-start rule falls back to the existing ordering until a collector has liked "enough"; the threshold is undefined, which makes the behavior untestable as written. — Owner: user.
3. **Do artworks a collector passed on reappear, and after how long?** Permanent exclusion risks a small catalogue running dry; immediate reappearance reads as the app ignoring the collector. Both positions recorded, neither chosen. — Owner: user.
4. **Where do untagged artworks sit in the ordering?** Ranking is only meaningful for pieces carrying tags. Artworks predating the enrichment work, or otherwise untagged, need a defined position. — Owner: user.
5. **Two Scope-of-Change items are untestable as written.** Carried forward from the shaping cross-check: the cold-start item depends on Open Question 2, and the already-liked/passed item depends on Open Question 3. Until both resolve, neither item has acceptance criteria a test can assert. — Owner: user. Block: partial (planning can start; these two items cannot be verified).
