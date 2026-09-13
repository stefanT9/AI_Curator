/**
 * Per-run fixtures for the browser lane.
 *
 * Deliberately thin. Everything this lane does, it does through the UI a real
 * collector uses — there is no Supabase client here and no seeding by API,
 * because a browser test that sets up its state out of band stops proving the
 * flow it is named after.
 */

/**
 * A collector address nothing else will collide with.
 *
 * Mirrors `test/integration/helpers.ts`, which mints
 * `artswipe-int-<uuid>@example.test`. The differing prefix is the point: when
 * a stray account turns up in Supabase Studio, the prefix says which lane left
 * it there.
 *
 * `.test` is reserved by RFC 2606 and can never resolve, so a misconfigured
 * stack that tried to send mail here would fail loudly rather than reach a
 * real inbox. Locally it never gets that far —
 * `supabase/config.toml` sets `auth.email.enable_confirmations = false`, so a
 * UI signup yields a session in one round trip with no confirmation mail.
 *
 * Mint **one collector per spec file**, not per test.
 * `[auth.rate_limit] sign_in_sign_ups` is 30 per five minutes per IP
 * (`supabase/config.toml`), and this lane shares that budget with the
 * integration lane — the two are routinely run back to back.
 */
export const uniqueEmail = (prefix = "artswipe-e2e"): string =>
  `${prefix}-${crypto.randomUUID()}@example.test`;

/** A password strong enough for GoTrue's default policy, unique per call. */
export const uniquePassword = (): string => `pw-${crypto.randomUUID()}`;

/**
 * The two style terms the onboarding picker may be driven with.
 *
 * `ONBOARDING_TERM_MIN` is 2, so a spec needs at least this many — and it
 * cannot pick freely. Counted against `supabase/seed-assets/corpus.json` on
 * 2026-09-13: only 196 of the 1000 seeded rows carry enrichment tags, which is
 * where essentially every style tag comes from, and the 20 terms in
 * `src/lib/ai/taxonomy.ts` are covered very unevenly:
 *
 *   figurative 88 · realism 55 · illustrative 39 · geometric 17 · folk art 17
 *   abstract 15 · art nouveau 10 · expressionist 5 · gestural 5
 *   impressionist 4 · minimalist 3 · surrealist 1 · street art 1
 *   hyperrealism, cubist, pop art, art deco, brutalist, naive, psychedelic: 0
 *
 * Picking either of the two best-populated terms fills the starter pool
 * (`ONBOARDING_POOL_SIZE` is 24) comfortably. Picking any of the seven empty
 * ones lands on the onboarding exhaustion path and fails the spec red for a
 * reason that has nothing to do with what it is testing.
 *
 * That unevenness is a real product defect, tracked as the open
 * `data-driven-picker` change. This lane routes around it on purpose rather
 * than fixing it; if that change lands and the picker only ever offers
 * populated terms, this constant can go.
 */
export const POPULATED_STYLE_TERMS = ["figurative", "realism"] as const;
