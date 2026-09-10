import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireProfile, eq, update, redirect, revalidatePath } = vi.hoisted(
  () => {
    const eq = vi.fn();
    return {
      requireProfile: vi.fn(),
      eq,
      update: vi.fn(() => ({ eq })),
      // Next's `redirect` never returns — it throws a signal the framework
      // catches. Mocking it as a no-op would let execution fall through the
      // early return this action depends on, so the mock throws too.
      redirect: vi.fn((to: string) => {
        throw new Error(`NEXT_REDIRECT:${to}`);
      }),
      revalidatePath: vi.fn(),
    };
  },
);

vi.mock("@/lib/auth/dal", () => ({ requireProfile }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: vi.fn(() => ({ update })) })),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));

import { completeOnboarding } from "@/app/actions/onboarding";

const profile = (onboardedAt: string | null) => ({
  id: "user-1",
  email: null,
  displayName: null,
  role: "collector" as const,
  onboardedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireProfile.mockResolvedValue(profile(null));
  eq.mockResolvedValue({ error: null });
});

describe("completeOnboarding", () => {
  it("stamps onboarded_at and hands off to the deck", async () => {
    await expect(completeOnboarding()).rejects.toThrow(
      "NEXT_REDIRECT:/discover",
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ onboarded_at: expect.any(String) });
    expect(eq).toHaveBeenCalledWith("id", "user-1");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("redirects without re-stamping when onboardedAt is already set", async () => {
    requireProfile.mockResolvedValue(profile("2026-09-10T00:00:00.000Z"));

    await expect(completeOnboarding()).rejects.toThrow(
      "NEXT_REDIRECT:/discover",
    );

    expect(update).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("goes through requireProfile, so an unauthenticated caller never reaches the write", async () => {
    // `requireProfile` redirects to /login rather than returning for a
    // signed-out caller; the action must not proceed past it.
    requireProfile.mockRejectedValue(new Error("NEXT_REDIRECT:/login"));

    await expect(completeOnboarding()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(update).not.toHaveBeenCalled();
  });

  it("surfaces a failed stamp rather than redirecting as if it worked", async () => {
    eq.mockResolvedValue({ error: { message: "permission denied" } });

    await expect(completeOnboarding()).rejects.toThrow(/permission denied/);
    expect(redirect).not.toHaveBeenCalled();
  });
});
