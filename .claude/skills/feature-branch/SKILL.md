---
name: feature-branch
description: Create a feature branch and land the working tree as a series of logical, reviewable commits. Verifies the base branch, runs the project's verify gate, splits work into independently revertible commits with substantive Conventional-Commits messages, and never pushes without being asked. Use when the user says "create a branch and commit", "commit this feature", "branch and commit like before", or when a chunk of work is finished and needs to land.
argument-hint: "[branch-name] [freeform intent]"
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

# Feature Branch & Commits

Land finished work as a branch whose history someone can actually review: each commit independently reviewable, independently revertible, and honest about what was verified.

## Hard rules

These are not negotiable. Violating any of them silently corrupts history or misleads a reviewer.

1. **Stage by explicit path. Never `git add -A` or `git add .`** — those sweep in whatever else is dirty.
2. **Never `--no-verify`, `--amend`, or `--force`.** If a pre-commit hook fails, fix the cause and make a NEW commit; the failed commit did not happen, so amending would rewrite the *previous* commit.
3. **Never push unless explicitly asked.** Creating commits is local and reversible; pushing is not.
4. **Never mark unverified work as verified.** If tests were skipped, a manual step is unconfirmed, or a check is blocked on infrastructure, say so in the commit body and in your summary.
5. **Interactive git is unavailable** (`git add -p`, `git rebase -i`). Plan splits around that — see "When a file spans two commits".
6. **Never commit secrets.** `.env.local` and similar are gitignored for a reason; if a staged file contains a credential, stop and say so.

## Flow

### 1. Establish the base

```bash
git branch --show-current
git log --oneline -5
```

Branch from the project's main branch unless told otherwise. Before branching, confirm the base actually contains any prerequisite work this change depends on — a branch cut from a stale base produces a PR that fails CI for reasons unrelated to its diff:

```bash
git merge-base --is-ancestor <prereq-sha> HEAD && echo present || echo MISSING
```

Then create it. Name it `<type>/<kebab-summary>` (`feat/`, `fix/`, `chore/`, `docs/`), taking the name from the argument when given:

```bash
git checkout -b feat/<kebab-summary>
```

If the user is already on a suitable non-default branch, ask before creating another.

### 2. Survey the tree

```bash
git status --porcelain
```

Split what you see into two sets:

- **Touched** — files this piece of work actually changed. You know these from the conversation; do not infer them from `git status` alone.
- **Unrelated dirty** — everything else: stragglers from other work, untracked scratch files, unrelated edits.

If the unrelated set is non-empty, do not decide for the user. Ask:

> question: "`<paths>` are dirty but weren't touched by this work. How should I handle them?"
> header: "Dirty paths"
> options: Continue — stage only the planned set (recommended) / Stage all / Abort

### 3. Verify before committing

Discover the project's gate rather than assuming one. Check `AGENTS.md` / `CLAUDE.md` first, then `package.json` scripts, then `Makefile`. Run the full set and report real output.

In this project the gate is:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build
```

If something fails, fix it before committing — or, if the user directs you to commit anyway, do so and say plainly in the summary what is failing.

### 4. Decide the commit split

Default to **one commit per logical change**, not one per file and not one per phase. Good seams:

- a schema/migration change, separate from the code that uses it — so it can be reverted alone
- a new module plus its tests, separate from the UI that consumes it
- test-only or tooling-only changes
- docs and planning artifacts

When more than one seam exists, ask rather than assume:

> question: "How should this work be split?"
> header: "Commit split"
> options: N logical commits (recommended, name them) / two / one

Order commits so each builds on the last. A reviewer should be able to check out any commit and have a coherent tree.

#### When a file spans two commits

Some files legitimately belong to two seams — `package.json` carrying both a dependency and an unrelated script, for example. Interactive staging is unavailable, so:

1. Put the file with the **larger or more fundamental** half.
2. Say so explicitly in that commit's body, so a reviewer isn't confused by the stray hunk.

Never contort the split to avoid this; a one-line note is cheaper than a bad seam.

### 5. Stage and commit

Stage by name, then commit via heredoc so the body survives shell quoting:

```bash
git add path/one path/two
git commit -m "$(cat <<'EOF'
<type>(<scope>): <imperative summary>

<why this change exists — the problem, not a restatement of the diff>

<any deviations from the plan, and why>
<anything left unverified>

<attribution line from the conversation's system-reminder, if present>
EOF
)"
```

### 6. Report, and stop

Summarise the branch and its commits in a table. State what is **not** verified. Then stop — offer the push rather than performing it, and flag any side effect of merging (e.g. a workflow that auto-applies migrations to production on merge to `main`).

## Commit messages

Conventional Commits: `<type>(<scope>): <summary>`.

`feat` · `fix` · `chore` · `refactor` · `docs` · `test` · `ci` · `style` · `perf`

**The subject** is imperative and specific. `raise artwork tag ceiling to 20`, not `update tags`.

**The body** earns its place by explaining what the diff cannot:

- **why** the change exists — the problem it solves
- **why this approach**, where a reader would reasonably wonder
- **deviations** from a plan or an obvious approach, with the reason
- **what is unverified**, if anything
- constraints a future reader would otherwise rediscover the hard way

Do not restate the file list — `git show --stat` already has it. Mention a file only when its role isn't obvious.

Write prose, not bullet-fragments, when explaining reasoning. Wrap at ~78 columns.

## Gotchas

- **`git status` is not the source of truth for staging.** It reports dirt, not intent. Your touched-file set comes from what you actually changed.
- **A "clean" gate on a dirty tree proves little.** Run the gate on what you're about to commit.
- **Check the base branch for prerequisites** before blaming a red PR on your own diff.
- **Generated artifacts** (`.next/`, coverage, build output) should be gitignored, not committed. If one shows up untracked, that's a gitignore gap worth mentioning.
- **Lockfiles belong with the dependency change** that produced them.
- **A migration commit is special**: keep it alone so it can be reverted without touching application code, and state whether it is permissive (widening) or restrictive (narrowing) — restrictive migrations may fail on existing data and need a data-fixing step before rollback.
