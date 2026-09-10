import { describe, expect, it } from "vitest";
import { TAXONOMY_BY_FACET } from "@/lib/ai/taxonomy";
import {
  ONBOARDING_LIKE_TARGET,
  ONBOARDING_TERM_MAX,
  ONBOARDING_TERM_MIN,
} from "@/lib/onboarding/config";
import { parseStarterTerms } from "@/lib/onboarding/terms";
import { isOnboardingComplete } from "@/lib/onboarding/progress";

const [first, second, third, fourth, fifth] = TAXONOMY_BY_FACET.style;

describe("parseStarterTerms", () => {
  it("accepts a selection inside the allowed range", () => {
    expect(parseStarterTerms([first, second])).toEqual([first, second]);
  });

  it("rejects fewer than the minimum", () => {
    expect(ONBOARDING_TERM_MIN).toBe(2);
    expect(parseStarterTerms(first)).toBeNull();
    expect(parseStarterTerms(undefined)).toBeNull();
  });

  it("rejects more than the maximum", () => {
    expect(ONBOARDING_TERM_MAX).toBe(4);
    expect(parseStarterTerms([first, second, third, fourth, fifth])).toBeNull();
  });

  it("rejects terms outside the style vocabulary", () => {
    expect(parseStarterTerms([first, "not-a-style"])).toBeNull();
    // A term from another facet is still off-vocabulary here.
    expect(parseStarterTerms([first, TAXONOMY_BY_FACET.mood[0]])).toBeNull();
  });

  it("deduplicates before counting, so a repeated term is one selection", () => {
    expect(parseStarterTerms([first, first])).toBeNull();
    expect(parseStarterTerms([first, first, second])).toEqual([first, second]);
  });
});

describe("isOnboardingComplete", () => {
  it("completes on exhaustion with zero likes", () => {
    expect(
      isOnboardingComplete({
        likeCount: 0,
        hasNextCard: false,
        isSaving: false,
      }),
    ).toBe(true);
  });

  it("completes once the like target is reached", () => {
    expect(
      isOnboardingComplete({
        likeCount: ONBOARDING_LIKE_TARGET,
        hasNextCard: true,
        isSaving: false,
      }),
    ).toBe(true);
  });

  it("stays open mid-flow", () => {
    expect(
      isOnboardingComplete({
        likeCount: ONBOARDING_LIKE_TARGET - 1,
        hasNextCard: true,
        isSaving: false,
      }),
    ).toBe(false);
  });

  it("waits for an in-flight write, so a rolled-back like cannot end the flow", () => {
    expect(
      isOnboardingComplete({
        likeCount: ONBOARDING_LIKE_TARGET,
        hasNextCard: true,
        isSaving: true,
      }),
    ).toBe(false);
    expect(
      isOnboardingComplete({
        likeCount: 0,
        hasNextCard: false,
        isSaving: true,
      }),
    ).toBe(false);
  });
});
