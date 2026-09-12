---
change_id: close-outcomes-and-contact-exchange
title: The winner and the seller get each other's details at close
status: implementing
created: 2026-09-12
updated: 2026-09-12
archived_at: null
---

## Notes

Roadmap slice **S-04**, the last link in Stream A (the auction spine). Prerequisites `S-03`
(`timed-auction-close`) and `F-02` (`outbound-email-foundation`) are both done and on `main`.

PRD refs: US-01, FR-009, FR-010, §Access Control ("one new disclosure").

This is the slice where two things the project has never done meet: a Postgres-triggered event has
to reach Node, and one user's contact details have to reach another. `close_due_auctions` runs under
`pg_cron` and is granted to nobody; `profiles` revokes table-wide select and grants every column
except `email`. Neither gap is an oversight — both are load-bearing access control — so this slice
adds a deliberate, narrow path through each rather than relaxing either.

F-02's research (`context/archive/2026-09-12-outbound-email-foundation/research.md`, §3 and the
follow-up on platform-native bridges) already settled the recommended bridge topology and says
S-04 inherits it rather than starting from a blank page. Planning confirmed that recommendation
with two departures, both noted in the plan.

### Deliberately not in this slice

FR-011 (the follow-up asking whether the sale happened) — nice-to-have, and the PRD's designated
first cut. The FR-005 notification preference and one-click unsubscribe stay with S-05: close
outcomes are transactional and are never gated.
