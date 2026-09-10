import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { StyleTermPicker } from "@/components/onboarding/StyleTermPicker";

export const metadata: Metadata = {
  title: "Getting started",
};

export default async function OnboardingPage() {
  // Not `requireOnboarded` — that gate redirects here, so this page checking it
  // would loop. Same early-redirect guard `becomeArtist` uses: a collector who
  // is already through the flow has no business seeing it again.
  const profile = await requireProfile();

  if (profile.onboardedAt !== null) {
    redirect("/discover");
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          What are you drawn to?
        </h1>
        <p className="mt-1 text-sm opacity-70">
          Pick a few styles and we&rsquo;ll start you off with work that matches
          — then your likes take over.
        </p>
      </div>

      <StyleTermPicker />
    </div>
  );
}
