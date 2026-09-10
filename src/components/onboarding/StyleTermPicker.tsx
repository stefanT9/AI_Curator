"use client";

import { useState } from "react";
import { TAXONOMY_BY_FACET } from "@/lib/ai/taxonomy";
import {
  ONBOARDING_FACET,
  ONBOARDING_TERM_MAX,
  ONBOARDING_TERM_MIN,
} from "@/lib/onboarding/config";
import { submitButtonClass } from "@/components/ui/Field";

const TERMS = TAXONOMY_BY_FACET[ONBOARDING_FACET];

/**
 * The first screen of the flow: pick 2–4 style terms.
 *
 * The vocabulary is imported directly — `taxonomy.ts` is deliberately free of
 * `server-only` — so this costs no round trip.
 *
 * Selection lives in client state; submitting is a plain GET form, so the
 * chosen terms land in the URL as repeated `term` params and the server can
 * build the starter pool from them without persisting anything. The terms are
 * selection input, not a stored preference.
 *
 * The product has no multi-select primitive: `Field` covers input, textarea and
 * file only, and building the general case for one screen would be the wrong
 * trade. These are purpose-built toggle chips.
 */
export function StyleTermPicker() {
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (term: string) => {
    setSelected((previous) =>
      previous.includes(term)
        ? previous.filter((t) => t !== term)
        : // Silently ignoring the click past the cap would look broken; the
          // chip stays unselected and the counter below explains why.
          previous.length >= ONBOARDING_TERM_MAX
          ? previous
          : [...previous, term],
    );
  };

  const atCap = selected.length >= ONBOARDING_TERM_MAX;
  const canSubmit =
    selected.length >= ONBOARDING_TERM_MIN &&
    selected.length <= ONBOARDING_TERM_MAX;

  return (
    <form action="/onboarding" method="get" className="flex flex-col gap-4">
      <ul className="flex flex-wrap gap-2">
        {TERMS.map((term) => {
          const isSelected = selected.includes(term);
          return (
            <li key={term}>
              <button
                type="button"
                onClick={() => toggle(term)}
                aria-pressed={isSelected}
                // Unselected chips past the cap are inert but not `disabled`:
                // a disabled button drops out of the tab order, and the whole
                // list would shuffle its focusability on every click.
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  isSelected
                    ? "border-transparent bg-foreground text-background"
                    : `border-black/15 dark:border-white/20 ${
                        atCap
                          ? "opacity-40"
                          : "hover:bg-black/5 dark:hover:bg-white/10"
                      }`
                }`}
              >
                {term}
              </button>
            </li>
          );
        })}
      </ul>

      {/* The submitted payload. Hidden inputs rather than checkboxes so the
          chips above own the styling and the accessible pressed state. */}
      {selected.map((term) => (
        <input key={term} type="hidden" name="term" value={term} />
      ))}

      <p className="text-xs opacity-60" aria-live="polite">
        {selected.length} of {ONBOARDING_TERM_MAX} selected — pick at least{" "}
        {ONBOARDING_TERM_MIN}.
      </p>

      <button type="submit" disabled={!canSubmit} className={submitButtonClass}>
        Show me some art
      </button>
    </form>
  );
}
