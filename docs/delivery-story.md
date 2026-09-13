# How ArtSwipe was built

ArtSwipe went from an empty repository to a working product — a recommendation
engine, an artist studio, and a sealed-bid auction mechanism with transactional
email — in five days: 162 commits, 19 pull requests, 28 migrations, 43 test files
across four lanes, and 14 planned changes.

None of that was improvised. Every change went through the same cycle, and the
artifacts it produced are all still in the repository. This document is the
narrative those artifacts do not tell on their own: what got built, in what
order, why the scope moved three times, and what went wrong.

---

## How the work was organised

Work happened in a fixed loop of `/10x-*` steps, each producing a durable
document that the next step reads:

**Discovery** — `/10x-shape` turns an idea into shape notes; `/10x-prd` turns
those into a PRD against a locked schema; `/10x-roadmap` turns a PRD into an
ordered set of vertical, end-to-end slices. These are project-level and run
rarely — three times each, here.

**Per change** — `/10x-new` opens a change folder with an identity file.
`/10x-frame` challenges what to build before anyone plans how. `/10x-research`
fans out over the codebase and writes down what is actually there.
`/10x-plan` writes a phased implementation plan; `/10x-plan-review` attacks it
for substance and feasibility. `/10x-implement` (or `/10x-tdd`, or `/10x-e2e`)
executes it phase by phase, committing each phase and writing the SHA back into
the plan's `Progress` section. `/10x-impl-review` checks the result against the
plan for drift. `/10x-archive` closes the folder.

**Across changes** — `/10x-test-plan` produced a risk-ranked testing strategy
once; `/10x-lesson` captures a recurring mistake so the next change cannot make
it again.

The point of the durable artifacts is that the plan is the unit of review, not
the diff. A bad idea gets caught in `plan-review` where it costs a paragraph,
not in `impl-review` where it costs a branch.

```
context/
├── foundation/          # project-level, long-lived
│   ├── prd.md, prd-v2.md, prd-v3.md
│   ├── roadmap.md       # tracks prd-v3; the two earlier ones are in archive/
│   ├── test-plan.md     # risk-ranked testing strategy
│   ├── lessons.md       # accepted rules, re-read by every planning skill
│   ├── shape-notes.md, tech-stack.md, stack-assessment.md,
│   │   health-check.md, infrastructure.md
│   └── archive/         # superseded roadmaps and shape notes
├── changes/             # open changes
│   ├── course-completion/
│   └── data-driven-picker/
└── archive/             # the 14 closed changes, dated on close
```

A closed change folder holds its `change.md`, `plan.md` with a checked-off
`Progress` section, and whichever of `frame.md`, `research.md`,
`plan-brief.md`, `judgment.md`, `repro.md`, `reviews/` and `follow-ups/` that
change actually needed.

---

## Three generations of scope

The product was re-shaped twice after it started, and each time the PRD was
regenerated rather than patched. The old ones are still there, which is what
makes the movement legible.

### v1 — [`prd.md`](../context/foundation/prd.md): AI enrichment (2026-09-09)

The starting point was already brownfield: auth, an artist studio, and a
like/skip swipe deck existed. v1 asked one question — how do artworks get
usable metadata? — and answered it with a vision model reached through
OpenRouter. Its roadmap is
[`archive/2026-09-10-roadmap.md`](../context/foundation/archive/2026-09-10-roadmap.md).

**Why it moved:** enrichment is only worth anything if something consumes the
tags. Nothing did. The deck was ordered `created_at desc` for everyone.

### v2 — [`prd-v2.md`](../context/foundation/prd-v2.md): the recommendation engine (2026-09-10)

The actual pitch of the product: the deck should be ordered by the collector's
own taste. This generation delivered the ranking function, the corpus to judge
it against, the onboarding flow that gives a new collector enough signal to rank
with, and the real-boundary test lane that the ranking work exposed the need
for. Its roadmap is
[`archive/2026-09-11-roadmap.md`](../context/foundation/archive/2026-09-11-roadmap.md).

**Why it moved:** with discovery working, the unanswered question became what a
collector does when they find something they want. The original plan's answer
was "nothing in Layer 1 — hard boundary, no marketplace." That boundary was
reversed deliberately.

### v3 — [`prd-v3.md`](../context/foundation/prd-v3.md): the auction mechanism (2026-09-11)

Sealed bids, a timed close that runs without anyone watching, contact exchange
at close, and targeted notification to the collectors most likely to care. This
is the generation that forced real infrastructure: scheduled execution inside
Postgres, and an outbound-email path with a ledger behind it. Its roadmap is
the current [`roadmap.md`](../context/foundation/roadmap.md).

---

## The changes, in order

Fourteen changes, in the order they were closed. "PR" is where the
implementation landed; several changes rode the same long-lived branch.

| #   | Change                                                                                                      | What shipped                                                                                                                                                                      | PR       | The decision worth remembering                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [`ai-artwork-enrichment`](../context/archive/2026-09-09-ai-artwork-enrichment/)                             | Vision-model description and tag suggestions on the upload form, plus a publish-time top-up for under-tagged pieces                                                               | #4       | Enrichment is never a hard dependency. `enrichFromImage` never throws; unconfigured, it degrades to unavailable and upload still works.             |
| 2   | [`ranking-eval-corpus`](../context/archive/2026-09-10-ranking-eval-corpus/)                                 | Three seeded identities, 54 artworks in four deliberate tag clusters, and a like history — all through the existing `seed.sql` hook                                               | #10      | Build the instrument before the thing it measures. Ranking got a recorded _pre-change_ baseline to be judged against.                               |
| 3   | [`testing-upload-consistency`](../context/archive/2026-09-10-testing-upload-consistency/)                   | The real-boundary Vitest lane against a live local stack, and the fix for the path by which a published artwork lost its image                                                    | #10      | Questions about what the storage boundary _actually does_ cannot be answered by mocking it.                                                         |
| 4   | [`personalized-deck-ranking`](../context/archive/2026-09-10-personalized-deck-ranking/)                     | `swipe_deck` reordered by tag overlap against the collector's own likes; skipped pieces demoted instead of deleted                                                                | #14      | Taste is computed in SQL, where the data is — not in TypeScript over a fetched page.                                                                |
| 5   | [`swipe-deck-card-selection`](../context/archive/2026-09-10-swipe-deck-card-selection/)                     | The deck tracks position by artwork id instead of ordinal index                                                                                                                   | #15      | A live defect found by _using_ the feature, not by testing it. Re-ranking underneath an ordinal cursor skips cards.                                 |
| 6   | [`add-onboarding-flow-for-collector`](../context/archive/2026-09-10-add-onboarding-flow-for-collector/)     | Mandatory first-run flow: pick 2–4 style terms, like 5 pieces from a starter deck, then hand off to a genuinely ranked `/discover`                                                | #16      | A cold collector sees the fallback, and the fallback _is_ the product to a first-time viewer. Fix the cold start, don't special-case it.            |
| 7   | [`real-artwork-corpus`](../context/archive/2026-09-10-real-artwork-corpus/)                                 | 1000 public-domain artworks from the Art Institute of Chicago, tagged from museum metadata plus the real enrichment pipeline, generated into `seed.sql` from a committed manifest | #17      | A designed corpus can only show that ranking discriminates between clusters, never that the vocabulary matches real art.                            |
| 8   | [`push-corpus-to-prod`](../context/archive/2026-09-10-push-corpus-to-prod/)                                 | `npm run db:push` — a second _sink_ on the same manifest, writing to a linked project as a demo artist, dry-run unless `--apply`                                                  | #17      | A second sink on one pipeline, never a second seeding mechanism. It crosses the same RLS the product's own upload path crosses.                     |
| 9   | [`list-artwork-for-auction`](../context/archive/2026-09-11-list-artwork-for-auction/)                       | The `auctions` object, listing and cancellation, and a browse surface                                                                                                             | #19      | The schema and RLS shape chosen here are inherited by five downstream slices and are expensive to change once `bids` rows reference them.           |
| 10  | [`sealed-bidding`](../context/archive/2026-09-11-sealed-bidding/)                                           | The `bids` object, the only write path to it, and the bidding surface                                                                                                             | #19      | "Sealed" is a property of the RLS policy, not of the components. "Correct under concurrency" is a property of a row lock, not of the Server Action. |
| 11  | [`timed-auction-close`](../context/archive/2026-09-12-timed-auction-close/)                                 | `close_due_auctions` under a per-minute `pg_cron` job; highest sealed bid wins, earliest bid breaks a tie                                                                         | #19      | The first time-triggered behaviour in the product. `pg_cron`, not a platform cron — Vercel's Hobby plan fires once a day, anywhere inside its hour. |
| 12  | [`outbound-email-foundation`](../context/archive/2026-09-12-outbound-email-foundation/)                     | `src/lib/email/` as the single path to a mail provider, plus the append-only `email_sends` ledger                                                                                 | #19      | Build the choke point before the three callers that need it, or get three of them.                                                                  |
| 13  | [`close-outcomes-and-contact-exchange`](../context/archive/2026-09-12-close-outcomes-and-contact-exchange/) | Four outcome emails at close, the winner and seller exchanging addresses, and the `email_outbox` → `pg_net` → `/api/email/drain` bridge                                           | #19      | Postgres cannot call Node. Half a bridge and half a message.                                                                                        |
| 14  | [`auction-notifications-for-likers`](../context/archive/2026-09-13-auction-notifications-for-likers/)       | Everyone who liked a piece hears when it goes to auction, with a per-user preference and a one-click unsubscribe that needs no session                                            | _branch_ | A like was never consent to be emailed. The off switch shipped complete and tested _before_ the first row that could send anything was enqueued.    |

### The five that carry the real engineering

#### AI enrichment, and the defect that hid inside it

[`ai-artwork-enrichment`](../context/archive/2026-09-09-ai-artwork-enrichment/)
established the rule that survived everything after it: `enrichFromImage` never
throws. A failure comes back as `{ ok: false, reason }`, and each caller decides
whether to surface it (the upload form does) or swallow it (the publish-time
top-up does). With `OPENROUTER_API_KEY` unset the whole capability degrades to
unavailable and nothing else notices.

Then it shipped a defect worth reading the postmortem of. The first wiring
passed `enrichFromImage` a **Supabase Storage object key** where the function
expects a `data:` URL or an http(s) URL. The AI SDK treated the key as base64,
decoded garbage, and every call failed — silently, while still costing up to 25
seconds per publish. No artwork was ever enriched and nothing said so. It also
ran before the ownership and existence checks, and on every publish rather than
only under-tagged ones.

The fix became [`src/lib/artworks/top-up.ts`](../src/lib/artworks/top-up.ts):
conditional on `tags.length < 5`, after both gates, deduped, and passing the
**public Storage URL**. The class of bug — a third-party client that accepts a
string and fails silently on the wrong kind of string — is now a rule in
[`AGENTS.md`](../AGENTS.md).

#### Ranking, judged rather than asserted

[`personalized-deck-ranking`](../context/archive/2026-09-10-personalized-deck-ranking/)
is four sort keys inside one SQL function
([`rank_swipe_deck.sql`](../supabase/migrations/20260910180000_rank_swipe_deck.sql)):
tagged before untagged, unseen before skipped, tag overlap descending,
`created_at` descending. Taste is the distinct union of tags across everything
the collector has liked; skips are a demotion signal and never taste input.

What makes this change unusual is how it was judged. The previous change had
seeded a corpus with four designed tag clusters _specifically so this one could
be evaluated_, and a pre-change baseline reading was recorded before any code
moved. After the change, the same walk was repeated against the same corpus,
with the predicted orderings written down **before** the walk so the reading was
a check rather than a rationalisation — see
[`judgment-post-s01.md`](../context/archive/2026-09-10-personalized-deck-ranking/judgment-post-s01.md).
The decks were read by calling `swipe_deck` over psql with
`set local role authenticated` and the collector's JWT claims set, so RLS and
`auth.uid()` resolved exactly as they do for a signed-in request.

The original `PROJECT_PLAN.md` had called for an embedding vector and cosine
similarity. Tag overlap over the enriched controlled vocabulary discriminated
well enough on this corpus, is explainable, needs no extension, and can be read
straight out of psql. The vector column was never built.

#### Why a real-boundary lane had to exist at all

[`testing-upload-consistency`](../context/archive/2026-09-10-testing-upload-consistency/)
came out of the first entry in the risk-ranked
[test plan](../context/foundation/test-plan.md): _a published artwork loses its
image_. The mocked lane could not answer it, because the question was about what
Supabase Storage does — not about what the code asks it to do.

The lane found it. `supabase.storage.from("artworks").remove([key])` returns no
error but **does not delete the object, even when the caller owns it**:
`storage-api` lists matching objects before deleting them, and that list is gated
by a `select` policy on `storage.objects` that the original migration never
defined. So the compensating `remove()` in `createArtwork`'s failure branch did
nothing, `deleteArtwork` left every image in the bucket forever, and the
client-side removal was theatre. It is written up in
[`follow-ups/storage-cleanup-noop.md`](../context/archive/2026-09-10-testing-upload-consistency/follow-ups/storage-cleanup-noop.md)
— deliberately _not_ fixed in that change, because adding the `select` policy
makes the deletion path reachable and needs to land after the guard, not before.

That lane is now one of four, each with its own config and its own file glob so
one can never pick up another's specs. It refuses to run against anything but a
loopback host, because `.env.local` points at production and the lane creates
users.

#### The Postgres → Node bridge, and the two secrets

[`outbound-email-foundation`](../context/archive/2026-09-12-outbound-email-foundation/)
built one send path — [`sendEmail`](../src/lib/email/send.ts), which never
throws and returns a closed failure union — plus `email_sends`, an append-only
ledger with RLS enabled and **no policies at all**. The absent policies are the
access control: once notifications mail an artist's likers, an owner-readable
policy would disclose collector addresses to that artist.

[`close-outcomes-and-contact-exchange`](../context/archive/2026-09-12-close-outcomes-and-contact-exchange/)
then hit the structural problem. The auction close runs under `pg_cron`, inside
Postgres, where no Node code exists — and the close is exactly the event that
needs to send mail. The answer is a bridge: an `after update of closed_at`
trigger writes `email_outbox` rows (addresses resolved from `auth.users.email`),
and a per-minute job `pg_net`-POSTs [`/api/email/drain`](../src/app/api/email/drain/route.ts),
which claims, composes and sends them.

The interesting part is the secret split, and it was a **review finding, not a
design** — commit `5614d55`, "stop routing the RPC secret through `pg_net`".
`pg_net` persists every request it is handed into `net.http_request_queue`, a
table whose ACL grants `PUBLIC` every privilege; the grantor is `supabase_admin`
and migrations run as `postgres`, so this project _cannot_ revoke it. Anything
sent in that header is therefore public. So the two secrets were split by what
they can do:

- `EMAIL_DRAIN_TRIGGER_TOKEN` travels in the `pg_net` header. Treat it as
  public. All it can do is ask the route to drain.
- `EMAIL_DRAIN_SECRET` is what unlocks `claim_pending_emails`, which returns
  recipient and counterparty addresses. It never travels in a header, a body or
  a URL.

The same rule now binds any future `pg_net` caller: nothing that gates data
access goes over that hop —
[`split_drain_trigger_token.sql`](../supabase/migrations/20260913120300_split_drain_trigger_token.sql).

#### Unsubscribe without a session

[`auction-notifications-for-likers`](../context/archive/2026-09-13-auction-notifications-for-likers/)
shipped FR-003 and FR-005 together because the PRD made the first depend on the
second: _a like was never consent to be emailed_. The phase order enforced it
structurally — the off switch was complete and tested before the first row that
could send anything was ever enqueued.

Two properties of that off switch are worth stating, because both are easy to
get wrong in ways that look like success:

**The GET renders; only the POST mutates.** Link scanners at Gmail, Outlook and
corporate gateways prefetch every URL in a message. A mutating unsubscribe GET
would opt people out silently — indistinguishable from the feature working.

**Two secrets again, and one of them never reaches SQL.**
`UNSUBSCRIBE_TOKEN_SECRET` signs the HMAC in the link and can mint a valid token
for any user forever, so it stays in the Node process: never sent to Postgres,
never in the Vault, never in a header, body or URL. `UNSUBSCRIBE_RPC_SECRET`
gates the `security definer` write granted to `anon`, because the caller has no
session. Both halves are required — the secret alone cannot name a user, and the
token alone cannot write.

And a smaller rule with a real edge behind it: an `auction_opened` message whose
unsubscribe link cannot be built is **not sent**. `composeOutboxEmail` returns
null and the drain retires the row as `unrenderable`. A mail advertising an off
switch that does not work is worse than a mail not sent.

---

## What went wrong, and what it taught

Three mistakes were serious enough to be written into
[`context/foundation/lessons.md`](../context/foundation/lessons.md), which every
planning and implementation skill re-reads before it starts. They are reproduced
here with the incident behind each.

### 1. Never block a user-visible mutation on a third-party AI call

`createArtwork` evaluated `tags: await topUpTags(tags, imagePath)` _before_ the
row insert, so publishing an under-tagged piece waited on the OpenRouter
fallback chain — a 25-second budget — before anything was written. The PRD
guardrail said verbatim "no step in the upload flow blocks waiting on an AI
response", and a comment two lines away claimed enrichment "never blocks
publishing": true of model _failure_, false of model _latency_. It also widened
the orphan window, leaving an uploaded object with no row for the whole 25
seconds.

The fix (`fcf86a0`) moved the top-up into `after()`, so the model call runs once
the response has already been sent. **Write the user's own data first, then
enrich.** The rule generalised beyond AI: no third-party call belongs between a
user action and its durable result — which is why close outcomes go through an
outbox rather than straight from a Server Action.

### 2. Prove each Progress item before checking it off

In `testing-upload-consistency` Phase 3, the "red before green" tests were
committed already green, the fault-injection test the plan specified was never
written, a manual item "confirmed" a test that did not exist, and
`npm run test:integration` was red on `main` while seven Progress rows claimed it
passed. Step titles had been quietly reworded to fit the weaker tests that
actually shipped.

**Run the exact command the item names, and for a lane the default gate skips,
actually run that lane.** Never reword a step title to match what got built — if
the deliverable changed, stop and reconcile the plan. A red/green test must be
observed red before it is made green. This lesson is why the E2E test in the
current change was break-verified by neutralising the tag-overlap ordering and
watching it go red, rather than shipped green and trusted.

### 3. Check the branch before the first commit of a change

In `personalized-deck-ranking` Phase 1, the phase-end commit ritual ran
`git commit` with `HEAD` on `main`, landing `183d9f6` directly on the default
branch. It was caught only because the owner intervened mid-turn, and the
recovery (`git switch -c` plus `git branch -f main <old>`) worked only because
nothing had been pushed yet. Once pushed, the same slip needs a force-push to
the default branch to undo.

**Verify `HEAD` is not the default branch before the first commit of a change.**
Never recover a misplaced commit by force-pushing `main`.

---

## Where it stands

**Shipped and merged to `main`:** everything through roadmap slice S-04 — the
recommendation engine, the artist studio with AI enrichment, the 1000-piece
corpus, and the complete auction spine (list → sealed bid → timed close →
outcome emails → contact exchange).

**On a branch, awaiting merge:** S-05,
[`auction-notifications-for-likers`](../context/archive/2026-09-13-auction-notifications-for-likers/)
— notification to likers, the per-user preference, and the session-free
unsubscribe route. Implemented, reviewed and archived; it simply has not been
merged.

**Not built:**

- **F-01 `shared-taste-definition`** — taste is currently an inline CTE inside
  `swipe_deck`. S-06 needs the same definition readable from the other
  direction (given an artwork, which collectors match it), which is why it is a
  foundation rather than a refactor.
- **S-06 `taste-matched-auction-targeting`** — notify collectors whose taste
  matches an artwork's tags even if they never saw the piece. Blocked on F-01.
- **S-07 `on-auction-flag-in-deck`** — mark on-auction pieces while swiping.
  Blocked on an open roadmap question about whether the flag should influence
  deck ordering.

**Open and deliberately unfixed:**
[`data-driven-picker`](../context/changes/data-driven-picker/) — the onboarding
picker renders all 20 style terms from the taxonomy regardless of what the
catalogue actually holds, so a collector can pick a term no artwork carries and
land on the exhaustion path with no likes, indistinguishable from a broken flow.
Counted against the corpus on 2026-09-13: **13 of 20 terms are populated and 7
are empty** (the note in that folder still says "17 of 20 are empty", written
before the corpus grew and enrichment ran).

It was routed around rather than fixed. The alternatives all made the product
worse to make the seed data look better — narrowing the taxonomy removes terms
real artists will genuinely upload; switching the facet to `subject` changes what
the product asks collectors in order to suit a corpus; curatorial overrides put
false tags on real artwork to hit a number. The right fix is to make the picker
data-driven, which is its own change. Until then the E2E test pins the two
best-populated terms (`figurative`, 88 pieces; `realism`, 55) so it fails for
real reasons only.

---

## Further reading

- [`README.md`](../README.md) — what ArtSwipe is and how to run it.
- [`PROJECT_PLAN.md`](../PROJECT_PLAN.md) — the founding document, reconciled
  with what shipped, decision log intact.
- [`AGENTS.md`](../AGENTS.md) — the rules extracted from everything above,
  stated as constraints rather than stories.
- [`context/foundation/`](../context/foundation/) — the PRDs, roadmaps, test
  plan and lessons in full.
- [`context/archive/`](../context/archive/) — all 14 change folders, each with
  its plan, its `Progress` section and its reviews.
