---
project: ArtSwipe
context_type: brownfield
created: 2026-09-11
updated: 2026-09-11
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "auction unit"
      decision: "SUPERSEDED in Phase 3 — was 'artist's choice, single artwork or bundle'; bundles cut for v1, one auction covers exactly one artwork"
    - topic: "must preserve"
      decision: "swipe / like / recommendation ordering stays exactly as-is; auctions are additive"
    - topic: "change category"
      decision: "new module — self-contained auction area alongside existing flows"
    - topic: "insight"
      decision: "the recommendation engine is what unlocks taste-based auction targeting now"
    - topic: "who can list"
      decision: "artists only, own artwork only — reuses the existing artist boundary, no new role"
    - topic: "who can bid"
      decision: "any authenticated user except the auction's own seller — blocks shill bidding"
    - topic: "auction visibility"
      decision: "authenticated only — no public/signed-out auction surface in v1"
    - topic: "auction close"
      decision: "fixed end time, closed by a scheduled job — new scheduler pattern accepted as cost"
    - topic: "blast radius"
      decision: "additive — swipe/like/recommendation and upload untouched"
    - topic: "v1 scope"
      decision: "scoped down to ~3 weeks; bundles cut (revises the Phase 1 'artist's choice' decision), no edit/cancel of a live auction, email-only notifications"
    - topic: "bid rules"
      decision: "revised in Socrates round — sealed bids, starting price is the only floor; minimum increment dropped as incoherent, no reserve price, no buy-it-now"
    - topic: "auction mechanism"
      decision: "sealed-bid, not open ascending — nobody sees the standing high before close; defeats sniping and shill-driving structurally"
    - topic: "re-bidding"
      decision: "a bidder may raise their own bid; their highest counts"
    - topic: "secondary outcome"
      decision: "none — keep v1 to the core loop"
    - topic: "contact exchange"
      decision: "winner and seller only; losing bidders get a no-win email with no contact details"
    - topic: "zero-bid close"
      decision: "auction closes with no winner; seller is emailed"
    - topic: "deck overlap"
      decision: "auctioned artwork stays in the swipe deck at its usual rank, visibly flagged as on auction"
    - topic: "email consent"
      decision: "auction-notification preference on by default, plus one-click unsubscribe in every auction email"
    - topic: "tie-breaking"
      decision: "earliest of the tied highest bids wins — a gap sealed bidding introduced"
    - topic: "match threshold"
      decision: "settled at cross-check — rank collectors by tag overlap, notify top N, exclude below a minimum overlap"
    - topic: "non-goals"
      decision: "no payments, no in-app messaging, no bundles, no shipping/tax/fees"
  frs_drafted: 14
  quality_check_status: accepted
---

# Shape Notes — ArtSwipe Collection Auction Mechanism (brownfield)

Shaping an on-platform auction mechanism: an artist lists one artwork for auction, the collectors most likely to want it are emailed, collectors place sealed bids in a new auction section, and at close the winning bidder and seller are given each other's contact details. Body sections below are ordered to match the 11-section brownfield PRD template.

## PRD frontmatter scaffold (product-level priors)

- `project`: ArtSwipe
- `context_type`: brownfield
- `product_type`: web-app _(existing; unchanged by this work)_
- `target_scale`: `{ users: small, qps: low, data_volume: small }` _(no real user base yet; unchanged by this work)_
- `timeline_budget`: `{ delivery_weeks: 3, hard_deadline: null, after_hours_only: false }`

## Current System

- **Purpose:** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.
- **Architecture:** Next.js 16 (App Router) web app deployed on Vercel; Supabase as the backend (Postgres, Auth, Storage). All mutations go through Server Actions.
- **Tech stack:** Next.js 16, React 19, TypeScript (strict), Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod. Artwork images live in a Supabase Storage bucket, served via public object URLs.
- **Current user base:** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.
- **Core functionality today:**
  - **Artist mode:** upload artwork with AI-assisted tagging; manage own pieces.
  - **Collector mode:** swipe through artworks, express interest (like), view liked artworks.
  - **AI enrichment:** artworks carry persisted AI-derived tags from image analysis; baseline tags auto-applied at publish when the artist's own tags are sparse.
  - **Recommendation engine (live):** the swipe deck is ordered per-collector by how well each piece's tags match the tags on the pieces that collector has liked (`20260910180000_rank_swipe_deck.sql`).
  - **Auth:** Supabase email/password; every authenticated user is a collector by default and can become an artist via one-step onboarding.
  - **Transactions:** none in-app. Collectors reach out to buy or bid entirely off-platform.
- **Notably absent today:** there is no email-sending or notification infrastructure of any kind in the project. Outbound email is net-new ground for this change.

## Vision & Problem Statement

ArtSwipe is good at getting the right artwork in front of the right collector and terrible at what happens next. A collector who likes a piece has no way to act on that interest inside the product — the trail ends at a like, and any actual transaction happens off-platform through channels ArtSwipe neither provides nor sees. Artists, correspondingly, have no way to convert accumulated interest into a sale.

This change adds an auction mechanism. An artist lists one of their artworks for auction. ArtSwipe then does the thing only ArtSwipe can do: it tells the collectors most likely to care. Collectors who already liked the piece are emailed, and so are collectors whose demonstrated taste matches it, using the same tag-match signal the recommendation engine already computes. Collectors place sealed bids in a new auction section — nobody sees what anyone else has bid — and when the auction closes the winning bidder and the seller are each given the other's contact details so the sale can be completed.

The insight that makes this tractable now is that the recommender shipped. Taste-based auction targeting — "notify collectors who would want this, not everyone" — was not possible before the tag-match signal existed. Off-platform deals were tolerable at a one-user scale; a notification mechanism that reaches the right handful of collectors is what turns a listing into a sale.

## User & Persona

**Primary persona — the collector.** Someone who has been swiping and liking, building an implicit taste profile. Today that interest dead-ends. With auctions, they get an email when something matching their demonstrated taste goes up for sale, bid in-app, and — if they win — are handed the artist's contact details to close the deal.

**Secondary persona — the artist.** An independent visual artist who can now convert interest into a sale without leaving the platform. They choose which piece to list, and ArtSwipe routes the listing to the collectors most likely to bid rather than making them find an audience themselves.

## Access Control

**No new roles and no new auth mechanism.** Authentication remains Supabase email/password. Every authenticated user is a collector by default and can become an artist through the existing one-step onboarding. The auction module reuses that boundary rather than extending it.

Three access rules are added, all expressible within the existing model:

- **Listing:** only a user who has completed artist onboarding may create an auction, and only for artwork they uploaded. This is the existing artist-owns-their-artwork boundary applied to a new object.
- **Bidding:** any authenticated user may bid, _except_ on an auction they are the seller of. Artists are collectors too and may legitimately want each other's work; the self-bid exclusion exists to rule out shill bidding — an artist inflating their own auction.
- **Visibility:** the auction section lives inside the existing authenticated area. Signed-out visitors cannot browse auctions. No public auction surface is built in v1, so there is no new unauthenticated route or anonymous-read policy to secure.

Contact details are the one genuinely new disclosure this change makes: at auction close, the winning bidder and the seller are shown each other's contact information. That disclosure is scoped to those two parties and to that auction — it is not a general directory, and losing bidders receive nothing about the seller or the winner.

## Success Criteria

### Primary

The auction loop completes end to end, for a single artwork:

1. An artist lists one of their own artworks for auction with a starting price and a preset duration.
2. Collectors who liked that artwork are emailed, and so are collectors whose demonstrated taste matches its tags.
3. A notified collector opens the auction section and places a sealed bid at or above the starting price, without seeing what anyone else has bid.
4. The auction closes automatically at its end time and the highest sealed bid wins.
5. The winning bidder and the seller each receive the other's contact details, so the sale can be completed off-platform.

The loop working is the whole proof. Targeting is part of it, not a nice-to-have: an auction that emails everybody, or nobody, has not demonstrated this feature.

### Secondary

None. v1 is deliberately the core loop and nothing else — no watch/follow, no artist-facing reach stats, no second notification surface.

### Guardrails

- **Discovery is untouched.** Swiping, liking, the liked-artworks view, and the per-collector tag-match ordering continue to behave exactly as they do today. Auctions are strictly additive.
- **Artwork upload and enrichment are untouched.** Listing an artwork for auction does not change how artworks are uploaded, tagged, or published.
- **No auction email reaches a collector it was not targeted at.** Untargeted blasting is both the product failure (the differentiator is precision) and the operational risk (mail from the app getting filtered).
- **Bidding is correct under concurrency.** Two collectors bidding at the same instant must not both win, and no bid below the starting price may be accepted.
- **Sealed means sealed.** No standing bid, bid count, or bidder identity is exposed to anyone — through the interface, an email, or any other surface — before the auction closes. This is the property the whole mechanism rests on; leaking it reintroduces both sniping and shill-driving.
- **Dev-stage tolerance.** The project has no real user base, so refactors and behavior changes are acceptable where justified. This is not a production system with users to protect.

## Functional Requirements

### Auction creation (new)

- FR-001: An artist can list one of their own artworks for auction. They set a starting price and choose the auction length from preset durations. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "three free parameters is a form artists will get wrong — a bad increment or a three-month end time produces a dead auction." Resolution: revised twice. Duration became a preset rather than a free input; the minimum bid increment was then removed entirely when the mechanism changed to sealed bids (see FR-007). Only the starting price remains a free input.
- FR-002: An artist can cancel their own auction while it has no bids. Once a bid has been placed, the auction is locked and runs to its end time — no edits, no cancellation. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "full immutability makes a typo in the starting price unfixable — the artist must wait out a dead auction." Resolution: revised. Cancellation is allowed up until the first bid, which fixes the typo problem without creating a fairness hole for anyone who has already committed money.

### Notification (new)

- FR-003: When an auction opens, every collector who liked that artwork and has auction notifications enabled receives an email about it. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "a like was never consent to be emailed — liking is a low-commitment swipe gesture, not a subscription." Resolution: revised. The FR is now conditioned on the notification preference introduced in FR-005, so a like alone no longer implies mail.
- FR-004: When an auction opens, collectors whose demonstrated taste matches the artwork's tags and who have auction notifications enabled receive an email about it, whether or not they liked that specific piece. "Matched" means: collectors are ranked by how many of the artwork's tags their taste already contains, the top N are notified, and anyone below a minimum overlap is excluded no matter how few collectors that leaves. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "emailing people about a piece they never engaged with is marketing, not notification — and it is the FR most likely to get the app's mail marked as spam, which would poison auth email too." Resolution: revised. Conditioned on the FR-005 preference and unsubscribe path. The per-collector volume cap raised as an alternative counter-argument was not adopted and is routed to Open Questions.
- FR-005: A collector has an auction-notification preference, enabled by default, which they can turn off; every auction email also carries a one-click unsubscribe that turns it off. Priority: must-have. Change: new
  > Socrates: Added during the Socrates round as the resolution to the FR-003 and FR-004 consent challenges. Opt-in-by-default was chosen over opt-in-off-by-default deliberately: a v1 where nobody has opted in would never exercise the targeting, hollowing out the primary success criterion.

### Bidding (new) — sealed bids

- FR-006: An authenticated user can browse open auctions in a dedicated auction section, seeing each auction's artwork, starting price, and time remaining. The standing high bid is never shown. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "a separate section splits attention from the swipe deck, which is the app's whole interaction model — the auction area may simply go unvisited." Resolution: kept. The section is not the only entry point: the auction email is one, and the on-auction flag in the swipe deck (FR-012) is another. Three routes in is judged enough for v1.
- FR-007: An authenticated user can place a sealed bid on any auction except one they are the seller of. A bid is accepted if it meets the starting price. No one — bidder, seller, or onlooker — sees the standing high bid or the bid count before close. A bidder may raise their own bid; their highest bid is the one that counts. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "blocking self-bidding only stops the lazy shill — an artist with a second account walks straight around it." Resolution: revised, and the revision is the significant one in this document. The mechanism changed from open ascending bids to **sealed bids**: with no visible standing price, shilling has nothing to drive. A second-account shill bid cannot influence other bidders who cannot see it. The self-bid exclusion is retained as a cheap guard, but it is no longer load-bearing. The minimum bid increment, kept during Phase 3, was dropped here — an increment requires bidders to beat a number they can see, so it is incoherent under sealed bidding. The starting price is now the only floor.

### Close and contact exchange (new)

- FR-008: An auction closes automatically at its end time, and the highest sealed bid standing at that moment wins. Where two bids tie at the highest amount, the one placed earliest wins. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "a hard end time invites sniping — a bid in the final seconds wins and everyone else feels cheated." Resolution: revised via the same mechanism change as FR-007. Sealed bidding removes sniping structurally rather than procedurally: a late bidder has no visible number to undercut, so bidding at the last second confers no advantage. Anti-snipe auto-extension was therefore not needed, and the hard close — much simpler for the scheduled job — is retained.
- FR-009: At close with at least one bid, the winning bidder and the seller each receive the other's contact details by email. Losing bidders receive an email telling them they did not win, containing no contact details. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "handing over emails with no in-app messaging means ArtSwipe never learns whether the sale happened — no feedback loop, no proof the feature works." Resolution: partially addressed. FR-011 adds a follow-up asking both parties whether the sale completed, as a nice-to-have. Full loop closure needs payments or in-app messaging, both explicit non-goals.
- FR-010: At close with no bids, the seller receives an email telling them the auction has ended and the artwork is free to relist. Priority: must-have. Change: new
  > Socrates: Counter-argument considered: "'nobody bid on your work' is a discouraging message that may do more harm to an artist's willingness to keep listing than silence would." Resolution: revised. The email stays — the artist needs to know the auction ended — but it is framed as a closing notice with the artwork free to relist, not as a failure report.
- FR-011: Some time after a completed auction, both parties are asked whether the sale actually happened. Priority: nice-to-have. Change: new
  > Socrates: Added during the Socrates round as the partial resolution to FR-009. Marked nice-to-have deliberately: it is the only part of the flow not required to prove the mechanism works, so it is the first thing to drop if the three-week budget tightens.

### Discovery (modified)

- FR-012: An artwork with a live auction still appears in the swipe deck, in the same order it would have anyway, but is visibly marked as being on auction. Priority: must-have. Change: modified
  > Socrates: Counter-argument considered: "this modifies the app's most-used surface — changing the swipe card is the one place the new module reaches into existing UI, which cuts against the 'auctions are additive' guardrail." Resolution: kept, with the contradiction acknowledged and pushed into FR-013. The flag is accepted as the single deliberate exception to additivity, because without it the auction section has only one entry point. What the deck must not change is its _ordering_ — the flag is presentation only, and the ranking query is untouched. The alternative counter-argument — that liking a flagged card is ambiguous, and a collector might believe a like entered them into the auction — was not resolved and is routed to Open Questions.

### Preserved

- FR-013: Liking, the liked-artworks view, and the per-collector tag-match ordering of the swipe deck continue to work unchanged. The presentation of a swipe card changes only to carry the on-auction flag in FR-012; what a collector is served, and in what order, does not change at all. Priority: must-have. Change: preserved
  > Socrates: Counter-argument considered: "FR-012 changes the swipe card, so claiming discovery is 'unchanged' is not strictly true — the preservation FR needs to name what it actually covers." Resolution: revised. The FR now names its scope precisely: the like action, the liked-artworks view, and the ranking/ordering are preserved; swipe-card presentation is explicitly excluded from that claim. The alternative counter-argument — that "works unchanged" is untestable as written — is answered by this narrowing, since ordering and the like action are both testable.
- FR-014: Artwork upload, AI tagging, and publishing continue to work unchanged. Priority: must-have. Change: preserved
  > Socrates: Challenged together with FR-013 under the same question. Resolution: kept as written. Unlike FR-013 this one has no contradicting FR — nothing in this change touches the upload, enrichment, or publish path, so the preservation claim is unqualified.

## User Stories

### US-01: Collector is notified about an auction matching their taste and wins it

- **Given** an authenticated collector who has liked several artworks and has auction notifications enabled, and an artist who lists one of their own artworks for auction with a starting price and a preset duration
- **When** the auction opens and the collector's demonstrated taste matches the artwork's tags — or they had liked that artwork directly
- **Then** they receive an email about the auction, can open the auction section, see the artwork, the starting price and the time remaining — but not what anyone has bid — and place a sealed bid at or above the starting price
- **And when** the end time passes and their sealed bid is the highest
- **Then** the auction closes automatically, and both they and the seller receive an email containing the other's contact details, while losing bidders receive a no-win email with no contact details

_Before this change: a collector's interest ended at a like, and any transaction happened off-platform through channels ArtSwipe neither provided nor saw._

## Business Logic

When an artwork goes up for auction, ArtSwipe decides which collectors hear about it, by matching the artwork's tags against each collector's demonstrated taste.

This **adds a new domain rule** and leaves the existing ones intact. ArtSwipe already derives normalized tags from an artwork's image, and already orders each collector's swipe deck by matching those tags against the pieces that collector has liked. Both rules are unchanged. The new rule runs the existing match in the opposite direction: instead of asking "given this collector, which artworks?", it asks "given this artwork, which collectors?" — and uses the answer to decide who gets an email.

The rule consumes one artwork's tags plus the accumulated likes of every collector who has auction notifications enabled. Its output is the set of collectors who are told the auction exists. The collector encounters it as an email about a piece they would plausibly want; there is no control to operate and nothing to configure beyond turning the notifications off. Collectors who liked the artwork itself are included regardless of how their broader taste scores.

A supporting rule governs how an auction resolves: bids are sealed, so the highest bid standing when the end time passes wins, with the earliest bid taking a tie. This is the mechanical half of the change — it is what any auction must do — while the routing rule above is the half only ArtSwipe can do.

## Constraints & Preserved Behavior

- **Nothing exists to build on for email.** The project has no notification infrastructure of any kind today. Outbound email is net-new: a provider, templates, an unsubscribe path, and whatever the provider needs to be trusted as a sender.
- **No scheduled-job pattern exists either.** Nothing in the project runs on a timer today. Closing auctions at their end time introduces that pattern, and every timing property in the NFRs below depends on it.
- **Contact details are just the account email.** A profile carries `email` and `display_name` and nothing else, and row-level security restricts every user to reading their own profile row. The contact exchange at close therefore travels in the notification itself rather than through a relaxed profile-read policy — no existing access rule needs loosening to make it work.
- **Ranking is reused, not rebuilt.** Taste-based targeting depends on the tag-match signal the recommendation engine already computes. It must reuse that signal rather than introduce a second, separately-drifting notion of what a collector's taste is.
- **The swipe deck's ordering is untouchable.** FR-012 adds a flag to the swipe card; it must not change which artworks are served or in what order. Presentation is in scope, ranking is not.
- **Likes predating this change count normally.** Unlike the recommender's fresh start, taste-based targeting reads whatever likes exist. No migration or backfill is involved.
- **Dev-stage tolerance.** The project has no real user base, so refactors and behavior changes are acceptable where justified. This is not a production system with users to protect.

## Non-Functional Requirements

- **No bid information is observable before an auction closes** — not the standing high, not the bid count, not who has bid. This holds across every surface the app exposes, not only the ones that obviously display bids; the mechanism's defence against both sniping and shill-driving rests entirely on it.
- **An auction email reaches its recipients promptly after the auction opens** — late notification silently consumes auction time the collector could have bid in, and unlike a visible error it leaves no trace.
- **An auction closes close enough to its stated end time that a collector watching the clock is not misled.** A piece still open well past its advertised close, or a countdown that hits zero with nothing happening, reads as broken.
- **A collector's likes, and any taste derived from them, remain visible only to that collector** — no other user, artist included, can see what they liked or what taste was inferred. Carried over unchanged from the recommendation engine.
- **A collector who has turned auction notifications off receives none** — no auction email, from any path, including the taste-match path that never required their engagement in the first place.

## Non-Goals

- **No payment handling.** No checkout, no escrow, no deposits, no card details, no payout. Rationale: the sale completes off-platform between two people who now have each other's email. Payments would dominate a three-week budget on their own, and bring compliance obligations the project is not equipped for.
- **No in-app messaging.** Contact exchange hands over email addresses and stops there. Rationale: an inbox means threads, notifications, abuse reporting, and moderation — a product surface of its own, not a supporting detail of auctions.
- **No bundled or multi-artwork auctions.** One auction covers exactly one artwork. Rationale: cut during Phase 3 scope-down; bundles need a join table, multi-image listing UI, and answers about partial sales. Named here so it does not drift back in.
- **No shipping, tax, or fee handling.** ArtSwipe takes no commission and models no logistics. Rationale: whatever the two parties arrange is theirs; modelling it implies ArtSwipe is a party to the transaction, which it deliberately is not.
- **No collector-facing controls over auction targeting.** Beyond the on/off notification preference, there is no filtering by price, medium, or tag, and no way to tune what counts as a match. Rationale: consistent with how the recommender was scoped — the matching is invisible and automatic in v1.
- **No artist-facing analytics.** Artists get no view of how many collectors were notified, how targeting treated their work, or how many people viewed the auction. Rationale: the secondary outcome was explicitly declined in Phase 3.

## Timeline acknowledgment

Scoped down on 2026-09-11 to fit `delivery_weeks: 3`. The scope-cost of four net-new areas (email delivery, taste-based targeting, scheduled auction close, bidding integrity) was surfaced and the user chose to cut rather than extend. Cuts accepted: bundled auctions dropped in favour of single-artwork auctions; email only, with no in-app notification centre.

Two Phase 3 decisions were superseded later in shaping and are recorded here for traceability:

- **Minimum bid increment** was kept in Phase 3 and then dropped in the Socrates round, when the move to sealed bidding made it incoherent (see FR-007). Reserve price and buy-it-now were never in scope.
- **Full immutability** ("no editing or cancelling a live auction") was softened in the Socrates round: an auction can be cancelled while it has no bids (see FR-002).

FR-011 (the "did this sell?" follow-up) was added after the scope-down, as a nice-to-have. It is the designated drop candidate if the budget tightens.

## Open Questions

1. **Does a collector need a cap on how many auction emails they receive?** The top-N rule settled in Question 3 bounds how many collectors _one auction_ emails, but not how many auctions email _one collector_. A prolific artist listing several pieces could still reach the same collector repeatedly in a day, and the notification preference (FR-005) is all-or-nothing — so the only remedy available to an annoyed collector is turning auction mail off entirely. — Owner: user.
2. **What does liking an on-auction card in the swipe deck mean?** FR-012 marks auctioned artwork in the deck, but a like on that card is ambiguous — the collector may believe it entered them into the auction, or may just be liking the piece. The deck has no answer for this today. — Owner: user.
3. ~~**How is "taste matches this artwork" turned into a yes/no decision?**~~ **Settled during the closing cross-check.** The recommender scores a match as a raw overlap count — how many of the artwork's tags appear in the collector's taste set, the distinct union of tags across everything they have liked, unweighted. Targeting reuses that count directly: rank collectors by overlap, notify the top N, and exclude anyone below a minimum overlap regardless of how few that leaves. Top-N was chosen over an absolute or proportional threshold because raw overlap has a broad-taste flaw — a collector who has liked a lot matches nearly everything, so any absolute cutoff would notify the most active collectors about every auction, which is the opposite of targeting. What N and the minimum overlap actually are is a tuning decision for implementation, not a shaping one. — Resolved.
4. **What happens to a collector who has liked nothing?** The recommender falls back to unranked ordering for cold-start collectors. Taste-based targeting has no equivalent fallback defined — such a collector matches nothing, so they would be notified only about auctions on pieces they liked, which by definition is none. — Owner: user.
5. **Can an artist relist an artwork that failed to sell, and is there any limit?** FR-010 tells the artist the piece is free to relist, but nothing defines whether repeated relisting is bounded — which interacts directly with the email-volume question above. — Owner: user.

## Quality cross-check

All six brownfield elements present at finalize — no gaps. `quality_check_status: accepted`.

- Access Control — present
- Business Logic (one-sentence rule) — present
- Project artifacts — present
- Timeline-cost acknowledged — present (`delivery_weeks: 3`, reached by scoping down rather than extending)
- Non-Goals — present
- Preserved behavior — present

Noted at finalize, not a cross-check failure:

- **The mechanism changed during shaping.** Phase 3 locked open ascending bids with a minimum increment; the Socrates round replaced that with sealed bids, which defeats sniping and shill-driving structurally and made the increment incoherent. Success Criteria, US-01, and the Phase 3 record were reconciled to match. Anything downstream that reads this document gets the sealed-bid version.
- **Four open questions carry into the PRD.** The heaviest one — how a tag match becomes a yes/no notify decision — was settled during the cross-check rather than deferred, because the primary success criterion was untestable without it. The remainder (email volume per collector, the meaning of liking an on-auction card, cold-start collectors, relisting limits) are genuinely open.
- **Two FRs depend on infrastructure that does not exist.** Email delivery (FR-003, FR-004, FR-009, FR-010) and scheduled closing (FR-008) both introduce patterns the project has never had. They are the largest sources of estimate risk in a three-week budget.
