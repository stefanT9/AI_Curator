---
project: ArtSwipe
version: 3
status: draft
created: 2026-09-11
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

# ArtSwipe — Auction Mechanism

## Current System Overview

**Purpose.** ArtSwipe connects independent artists showing work with collectors discovering art to buy or bid on.

**Architecture.** Next.js 16 (App Router) web app deployed on Vercel, with Supabase as the backend (Postgres, Auth, Storage). All mutations go through Server Actions.

**Tech stack.** Next.js 16, React 19, TypeScript (strict), Tailwind CSS v4, Supabase (`@supabase/ssr`, `@supabase/supabase-js`), Zod. Artwork images live in a Supabase Storage bucket, served via public object URLs.

**Current user base.** One user today — the owner/developer. Built as coursework; a public launch is possible later. No real collector or artist base yet.

**Core functionality today.**

- **Artist mode:** upload artwork with AI-assisted tagging; manage own pieces.
- **Collector mode:** swipe through artworks, express interest (like), view liked artworks.
- **AI enrichment:** artworks carry persisted AI-derived tags from image analysis; baseline tags are auto-applied at publish when the artist's own tags are sparse.
- **Recommendation engine (live):** the swipe deck is ordered per-collector by how well each piece's tags match the tags on the pieces that collector has liked (`20260910180000_rank_swipe_deck.sql`).
- **Auth:** Supabase email/password. Every authenticated user is a collector by default and can become an artist via one-step onboarding.
- **Transactions:** none in-app. Collectors reach out to buy or bid entirely off-platform.

**Notably absent.** There is no email-sending or notification infrastructure of any kind in the project, and nothing runs on a schedule. Both are net-new ground for this change.

## Problem Statement & Motivation

ArtSwipe is good at getting the right artwork in front of the right collector and does nothing about what happens next. A collector who likes a piece has no way to act on that interest inside the product — the trail ends at a like. Artists, correspondingly, have no way to convert accumulated interest into a sale.

The current workaround is that collectors contact artists off-platform and arrange everything themselves. Its cost is borne on both sides: the artist has no idea which of the people who liked their work would actually pay for it, and the collector has to leave the product and improvise a conversation with a stranger. Neither party gets any help from the one thing the product actually knows — who likes what.

**Why now.** Taste-based targeting became possible only when the recommendation engine shipped. Telling the right handful of collectors that a specific piece is for sale — rather than telling everybody, or nobody — depends on the tag-match signal that now exists. Off-platform deals were tolerable at a one-user scale; the ability to route a listing to the people most likely to bid on it is what turns a listing into a sale.

## User & Persona

**Primary persona — the collector.** Someone who has been swiping and liking, building an implicit taste profile. Today that interest dead-ends. With auctions, they are told when something matching their demonstrated taste goes up for sale, bid in-app, and — if they win — are handed the artist's contact details to close the deal.

### Secondary persona — the artist

An independent visual artist who can now convert interest into a sale without leaving the platform. They choose which piece to list, and the product routes the listing to the collectors most likely to bid rather than making them find an audience themselves.

## Success Criteria

### Primary

The auction loop completes end to end, for a single artwork:

1. An artist lists one of their own artworks for auction with a starting price and a preset duration.
2. Collectors who liked that artwork are notified, and so are collectors whose demonstrated taste matches its tags.
3. A notified collector opens the auction section and places a sealed bid at or above the starting price, without seeing what anyone else has bid.
4. The auction closes automatically at its end time and the highest sealed bid wins.
5. The winning bidder and the seller each receive the other's contact details, so the sale can be completed off-platform.

The loop working is the whole proof. Targeting is part of it, not a nice-to-have: an auction that notifies everybody, or nobody, has not demonstrated this feature.

### Secondary

None. v1 is deliberately the core loop and nothing else — no watch/follow, no artist-facing reach statistics, no second notification surface.

### Guardrails

- **Discovery is untouched.** Swiping, liking, the liked-artworks view, and the per-collector tag-match ordering continue to behave exactly as they do today. Auctions are strictly additive.
- **Artwork upload and enrichment are untouched.** Listing an artwork for auction does not change how artworks are uploaded, tagged, or published.
- **No auction notification reaches a collector it was not targeted at.** Untargeted blasting is both the product failure (the differentiator is precision) and the operational risk (messages from the product being treated as junk).
- **Bidding is correct under concurrency.** Two collectors bidding at the same instant must not both win, and no bid below the starting price may be accepted.
- **Sealed means sealed.** No standing bid, bid count, or bidder identity is exposed to anyone before the auction closes. This holds across every surface the product exposes, not only the ones that obviously show bids. This is the property the whole mechanism rests on; leaking it reintroduces both sniping and shill-driving.
- **An auction notification reaches its recipients promptly after the auction opens.** Late notification silently consumes auction time the collector could have bid in, and unlike a visible error it leaves no trace.
- **An auction closes close enough to its stated end time that a collector watching the clock is not misled.** A piece still open well past its advertised close, or a countdown that reaches zero with nothing happening, reads as broken.
- **A collector who has turned auction notifications off receives none** — from any path, including the taste-match path that never required their engagement in the first place.
- **A collector's likes, and any taste derived from them, remain visible only to that collector.** No other user, artist included, can see what they liked or what taste was inferred. Carried over unchanged from the recommendation engine.
- **Dev-stage tolerance.** The project has no real user base, so refactors and behavior changes are acceptable where justified. This is not a production system with users to protect.

## User Stories

### US-01: Collector is notified about an auction matching their taste and wins it

- **Given** an authenticated collector who has liked several artworks and has auction notifications enabled, and an artist who lists one of their own artworks for auction with a starting price and a preset duration
- **When** the auction opens and the collector's demonstrated taste matches the artwork's tags — or they had liked that artwork directly
- **Then** they are notified about the auction, can open the auction section, see the artwork, the starting price and the time remaining — but not what anyone has bid — and place a sealed bid at or above the starting price
- **And when** the end time passes and their sealed bid is the highest
- **Then** the auction closes automatically, and both they and the seller receive the other's contact details, while losing bidders are told they did not win and receive no contact details

_Before this change: a collector's interest ended at a like, and any transaction happened off-platform through channels the product neither provided nor saw._

#### Acceptance Criteria

- A bid below the starting price is rejected; the starting price is the only floor.
- At no point before close does any surface reveal the standing high bid, the number of bids, or who has bid.
- A collector may raise their own bid; their highest bid is the one that counts.
- Where two bids tie at the highest amount, the one placed earliest wins.
- A collector who has turned auction notifications off is not notified, by any path.
- The seller cannot bid on their own auction.

## Scope of Change

### Auction creation

- [new] FR-001: An artist can list one of their own artworks for auction. They set a starting price and choose the auction length from preset durations. Priority: must-have
  > Socrates: Counter-argument considered: "three free parameters is a form artists will get wrong — a bad increment or a three-month end time produces a dead auction." Resolution: revised twice. Duration became a preset rather than a free input; the minimum bid increment was then removed entirely when the mechanism changed to sealed bids (see FR-007). Only the starting price remains a free input.
- [new] FR-002: An artist can cancel their own auction while it has no bids. Once a bid has been placed, the auction is locked and runs to its end time — no edits, no cancellation. Priority: must-have
  > Socrates: Counter-argument considered: "full immutability makes a typo in the starting price unfixable — the artist must wait out a dead auction." Resolution: revised. Cancellation is allowed up until the first bid, which fixes the typo problem without creating a fairness hole for anyone who has already committed money.

### Notification

- [new] FR-003: When an auction opens, every collector who liked that artwork and has auction notifications enabled is notified about it. Priority: must-have
  > Socrates: Counter-argument considered: "a like was never consent to be emailed — liking is a low-commitment swipe gesture, not a subscription." Resolution: revised. The FR is now conditioned on the notification preference introduced in FR-005, so a like alone no longer implies mail.
- [new] FR-004: When an auction opens, collectors whose demonstrated taste matches the artwork's tags and who have auction notifications enabled are notified about it, whether or not they liked that specific piece. "Matched" means: collectors are ranked by how many of the artwork's tags their taste already contains, the top N are notified, and anyone below a minimum overlap is excluded no matter how few collectors that leaves. Priority: must-have
  > Socrates: Counter-argument considered: "emailing people about a piece they never engaged with is marketing, not notification — and it is the FR most likely to get the app's mail marked as spam, which would poison auth email too." Resolution: revised. Conditioned on the FR-005 preference and unsubscribe path. The per-collector volume cap raised as an alternative counter-argument was not adopted and is routed to Open Questions.
- [new] FR-005: A collector has an auction-notification preference, enabled by default, which they can turn off; every auction notification also carries a one-click unsubscribe that turns it off. Priority: must-have
  > Socrates: Added during the Socrates round as the resolution to the FR-003 and FR-004 consent challenges. Opt-in-by-default was chosen over opt-in-off-by-default deliberately: a v1 where nobody has opted in would never exercise the targeting, hollowing out the primary success criterion.

### Bidding — sealed bids

- [new] FR-006: An authenticated user can browse open auctions in a dedicated auction section, seeing each auction's artwork, starting price, and time remaining. The standing high bid is never shown. Priority: must-have
  > Socrates: Counter-argument considered: "a separate section splits attention from the swipe deck, which is the app's whole interaction model — the auction area may simply go unvisited." Resolution: kept. The section is not the only entry point: the auction notification is one, and the on-auction flag in the swipe deck (FR-012) is another. Three routes in is judged enough for v1.
- [new] FR-007: An authenticated user can place a sealed bid on any auction except one they are the seller of. A bid is accepted if it meets the starting price. No one — bidder, seller, or onlooker — sees the standing high bid or the bid count before close. A bidder may raise their own bid; their highest bid is the one that counts. Priority: must-have
  > Socrates: Counter-argument considered: "blocking self-bidding only stops the lazy shill — an artist with a second account walks straight around it." Resolution: revised, and the revision is the significant one in this document. The mechanism changed from open ascending bids to **sealed bids**: with no visible standing price, shilling has nothing to drive. A second-account shill bid cannot influence other bidders who cannot see it. The self-bid exclusion is retained as a cheap guard, but it is no longer load-bearing. The minimum bid increment, kept during Phase 3, was dropped here — an increment requires bidders to beat a number they can see, so it is incoherent under sealed bidding. The starting price is now the only floor.

### Close and contact exchange

- [new] FR-008: An auction closes automatically at its end time, and the highest sealed bid standing at that moment wins. Where two bids tie at the highest amount, the one placed earliest wins. Priority: must-have
  > Socrates: Counter-argument considered: "a hard end time invites sniping — a bid in the final seconds wins and everyone else feels cheated." Resolution: revised via the same mechanism change as FR-007. Sealed bidding removes sniping structurally rather than procedurally: a late bidder has no visible number to undercut, so bidding at the last second confers no advantage. Anti-snipe auto-extension was therefore not needed, and the hard close is retained.
- [new] FR-009: At close with at least one bid, the winning bidder and the seller each receive the other's contact details. Losing bidders are told they did not win, and receive no contact details. Priority: must-have
  > Socrates: Counter-argument considered: "handing over emails with no in-app messaging means ArtSwipe never learns whether the sale happened — no feedback loop, no proof the feature works." Resolution: partially addressed. FR-011 adds a follow-up asking both parties whether the sale completed, as a nice-to-have. Full loop closure needs payments or in-app messaging, both explicit non-goals.
- [new] FR-010: At close with no bids, the seller is told the auction has ended and the artwork is free to relist. Priority: must-have
  > Socrates: Counter-argument considered: "'nobody bid on your work' is a discouraging message that may do more harm to an artist's willingness to keep listing than silence would." Resolution: revised. The message stays — the artist needs to know the auction ended — but it is framed as a closing notice with the artwork free to relist, not as a failure report.
- [new] FR-011: Some time after a completed auction, both parties are asked whether the sale actually happened. Priority: nice-to-have
  > Socrates: Added during the Socrates round as the partial resolution to FR-009. Marked nice-to-have deliberately: it is the only part of the flow not required to prove the mechanism works, so it is the first thing to drop if the three-week budget tightens.

### Discovery

- [modified] FR-012: An artwork with a live auction still appears in the swipe deck, in the same order it would have anyway, but is visibly marked as being on auction. Was: artworks carried no sale state and the swipe card showed none. Priority: must-have
  > Socrates: Counter-argument considered: "this modifies the app's most-used surface — changing the swipe card is the one place the new module reaches into existing UI, which cuts against the 'auctions are additive' guardrail." Resolution: kept, with the contradiction acknowledged and pushed into FR-013. The flag is accepted as the single deliberate exception to additivity, because without it the auction section has only one entry point. What the deck must not change is its _ordering_ — the flag is presentation only, and the ranking is untouched. The alternative counter-argument — that liking a flagged card is ambiguous, and a collector might believe a like entered them into the auction — was not resolved and is routed to Open Questions.

### Preserved

- [preserved] FR-013: Liking, the liked-artworks view, and the per-collector tag-match ordering of the swipe deck continue to work unchanged. The presentation of a swipe card changes only to carry the on-auction flag in FR-012; what a collector is served, and in what order, does not change at all. Priority: must-have
  > Socrates: Counter-argument considered: "FR-012 changes the swipe card, so claiming discovery is 'unchanged' is not strictly true — the preservation FR needs to name what it actually covers." Resolution: revised. The FR now names its scope precisely: the like action, the liked-artworks view, and the ranking/ordering are preserved; swipe-card presentation is explicitly excluded from that claim. The alternative counter-argument — that "works unchanged" is untestable as written — is answered by this narrowing, since ordering and the like action are both testable.
- [preserved] FR-014: Artwork upload, AI tagging, and publishing continue to work unchanged. Priority: must-have
  > Socrates: Challenged together with FR-013 under the same question. Resolution: kept as written. Unlike FR-013 this one has no contradicting FR — nothing in this change touches the upload, enrichment, or publish path, so the preservation claim is unqualified.

## Constraints & Compatibility

- **The product has never sent a message to its users.** An auction notification is the first outbound message the product makes to anyone. Everything that follows from that — being trusted as a sender, letting people stop receiving messages, knowing whether a message arrived — is new ground rather than an extension of something already working.
- **Nothing in the product happens on a timer today.** An auction that ends at a stated time is the first time-triggered behavior the product has. Every timing property in the guardrails above depends on it.
- **The only contact information the product holds is an account's email address.** There is no phone number, handle, or postal address for anyone, and no user can currently see another user's account details anywhere in the product. Contact exchange at close can therefore only hand over an email address, and it is the first time the product discloses one person's details to another.
- **Taste must mean the same thing in both places.** Auction targeting and the swipe deck must agree on what a collector's demonstrated taste is. Two divergent notions would surface as a collector being notified about work the deck never shows them — a visible contradiction, and one that would get worse over time.
- **The swipe deck's ordering must not change.** FR-012 adds a flag to the swipe card; which artworks a collector is served, and in what order, must be identical to today. Presentation is in scope, ordering is not.
- **Likes recorded before this change count normally.** Taste-based targeting reads whatever likes already exist, exactly as it reads later ones. Nothing needs converting and no history is discarded.
- **Dev-stage tolerance.** The project has no real user base, so refactors and behavior changes are acceptable where justified. This is not a production system with users to protect.

## Business Logic Changes

**New rule:** When an artwork goes up for auction, ArtSwipe decides which collectors hear about it, by matching the artwork's tags against each collector's demonstrated taste.

This **adds a domain rule** and leaves the existing ones intact. The product already derives descriptive tags for every artwork, and already orders each collector's swipe deck by matching those tags against the pieces that collector has liked. Both rules are unchanged. The new rule runs the existing match in the opposite direction: instead of asking "given this collector, which artworks?", it asks "given this artwork, which collectors?" — and uses the answer to decide who is told.

The rule consumes one artwork's tags plus the accumulated likes of every collector who has auction notifications enabled. Its output is the set of collectors who are told the auction exists. The collector encounters it as a message about a piece they would plausibly want; there is no control to operate and nothing to configure beyond turning the notifications off. Collectors who liked the artwork itself are included regardless of how their broader taste scores.

**Supporting rule:** an auction resolves by sealed bid — the highest bid standing when the end time passes wins, with the earliest bid taking a tie. This is the mechanical half of the change, and what any auction must do; the routing rule above is the half specific to this product.

## Access Control Changes

**No new roles and no new sign-in mechanism.** Access remains email-and-password. Every authenticated user is a collector by default and can become an artist through the existing one-step onboarding. The auction module reuses that boundary rather than extending it.

Three access rules are added, all expressible within the existing model:

- **Listing:** only a user who has completed artist onboarding may create an auction, and only for artwork they uploaded. This is the existing artist-owns-their-artwork boundary applied to a new object.
- **Bidding:** any authenticated user may bid, _except_ on an auction they are the seller of. Artists are collectors too and may legitimately want each other's work; the self-bid exclusion exists to rule out shill bidding — an artist inflating their own auction.
- **Visibility:** the auction section sits inside the existing authenticated area. Signed-out visitors cannot browse auctions. No public auction surface is built in v1.

**One new disclosure.** At auction close, the winning bidder and the seller are each shown the other's contact information. That disclosure is scoped to those two parties and to that auction — it is not a directory, and losing bidders receive nothing about the seller or the winner.

## Non-Goals

- **No payment handling.** No checkout, no escrow, no deposits, no card details, no payout. Rationale: the sale completes off-platform between two people who now have each other's contact details. Payments would dominate a three-week budget on their own, and bring compliance obligations the project is not equipped for.
- **No in-app messaging.** Contact exchange hands over contact details and stops there. Rationale: an inbox means threads, notifications, abuse reporting, and moderation — a product surface of its own, not a supporting detail of auctions.
- **No bundled or multi-artwork auctions.** One auction covers exactly one artwork. Rationale: cut during scope-down; bundles need a way to list several pieces together and an answer to what happens when only part of a set is wanted. Named here so it does not drift back in.
- **No shipping, tax, or fee handling.** ArtSwipe takes no commission and models no logistics. Rationale: whatever the two parties arrange is theirs; modelling it implies ArtSwipe is a party to the transaction, which it deliberately is not.
- **No collector-facing controls over auction targeting.** Beyond the on/off notification preference, there is no filtering by price, medium, or tag, and no way to tune what counts as a match. Rationale: consistent with how the recommender was scoped — the matching is invisible and automatic in v1.
- **No artist-facing analytics.** Artists get no view of how many collectors were notified, how targeting treated their work, or how many people viewed the auction. Rationale: the secondary success criterion was explicitly declined during shaping.
- **No reserve price and no buy-it-now.** Rationale: both were considered and declined during shaping. A reserve adds a "closed without a winner despite bids" outcome; buy-it-now adds a second close path racing the timed one.

## Open Questions

1. **Does a collector need a cap on how many auction notifications they receive?** The top-N targeting rule bounds how many collectors _one auction_ reaches, but not how many auctions reach _one collector_. A prolific artist listing several pieces could still reach the same collector repeatedly in a day, and the notification preference (FR-005) is all-or-nothing — so the only remedy available to an annoyed collector is turning auction notifications off entirely. — Owner: user.
2. **What does liking an on-auction card in the swipe deck mean?** FR-012 marks auctioned artwork in the deck, but a like on that card is ambiguous — the collector may believe it entered them into the auction, or may just be liking the piece. The deck has no answer for this today. — Owner: user.
3. **What happens to a collector who has liked nothing?** The recommendation engine falls back to unranked ordering for cold-start collectors. Taste-based targeting has no equivalent fallback defined — such a collector matches nothing, so they would be notified only about auctions on pieces they liked, which by definition is none. — Owner: user.
4. **Can an artist relist an artwork that failed to sell, and is there any limit?** FR-010 tells the artist the piece is free to relist, but nothing defines whether repeated relisting is bounded — which interacts directly with the notification-volume question above. — Owner: user.
5. **Do outbound messaging and timed closing fit inside the three-week budget?** Both are patterns the project has never had, and shaping flagged them as the largest sources of estimate risk. If they do not fit, FR-011 is the designated first cut. — Owner: user.

### Resolved during shaping

- **How is "taste matches this artwork" turned into a yes/no decision?** Settled at the closing cross-check rather than deferred, because the primary success criterion was untestable without it. A match is scored as a raw overlap count — how many of the artwork's tags appear in the collector's taste, the distinct union of tags across everything they have liked, unweighted. Targeting reuses that count: rank collectors by overlap, notify the top N, exclude anyone below a minimum overlap regardless of how few that leaves. Top-N was chosen over an absolute or proportional threshold because raw overlap has a broad-taste flaw — a collector who has liked a lot matches nearly everything, so any absolute cutoff would notify the most active collectors about every auction, the opposite of targeting. What N and the minimum overlap are is a tuning decision for implementation, not a shaping one.
