# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Never block a user-visible mutation on a third-party AI call

**Context:** `src/app/actions/artworks.ts:128` — `createArtwork` evaluated `tags: await topUpTags(tags, imagePath)` before the row insert, so publishing an under-tagged piece waited on the OpenRouter fallback chain (25s budget) before anything was written.

**Problem:** The AI call sat on the critical path of a mutation the user is watching. The PRD guardrail said verbatim "no step in the upload flow blocks waiting on an AI response", and the code violated it while a comment two lines away claimed enrichment "never blocks publishing" — true of model _failure_, false of model _latency_. It also widened an orphan window: the uploaded object had no row for the whole 25s.

**Rule:** Write the user's own data first, then enrich. A third-party AI call must never sit between a user action and its durable result — insert or update with what the user supplied, then top up asynchronously and write the enrichment as a second, non-blocking step. If enrichment must be inline, its budget belongs to the interaction's latency budget, not the model's.

**Applies to:** Any Server Action or mutation path that calls `src/lib/ai/`, and any future enrichment of artworks, profiles or interactions.

## Prove each Progress item before checking it off

- **Context**: Any Automated or Manual item in a plan's `## Progress` section, during /10x-implement and /10x-impl-review — especially phases whose tests live in a lane the default verify gate does not run (integration / smoke / e2e).
- **Problem**: In testing-upload-consistency Phase 3, the "red before green" tests were committed already green, the fault-injection test the plan specified was never written, manual item 3.5 "confirmed" a test that did not exist, and `npm run test:integration` was red on main while seven Progress rows claimed it passed — step titles had been reworded to fit the weaker tests that shipped.
- **Rule**: Before checking a Progress item, run the exact command or observe the exact artifact it names; for a lane the default gate skips, actually run that lane. Never reword a step title to match what was built — if the deliverable changed, stop and reconcile the plan. A red/green test must be observed red before it is made green.
- **Applies to**: implement, impl-review

## Check the branch before the first commit of a change

- **Context**: Every `git commit` an agent runs in this repo, whatever skill it came from — the phase-end commit ritual and epilogue in /10x-implement and /10x-tdd, /feature-branch, and any ad-hoc commit.
- **Problem**: In /10x-implement personalized-deck-ranking phase 1, the phase-end commit ritual ran `git commit` with HEAD on main, landing 183d9f6 directly on the default branch. It was caught only because the user intervened mid-turn; the recovery (`git switch -c` + `git branch -f main <old>`) worked only because nothing had been pushed yet. Once pushed, the same slip needs a force-push to the default branch to undo. The ritual's 11 steps go straight from staging to commit with no branch check.
- **Rule**: Before the first commit of a change, verify HEAD is not on the default branch (`git rev-parse --abbrev-ref HEAD`). If it is, create and switch to `<type>/<change-id>` before staging anything. Never commit implementation work directly to main — and never recover a misplaced commit by force-pushing the default branch.
- **Applies to**: implement, impl-review
