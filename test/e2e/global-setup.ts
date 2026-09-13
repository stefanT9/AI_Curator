/**
 * The async half of the browser lane's guard: is the local stack up?
 *
 * The loopback half — refusing anything but 127.0.0.1 — deliberately does
 * **not** live here. Playwright boots `webServer` before `globalSetup`, so by
 * the time this runs a full `next build` has already completed and `next
 * start` is serving; a guard here could not stop a build against the wrong
 * credentials, only report one after the fact. `playwright.config.ts` calls
 * `requireLocalStack` at module scope for that reason, which is the only point
 * earlier than the server.
 *
 * What is left is the health probe, which cannot run at config load because
 * config evaluation is synchronous. It earns its place anyway: a stopped stack
 * otherwise costs a three-minute cold build followed by a spec failing on a
 * selector, instead of one line saying `npx supabase start`.
 *
 * The import across lanes is intentional. `requireRunningStack` already
 * answers this question for the integration lane, and two definitions of "is
 * the stack up?" is one more than this codebase should hold.
 */

import { requireLocalStack, requireRunningStack } from "../integration/setup";

export default async function globalSetup(): Promise<void> {
  // Re-reads the same vetted values the config guarded; cheap, and keeps this
  // hook honest if it is ever run outside that config.
  await requireRunningStack(requireLocalStack().url);
}
