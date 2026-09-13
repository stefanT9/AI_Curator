# E2E rules (browser lane)

Read before writing or changing anything under `test/e2e/`. The root `AGENTS.md`
describes how the lane is wired and run; this file is about what a spec in it is
allowed to look like.

## The rules

- Locate with `getByRole`, `getByLabel`, `getByText`. Fall back to `getByTestId`
  only when the accessible name is genuinely ambiguous — this app has no test
  ids today and should not grow one to satisfy a test.
- Never use a CSS selector, XPath, or DOM structure to find an element.
  `page.locator(".card > div:nth-child(3)")` breaks on a layout change that a
  collector would never notice.
- Never call `page.waitForTimeout()`. Wait for a state the app itself reports:
  `expect(locator).toBeVisible()`, `expect(locator).not.toHaveAttribute(...)`,
  `page.waitForURL()`, `page.waitForResponse()`. Playwright's web-first
  assertions retry until the condition holds; a fixed sleep is a guess that
  passes on this laptop and flakes on a slower one.
- One spec file, one `test()`, self-contained: its own signup, its own actions,
  its own assertions. No spec may depend on another having run, and none may
  depend on being the first run against the database — `npm run test:e2e` must
  pass twice in a row without a `db:reset` in between.
- Mint fixtures through `helpers.ts`. `uniqueEmail()` is what makes a re-run
  safe: this lane has no service-role key and cannot delete the accounts it
  creates, so uniqueness is the isolation mechanism, not cleanup.
- Drive the app the way a collector does. There is deliberately no Supabase
  client in this lane — a spec that seeds its own state out of band stops
  proving the flow it is named after.
- Assert the business outcome. Nothing is mocked here: auth, the proxy, RLS,
  Storage and the ranking RPC are all real, and that is the entire value of the
  lane.
- Name the test after the risk it protects, and cite the risk number from
  `context/foundation/test-plan.md` in the `describe`.

## The control question

Before a spec is considered done: **would it fail if its risk materialised?**
Not "does it pass" — every generated test passes. Answer it by breaking the
production behaviour on purpose, watching the spec go red, and reverting. A
green test nobody has seen fail is protecting nothing; that is the second entry
in `context/foundation/lessons.md`, and it is what this paragraph exists to
prevent.

## The exemplar

`taste-loop.spec.ts` is the seed test for this lane — the shape a new spec is
modelled on. There is no separate `seed.spec.ts`, deliberately: the glob is
`**/*.spec.ts`, so an exemplar file would be a second browser test running on
every invocation, and this lane holds one test per risk with no risk behind it.
The living spec is the exemplar; if it stops demonstrating these rules, fix it
rather than adding a demonstration beside it.

Read it for: role-based locators throughout, the progress line used as a state
gate instead of a sleep, a unique collector per run, and an assertion built so
the ranking — not merely a non-empty page — is what makes it pass.

## Adding a second test

Don't, without a risk of its own in `context/foundation/test-plan.md` §2. The
lane costs a full `next build` plus a seeded 1000-row corpus to run once.
Breadth here is explicitly not the goal (`test-plan.md` §7); if a cheaper lane
can prove the thing, it belongs there.
