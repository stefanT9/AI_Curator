"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { completeOnboarding } from "@/app/actions/onboarding";
import { submitButtonClass } from "@/components/ui/Field";

/**
 * The single owner of the flow's terminal transition. Both exit conditions land
 * here — the like target reached, and the starter pool exhausted (including a
 * pool that was empty from the start, when the chosen terms matched nothing).
 *
 * It fires on mount rather than behind a button because there is no decision
 * left to make: the collector has already done everything the flow asks of
 * them, and a "Continue" click would be ceremony. `completeOnboarding` runs
 * from here — a Client Component invoking a Server Action — rather than from
 * the page's render, because `revalidatePath` throws when called during render.
 *
 * On success the action redirects, so this component is unmounted by the
 * navigation and never re-renders. The error path is the only one that stays on
 * screen, and it must offer a retry: a collector stranded here with no way
 * forward is the lockout this flow exists to avoid.
 */
export function OnboardingHandoff({ label }: { label?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Survives the StrictMode double-effect in development. `completeOnboarding`
  // is idempotent regardless, so this saves a round trip rather than a bug.
  const hasFired = useRef(false);

  const finish = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        await completeOnboarding();
      } catch {
        // The action's message is replaced by a digest in production, so there
        // is nothing specific to surface — only something to try again.
        setError("We couldn't finish setting you up.");
      }
    });
  }, []);

  useEffect(() => {
    if (hasFired.current) return;
    hasFired.current = true;
    finish();
  }, [finish]);

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      {error ? (
        <>
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
          <button
            type="button"
            onClick={finish}
            disabled={isPending}
            className={submitButtonClass}
          >
            {isPending ? "Trying again…" : "Try again"}
          </button>
        </>
      ) : (
        <p className="text-sm opacity-70" aria-live="polite">
          {label ?? "Setting up your feed…"}
        </p>
      )}
    </div>
  );
}
