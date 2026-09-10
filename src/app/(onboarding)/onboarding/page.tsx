import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { getStarterDeck } from "@/lib/artworks/queries";
import { parseStarterTerms } from "@/lib/onboarding/terms";
import { StyleTermPicker } from "@/components/onboarding/StyleTermPicker";
import { StarterDeck } from "@/components/onboarding/StarterDeck";
import { OnboardingHandoff } from "@/components/onboarding/OnboardingHandoff";

export const metadata: Metadata = {
  title: "Getting started",
};

/**
 * Both steps of the flow live on this one route. The picker submits back to it
 * as a GET form, so the chosen terms travel in the query string and nothing is
 * persisted — they are selection input for `getStarterDeck` and are read by
 * nothing afterwards.
 *
 * The starter pool depends on what this collector has already rated, so it must
 * not be cached across requests.
 */
export const dynamic = "force-dynamic";

export default async function OnboardingPage(props: PageProps<"/onboarding">) {
  // Not `requireOnboarded` — that gate redirects here, so this page checking it
  // would loop. Same early-redirect guard `becomeArtist` uses: a collector who
  // is already through the flow has no business seeing it again.
  const profile = await requireProfile();

  if (profile.onboardedAt !== null) {
    redirect("/discover");
  }

  const { term } = await props.searchParams;
  const terms = parseStarterTerms(term);

  if (terms === null) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            What are you drawn to?
          </h1>
          <p className="mt-2 text-sm leading-relaxed opacity-70">
            Pick a few styles you already love — there are no wrong answers, and
            nothing here is locked in. We&rsquo;ll open with a handful of pieces
            in that direction; from there, what you like is what shapes your
            feed.
          </p>
        </div>

        <StyleTermPicker />
      </div>
    );
  }

  const pool = await getStarterDeck(terms);

  // Nothing in the catalog carries any of the chosen tags. That is a terminal
  // state, not an error: the collector is released with `onboarded_at` stamped
  // and zero likes, landing on the newest-first deck. Rendering an empty rating
  // loop instead would strand them.
  if (pool.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Nothing matched just yet
        </h1>
        <p className="text-sm opacity-70">
          No work is tagged with those styles right now — we&rsquo;ll show you
          what&rsquo;s newest instead, and your likes will take it from there.
        </p>

        <OnboardingHandoff label="Taking you to Discover…" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Like a few to get started
        </h1>
        <p className="mt-1 text-sm opacity-70">
          Tell us what works here, and your feed is built from it.
        </p>
      </div>

      <StarterDeck pool={pool} />
    </div>
  );
}
