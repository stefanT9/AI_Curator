---
change_id: testing-upload-consistency
title: Real-boundary test lane and upload/publish consistency
status: impl_reviewed
created: 2026-09-10
updated: 2026-09-10
archived_at: null
---

## Notes

Open a change folder for rollout Phase 1 of context/foundation/test-plan.md: "Real-boundary lane and upload consistency".
Risks covered: Risk #1 — an artwork is published whose stored image key resolves to nothing, so the card renders broken for every collector and the artist's piece is effectively lost.
Test types planned: real-boundary integration (real local database + storage, not mocked).
Risk response intent: prove that a published artwork always has a retrievable image, and that a failed upload never leaves a published row behind. The check-then-insert sequence is not atomic, and the existing suite mocks Supabase at exactly that seam, so this phase must also establish the lane that can observe real database and storage behavior — which requires amending the AGENTS.md rule that Supabase is never hit for real.
After creating the folder, follow the downstream continuation rule.
