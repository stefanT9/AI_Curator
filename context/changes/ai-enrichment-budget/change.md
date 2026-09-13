---
change_id: ai-enrichment-budget
title: AI enrichment is unusable — the free vision roster regressed past its own timeout
status: new
created: 2026-09-13
updated: 2026-09-13
archived_at: null
---

## Notes

`enrichFromImage` currently fails for every real call. Found on 2026-09-13 while capturing
README screenshots for the `course-completion` change: the upload form renders "The suggestion
took too long" on every attempt, and `npm run test:smoke -- enrich` fails in ~6s.

This is **not** roster churn in the sense `src/lib/ai/enrich.ts` anticipated. All three pinned
models still exist, still advertise `image` input and `structured_outputs`, and are the **only
three** free vision + structured-output models OpenRouter lists — so there is nothing to
substitute in. What changed is availability and latency.

### Measurements (3 runs each, 2026-09-13)

Same request shape the app sends, real corpus image, `maxRetries: 0`:

| Model | Recorded 2026-09-09 | Measured 2026-09-13 |
| --- | --- | --- |
| `nex-agi/nex-n2.5-mini:free` (the lead) | 1.5–3.2s | **`AI_APICallError` every run** — 1.6s / 2.2s / 3.8s, "[Nex AGI] The request is invalid" |
| `dots-studio/dots-3-note-preview:free` | 6.2–11.1s | OK — 25.8s / 36.7s / 62.0s |
| `nex-agi/nex-n2.5-pro:free` | 9.1–10.5s | OK — 70.0s / 67.1s / 54.8s |

`TIMEOUT_MS` is 25 000 (`src/lib/ai/enrich.ts`), shared across the whole fallback chain. Nothing
in that table fits inside it reliably.

Confirmed on the real interactive path, not just by probe: the screenshot capture drove the
actual upload form three times, each sending the 768px-downscaled data URL
`downscaleToDataUrl` produces, and all three returned the timeout message. So this is not an
artifact of probing with a full-size image.

### A second, separate defect the investigation surfaced

`npm run test:smoke -- enrich` reports `invalid_response`, not `timeout`, because it uses a
synthetic placeholder image: a model that cannot find `MIN_GENERATED_TAGS` (5) on-taxonomy tags
for a blank placeholder trips `TypeValidationError`. `classify` maps that to `invalid_response`
and `isTerminal` stops the chain — so one model's inability to tag a placeholder retires the
whole chain before a better model is tried. Worth deciding on its own: is a schema miss really
terminal, or only terminal for *that* model?

### The decision this change exists to make

Dropping the dead lead model is unambiguous. After that the only lever is the budget, and the
two survivors need roughly 75s. That is nearly free for the publish-time top-up, which already
runs inside `after()` — and poor for the upload form's suggestion, which a person is watching.

So the likely shape is **a budget per caller** rather than one shared constant: short and
interactive for `suggestArtworkFields`, long and patient for `topUpTags`. That changes
`enrichFromImage`'s signature and touches `test/lib/ai.test.ts`, which is why it is a planned
change and not a constant bump.

Worth weighing during planning: whether a paid model is simply the right answer, given that the
free tier has now moved twice, and that `context/foundation/lessons.md`'s first entry exists
because of this same dependency.

### Why it was not fixed inside `course-completion`

That change is documentation plus one E2E test. An unplanned `src/lib/ai/` contract change
riding in a docs commit would contradict the plan discipline `docs/delivery-story.md` describes
two files away. The screenshot that would have advertised enrichment was dropped instead — see
`test/screenshots/tour.shot.ts`, which records the omission and the condition for restoring it.

### Starting points

- `src/lib/ai/enrich.ts` — `MODELS`, `TIMEOUT_MS`, `classify`, `isTerminal`
- `src/lib/ai/schema.ts` — `MIN_GENERATED_TAGS`, the constraint the placeholder trips
- `src/app/actions/enrichment.ts` — the interactive caller
- `src/lib/artworks/top-up.ts` — the `after()` caller
- `test/smoke/enrich.live.ts` — the lane that proves whichever roster is chosen
