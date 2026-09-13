---
change_id: auction-notifications-for-likers
title: Collectors who liked the piece hear about the auction, and can make it stop
status: implementing
created: 2026-09-13
updated: 2026-09-13
archived_at: null
---

## Notes

Roadmap slice **S-05**, the head of Stream B (targeted notification). Prerequisites `S-01`
(`list-artwork-for-auction`) and `F-02` (`outbound-email-foundation`) are both done and on `main`.

PRD refs: US-01, FR-003, FR-005, §Guardrails ("no notification reaches an untargeted collector";
"off means off — from any path").

FR-003 and FR-005 ship together by PRD decree, not by convenience: the FR-003 Socrates note records
that the notification was *revised* to be conditioned on the preference, because "a like was never
consent to be emailed". Shipping the notification without the switch ships the version the PRD
explicitly rejected.

This slice is mostly assembly rather than invention. S-04 built a general outbox — `email_outbox`,
`claim_pending_emails` / `mark_email_sent`, the drain route, the per-minute `pg_cron` job — and the
drain is already kind-agnostic. What is genuinely new is the consent half: a preference the product
has never had, and an unauthenticated route that acts on a user's behalf, which is the first of its
kind in the project.

### Deliberately not in this slice

Taste-matched targeting (FR-004) is S-06. The per-collector volume cap (PRD Open Question 1) is
deferred to S-06 with reasons recorded in the plan — under FR-003 alone, volume is bounded by the
collector's own likes, so a cap here would be untestable. HTML mail stays out, as in S-04.

### The delivery caveat

`EMAIL_FROM` is `onboarding@resend.dev` in both `.env.local` and `.env.prod`. Resend's shared sender
delivers only to the account owner's address; every other recipient returns 403, which
`src/lib/email/outbox.ts` classifies as the terminal failure `not_permitted`. This predates S-05 and
already affects S-04's close outcomes. It is an env change, not a code change, and the plan is
deliberately written so that every FR-003 / FR-005 guardrail is proven from ledger and outbox rows
rather than from delivery.
