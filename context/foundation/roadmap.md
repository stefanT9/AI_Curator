---
project: ArtSwipe
version: 1
status: draft
created: 2026-09-11
updated: 2026-09-11
prd_version: 3
main_goal: low-complexity
top_blocker: time
---

# Roadmap: ArtSwipe — Auction Mechanism

> Derived from `context/foundation/prd-v3.md` (v3) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

> **Which PRD this tracks.** `prd-v3.md` is the auction PRD and the source for this document.
> `prd.md` (v1, AI enrichment) and `prd-v2.md` (v2, recommendation engine) describe work that has
> already shipped; their roadmaps are in `context/foundation/archive/`. Every requirement cited
> below is a literal `FR-NNN` from `prd-v3.md`. Where a requirement lives in prose rather than
> behind an ID — the guardrails and the compatibility constraints — it is cited by section.

## Vision recap

ArtSwipe is good at putting the right artwork in front of the right collector and does nothing
about what happens next: a collector who likes a piece has no way to act on that interest inside
the product, and an artist has no way to turn accumulated interest into a sale. This change adds
the missing step — an artist lists one of their own pieces for auction, the product tells the
handful of collectors whose demonstrated taste matches it, those collectors bid without seeing
each other's bids, and at the end time the highest bid wins and the two parties are handed each
other's contact details to finish the deal off-platform. The part that is specific to this
product is not the auction; it is the routing — using the tag-match signal the recommendation
engine already produces to decide who hears about a listing, rather than telling everybody or
nobody.

## North star

**S-01: An artist can list one of their own artworks for auction, and it appears in a
dedicated auction section** — chosen as the slice to ship first because every other slice in this
roadmap attaches to the auction object it creates: there is nothing to notify collectors about,
nothing to bid on, and nothing to close until an auction exists.

> "North star" here means the slice sequenced first and protected from slipping — the one whose
> delivery the rest of the roadmap is arranged around. Note the honest limit of this particular
> choice: S-01 on its own demonstrates nothing about whether the feature works, because nobody is
> told about the listing and nobody can bid on it. The two slices that do demonstrate it are S-02
> (a collector places a sealed bid) and S-06 (the right collectors are the ones who hear about
> it) — S-01 is the spine both hang off, picked as the first move because it is the smallest
> end-to-end piece of the loop and `main_goal: low-complexity` breaks ties toward the smallest
> viable slice.

## At a glance

| ID   | Change ID                            | Outcome (user can …)                                                                      | Prerequisites | PRD refs                              | Status   |
| ---- | ------------------------------------ | ----------------------------------------------------------------------------------------- | ------------- | ------------------------------------- | -------- |
| F-01 | `shared-taste-definition`            | (foundation) taste means one thing, readable in both directions                            | —             | §Constraints, §Open Questions, FR-004, FR-013 | ready    |
| F-02 | `outbound-email-foundation`          | (foundation) the product can send one transactional message, through a single gated path   | —             | §Constraints, §Guardrails, FR-005     | ready    |
| S-01 | `list-artwork-for-auction`           | list their own artwork for auction, cancel it while untouched, and see it in one place      | —             | US-01, FR-001, FR-002, FR-006, FR-014 | done     |
| S-02 | `sealed-bidding`                     | place a bid nobody else can see, on anything but their own auction                         | S-01          | US-01, FR-007, FR-002                 | proposed |
| S-03 | `timed-auction-close`                | watch an auction reach its stated end time and close itself, with the highest bid winning   | S-02          | US-01, FR-008, §Guardrails, §Constraints | proposed |
| S-04 | `close-outcomes-and-contact-exchange` | learn they won and get the seller's details — or learn they did not, and get nothing        | S-03, F-02    | US-01, FR-009, FR-010, §Access Control | proposed |
| S-05 | `auction-notifications-for-likers`   | hear that a piece they liked is up for auction, and turn those messages off for good        | S-01, F-02    | US-01, FR-003, FR-005, §Guardrails    | proposed |
| S-06 | `taste-matched-auction-targeting`    | hear about an auction matching their taste even if they never saw that piece                | S-05, F-01    | US-01, FR-004, §Business Logic, §Success Criteria | proposed |
| S-07 | `on-auction-flag-in-deck`            | tell, while swiping, that a piece is currently on auction                                  | S-01          | FR-012, FR-013                        | blocked  |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in
the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                | Chain                                | Note                                                                                                    |
| ------ | -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| A      | Auction spine        | `S-01` → `S-02` → `S-03` → `S-04`    | The mechanism itself, in the order a single auction lives through it. Strictly sequential — each step needs the previous one's object to exist. F-02 joins at `S-04`. |
| B      | Targeted notification | `F-02` → `S-05` → `S-06`             | The half specific to this product. Can start as soon as `S-01` lands and runs alongside Stream A's tail. |
| C      | Shared taste          | `F-01`                               | Feeds Stream B at `S-06`. Independent of everything else — runnable at any point before `S-06`, including first. |
| D      | Deck surfacing        | `S-07`                               | Standalone; needs only `S-01`. Blocked on Open Question 2 and stays parked until it resolves.            |

## Baseline

What's already in place in the codebase as of `2026-09-11` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Next.js 16 App Router, React 19, Tailwind v4. Authenticated area at `src/app/(app)/**`; no auction surface exists.
- **Backend / API:** present — Server Actions in `src/app/actions/` across 6 domains. Exactly one route handler exists (`src/app/auth/confirm/route.ts`), so any externally-triggered endpoint is net-new ground.
- **Data:** present — Supabase Postgres, 13 migrations, RLS on every table. `profiles` carries `email`, but its select policy admits only the owner's own row — there is no existing path by which one user reads another's contact details.
- **Auth:** present — Supabase email/password plus one-step artist onboarding (`20260910190000_add_profile_onboarded_at.sql`), DAL at `src/lib/auth/dal.ts`. No new roles needed.
- **Deploy / infra:** present — Vercel, with `verify.yml` and `migrations.yml` on GitHub Actions. No `vercel.json` or `vercel.ts`, therefore **no scheduled execution of any kind** — confirming the PRD's "nothing in the product happens on a timer today".
- **Email / outbound messaging:** **absent** — no mail provider, SDK, or template library in `package.json`; no send path anywhere in `src/`. Confirms §Constraints: "the product has never sent a message to its users".
- **Observability:** partial — `@vercel/analytics` only. No logging, error tracking, or delivery monitoring; nothing today could tell you that an auction message failed to arrive.

**The finding that shapes this roadmap:** a collector's taste is computed as an inline CTE inside
the `swipe_deck` function (`supabase/migrations/20260910180000_rank_swipe_deck.sql`), not as
anything a second caller can reuse. §Constraints requires taste to mean the same thing in both
places, which is why F-01 exists.

## Foundations

### F-01: One definition of taste, readable in both directions

- **Outcome:** (foundation) a collector's taste — the distinct union of tags across the artworks they have liked — exists as one reusable definition, and can be queried the other way round: given an artwork's tags, which collectors overlap and by how much.
- **Change ID:** `shared-taste-definition`
- **PRD refs:** §Constraints ("taste must mean the same thing in both places"), §Open Questions (resolved: raw unweighted overlap count), FR-004, FR-013
- **Unlocks:** S-06 (taste-matched targeting has nothing to rank collectors by without it); reduces the §Constraints divergence risk — "two divergent notions would surface as a collector being notified about work the deck never shows them"; creates the verification path S-06 needs, since a reverse lookup can be checked against the deck's own ordering for the same collector.
- **Prerequisites:** —
- **Parallel with:** F-02, S-01, S-02, S-03, S-05, S-07
- **Blockers:** —
- **Unknowns:** —
- **Risk:** This is a behavior-preserving extraction on the one function that serves every collector's deck, so the risk is regression in ranking, not in auctions — FR-013 requires ordering to be byte-identical afterward, which is what makes it worth doing as its own step rather than inside S-06. Deliberately not sequenced first: nothing before S-06 consumes it.
- **Status:** ready

### F-02: The product can send a message, once, through one gated path

- **Outcome:** (foundation) a single send path exists that delivers one transactional message to one address, with every caller routed through the same choke point and a failure to send visible rather than silent.
- **Change ID:** `outbound-email-foundation`
- **PRD refs:** §Constraints ("the product has never sent a message to its users … being trusted as a sender, letting people stop receiving messages, knowing whether a message arrived — is new ground"), §Guardrails ("a collector who has turned auction notifications off receives none — from any path"), FR-005
- **Unlocks:** S-05 and S-06 (both notification slices) and S-04 (close outcomes) — three consuming slices, which is why it is a foundation rather than folded into the first of them; the single choke point is what makes the "from any path" guardrail checkable in one place instead of re-argued per caller.
- **Prerequisites:** —
- **Parallel with:** F-01, S-01, S-02, S-03, S-07
- **Blockers:** —
- **Unknowns:**
  - Which sending identity/domain does the product send from, given auth email already flows through Supabase? — Owner: user. Block: no.
- **Risk:** Deliberately minimal — one provider, one path, no templating system, no retry infrastructure — because `main_goal: low-complexity` and `top_blocker: time` both argue against building messaging infrastructure ahead of the two features that use it. The real risk it guards against is the reverse: letting each notification slice grow its own send path, after which the "off means off" guardrail has three places to fail instead of one. Observability being `partial` in the baseline is why "a failure is visible" is part of the outcome rather than assumed.
- **Status:** ready

## Slices

### S-01: An artist lists a piece for auction, and it shows up somewhere

- **Outcome:** An artist can list one of their own artworks for auction with a starting price and a preset duration, cancel it while no one has bid, and any authenticated user can browse open auctions in a dedicated section showing the artwork, the starting price, and the time remaining.
- **Change ID:** `list-artwork-for-auction`
- **PRD refs:** US-01, FR-001, FR-002, FR-006, FR-014
- **Prerequisites:** —
- **Parallel with:** F-01, F-02
- **Blockers:** —
- **Unknowns:**
  - Which preset durations are offered? FR-001 requires presets but does not name them. — Owner: TBD (implementation). Block: no.
- **Risk:** Sequenced first because everything else in the roadmap needs the auction object it creates; nothing here is reversible-hostile, since an auction with no bids can be cancelled by FR-002. FR-014 rides along because this is the slice that first attaches auction state to an artwork, making it the place to show that upload, tagging, and publishing still behave exactly as before. The cancellation rule is only half-exercised here — "locked once a bid exists" cannot be proven until S-02 makes bids possible.
- **Status:** done

### S-02: A collector places a bid nobody else can see

- **Outcome:** An authenticated user can place a sealed bid at or above the starting price on any auction except one they are the seller of, can raise their own bid, and no surface anywhere exposes the standing high bid, the bid count, or who has bid.
- **Change ID:** `sealed-bidding`
- **PRD refs:** US-01, FR-007, FR-002 (the lock-once-bid half)
- **Prerequisites:** S-01
- **Parallel with:** F-01, F-02, S-05, S-07
- **Blockers:** —
- **Unknowns:** —
- **Risk:** This is the slice the `data` investment is for. Two guardrails land here and neither can be retrofitted: "sealed means sealed … across every surface the product exposes, not only the ones that obviously show bids" and "two collectors bidding at the same instant must not both win". Both are properties of the database, not the interface — an RLS policy and a constraint hold under a caller that forgets to filter, a query-layer check does not. Per `AGENTS.md`, ownership filters are for correctness, never access control. The failure mode is quiet: a leaked standing bid reintroduces both sniping and shill-driving, which FR-007's whole mechanism change exists to remove, and nothing visibly breaks when it leaks.
- **Status:** proposed

### S-03: The auction closes itself, and the highest sealed bid wins

- **Outcome:** An auction stops accepting bids at its stated end time without anyone intervening, the highest sealed bid standing at that moment is the winner, an earlier bid beats a later one at the same amount, and the auction shows as closed.
- **Change ID:** `timed-auction-close`
- **PRD refs:** US-01, FR-008, §Guardrails (closes close enough to its stated end time), §Constraints (nothing happens on a timer today)
- **Prerequisites:** S-02
- **Parallel with:** F-01, F-02, S-05, S-06, S-07
- **Blockers:** —
- **Unknowns:**
  - What is "close enough" to the stated end time before a collector is misled — seconds, or minutes? §Guardrails states the property without a bound. — Owner: user. Block: no.
- **Risk:** The first time-triggered behavior the product has ever had; the baseline confirms no scheduling exists, so the trigger is stood up here rather than in a foundation — exactly one must-have slice needs it, and introducing it at the point of first use is cheaper than a scheduling layer nobody else calls. Named in Open Question 5 as one of the two largest sources of estimate risk, which under `top_blocker: time` is the reason it sits mid-chain: if the budget gives out here, S-01 and S-02 have already shipped as coherent capabilities. Two failure shapes to plan against, both from §Guardrails: a countdown that reaches zero with nothing happening, and a piece still open well past its advertised close.
- **Status:** proposed

### S-04: The winner and the seller get each other's details

- **Outcome:** At close with at least one bid, the winning bidder and the seller each receive the other's contact details; losing bidders are told they did not win and receive nothing about the seller or the winner. At close with no bids, the seller is told the auction ended and the artwork is free to relist.
- **Change ID:** `close-outcomes-and-contact-exchange`
- **PRD refs:** US-01, FR-009, FR-010, §Access Control ("one new disclosure")
- **Prerequisites:** S-03, F-02
- **Parallel with:** S-05, S-06, S-07
- **Blockers:** —
- **Unknowns:**
  - Is the disclosure delivered in the message, on the auction page, or both? FR-009 says the parties "receive" the details without fixing the surface. — Owner: user. Block: no.
- **Risk:** The first time the product discloses one person's details to another, and the baseline says there is no existing path for it — `profiles` admits only the owner's own row, so this needs a deliberate, narrowly-scoped exception rather than a relaxed policy. §Access Control is explicit that the disclosure is scoped to two parties and one auction: "it is not a directory". The obvious over-broad implementation — letting a bidder read the seller's profile — would satisfy FR-009 and quietly violate that. FR-010's message needs framing care too: §Scope of Change resolved it as a closing notice with the artwork free to relist, deliberately not a failure report.
- **Status:** proposed

### S-05: Collectors who liked the piece hear about it, and can make it stop

- **Outcome:** When an auction opens, every collector who liked that artwork and has auction notifications enabled is told about it; every collector has an auction-notification preference, on by default, which they can turn off, and every notification carries a one-click unsubscribe that turns it off.
- **Change ID:** `auction-notifications-for-likers`
- **PRD refs:** US-01, FR-003, FR-005, §Guardrails (no notification reaches an untargeted collector; off means off from any path)
- **Prerequisites:** S-01, F-02
- **Parallel with:** S-02, S-03, S-07
- **Blockers:** —
- **Unknowns:**
  - Does a collector need a cap on how many auction notifications they receive? Cross-cutting with S-06 — tracked as Open Roadmap Question 1; a cap would land here. — Owner: user. Block: no.
- **Risk:** FR-003 and FR-005 ship together deliberately: §Scope of Change records that FR-003 was revised to be conditioned on the FR-005 preference, because "a like was never consent to be emailed". Shipping the notification without the switch would ship the version the PRD explicitly rejected. Targeting is trivial in this slice — the recipients are a direct join on who liked the artwork — which is what makes it the right place to prove the preference gate works before S-06 adds recipients who never engaged with the piece at all. Per `context/foundation/lessons.md`, the send must not sit on the critical path of the artist's listing action: write the auction first, notify after.
- **Status:** proposed

### S-06: The right collectors hear about it, whether or not they ever saw the piece

- **Outcome:** When an auction opens, collectors whose demonstrated taste matches the artwork's tags and who have auction notifications enabled are told about it even if they never liked that specific piece — ranked by how many of the artwork's tags their taste already contains, top N notified, anyone below a minimum overlap excluded no matter how few that leaves.
- **Change ID:** `taste-matched-auction-targeting`
- **PRD refs:** US-01, FR-004, §Business Logic (the new domain rule), §Success Criteria ("targeting is part of it, not a nice-to-have")
- **Prerequisites:** S-05, F-01
- **Parallel with:** S-03, S-04, S-07
- **Blockers:** —
- **Unknowns:**
  - What happens to a collector who has liked nothing? Their taste is empty, so they match no auction and would only ever hear about pieces they liked — which by definition is none. The minimum-overlap rule already excludes them by default; the open question is whether that is the intended answer or whether they need a fallback, as the deck has one. (PRD Open Question 3.) — Owner: user. Block: no.
  - What are N and the minimum overlap? PRD marks this explicitly as "a tuning decision for implementation, not a shaping one". — Owner: TBD (implementation). Block: no.
- **Risk:** The slice that makes the feature this product's own rather than a generic auction — §Business Logic calls the routing rule "the half specific to this product" — and the one whose failure is hardest to see, because an over-broad match sends mail that looks fine individually and reads as junk in aggregate. §Scope of Change is blunt that this is the FR most likely to get the app's mail marked as spam, "which would poison auth email too" — a blast radius outside the auction feature entirely. Sequenced after S-05 so the preference gate is already proven before the first recipients who never engaged with the artwork are added.
- **Status:** proposed

### S-07: A swiper can tell a piece is on auction

- **Outcome:** An artwork with a live auction still appears in the swipe deck, in exactly the order it would have anyway, but is visibly marked as being on auction — while liking, the liked-artworks view, and the per-collector ordering behave exactly as they do today.
- **Change ID:** `on-auction-flag-in-deck`
- **PRD refs:** FR-012, FR-013
- **Prerequisites:** S-01
- **Parallel with:** F-01, F-02, S-02, S-03, S-04, S-05, S-06
- **Blockers:** —
- **Unknowns:**
  - What does liking an on-auction card mean? A like on a flagged card is ambiguous — the collector may believe it entered them into the auction. FR-012's resolution treats the flag as presentation only, but §Scope of Change records the ambiguity as unresolved and routed here, and this slice is the affordance that creates it. (PRD Open Question 2.) — Owner: user. **Block: yes.**
- **Risk:** §Guardrails says auctions are strictly additive and §Scope of Change acknowledges this slice as "the single deliberate exception" — the one place the new module reaches into the app's most-used surface. What must not move is the ordering: FR-013 and §Constraints both require which artworks a collector is served, and in what order, to be identical to today. Planning is genuinely blocked, not merely uncomfortable: the slice's entire content is a visual affordance whose meaning is undefined, and shipping it before Open Question 2 resolves risks a collector believing a swipe placed a bid.
- **Status:** blocked

## Backlog Handoff

| Roadmap ID | Change ID                             | Suggested issue title                                              | Ready for `/10x-plan` | Notes                                                        |
| ---------- | ------------------------------------- | ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------ |
| S-01       | `list-artwork-for-auction`            | Artist can list an artwork for auction and browse open auctions     | yes                   | Run `/10x-plan list-artwork-for-auction` — recommended first  |
| F-01       | `shared-taste-definition`             | Extract collector taste into one reusable, reversible definition    | yes                   | Independent; run any time before S-06                        |
| F-02       | `outbound-email-foundation`           | Stand up a single gated outbound-message path                       | yes                   | Independent; needed by S-04, S-05, S-06                      |
| S-02       | `sealed-bidding`                      | Collector can place a sealed bid on an auction                      | no                    | Needs S-01                                                    |
| S-03       | `timed-auction-close`                 | Auction closes automatically at its end time, highest bid wins      | no                    | Needs S-02; introduces the first scheduled execution          |
| S-04       | `close-outcomes-and-contact-exchange` | Winner and seller exchange contact details at close                 | no                    | Needs S-03 and F-02                                           |
| S-05       | `auction-notifications-for-likers`    | Notify collectors who liked the piece, with an off switch           | no                    | Needs S-01 and F-02                                           |
| S-06       | `taste-matched-auction-targeting`     | Notify collectors whose taste matches the artwork's tags            | no                    | Needs S-05 and F-01                                           |
| S-07       | `on-auction-flag-in-deck`             | Mark on-auction artworks in the swipe deck without changing order   | no                    | Blocked on Open Question 2                                    |

## Open Roadmap Questions

1. **Does a collector need a cap on how many auction notifications they receive?** The top-N rule bounds how many collectors one auction reaches, but not how many auctions reach one collector. A prolific artist listing several pieces could reach the same collector repeatedly in a day, and the FR-005 preference is all-or-nothing — so the only remedy available to an annoyed collector is turning auction notifications off entirely. — Owner: user. Block: S-05, S-06 (neither is blocked from planning; a cap would be added to both).
2. **Can an artist relist an artwork that failed to sell, and is there any limit?** FR-010 tells the artist the piece is free to relist, but nothing bounds repeated relisting — which interacts directly with the notification-volume question above. — Owner: user. Block: S-01, S-04 (not blocking; the default is unlimited relisting).
3. **Do outbound messaging and timed closing fit inside the three-week budget?** Both are patterns the project has never had, and shaping flagged them as the largest sources of estimate risk. This is the question behind `top_blocker: time`. If they do not fit, FR-011 is the designated first cut — it is already parked below. — Owner: user. Block: roadmap-wide.

(PRD Open Question 2 — what liking an on-auction card means — is single-slice and lives in S-07,
where it is the blocking unknown. PRD Open Question 3 — the collector who has liked nothing — is
single-slice and lives in S-06.)

## Parked

- **FR-011 — the "did this sell?" follow-up.** Why parked: the only nice-to-have in the PRD, and §Scope of Change names it "the designated first cut" if the budget tightens. Under `top_blocker: time` it is parked up front rather than sequenced and dropped later; §Success Criteria confirms the loop is provable without it.
- **Payment handling.** Why parked: PRD §Non-Goals — the sale completes off-platform between two people who now have each other's contact details; payments would dominate a three-week budget alone and bring compliance obligations the project is not equipped for.
- **In-app messaging.** Why parked: PRD §Non-Goals — an inbox means threads, notifications, abuse reporting, and moderation; a product surface of its own.
- **Bundled or multi-artwork auctions.** Why parked: PRD §Non-Goals — cut during scope-down; bundles need a way to list several pieces together and an answer to partial sales.
- **Shipping, tax, or fee handling.** Why parked: PRD §Non-Goals — modelling it implies ArtSwipe is a party to the transaction, which it deliberately is not.
- **Collector-facing controls over auction targeting.** Why parked: PRD §Non-Goals — beyond the on/off preference there is no filtering by price, medium, or tag; consistent with how the recommender was scoped.
- **Artist-facing analytics.** Why parked: PRD §Non-Goals — no view of how many collectors were notified or how targeting treated their work; the secondary success criterion was explicitly declined during shaping.
- **Reserve price and buy-it-now.** Why parked: PRD §Non-Goals — a reserve adds a "closed without a winner despite bids" outcome, buy-it-now adds a second close path racing the timed one.

## Done

(Empty on first generation. `/10x-archive` appends here when a change whose Change ID matches an
item above is archived.)

- **S-01: An artist can list one of their own artworks for auction with a starting price and a preset duration, cancel it while no one has bid, and any authenticated user can browse open auctions in a dedicated section showing the artwork, the starting price, and the time remaining.** — Archived 2026-09-11 → `context/archive/2026-09-11-list-artwork-for-auction/`. Lesson: —.
