import { requireProfile } from "@/lib/auth/dal";

/**
 * A chrome-free shell for the first-run flow: no nav, no sign-out header, and
 * nothing to click but the flow itself.
 *
 * Authenticated, but deliberately **not** onboarding-gated — `requireOnboarded`
 * redirects here, so calling it from this segment would loop.
 */
export default async function OnboardingLayout({ children }: LayoutProps<"/">) {
  await requireProfile();

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
