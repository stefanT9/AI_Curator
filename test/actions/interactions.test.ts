import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, upsert } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({ requireUser }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: vi.fn(() => ({ upsert })) })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { recordInteraction } from "@/app/actions/interactions";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ id: "user-1", email: null });
  upsert.mockResolvedValue({ error: null });
});

describe("recordInteraction", () => {
  it("rejects a malformed artwork id before authenticating", async () => {
    const result = await recordInteraction("not-a-uuid", "like");

    expect(result).toEqual({ ok: false, message: expect.any(String) });
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    const result = await recordInteraction(VALID_UUID, "love" as "like");

    expect(result.ok).toBe(false);
  });

  it("upserts the verdict on the user/artwork pair for a valid swipe", async () => {
    const result = await recordInteraction(VALID_UUID, "like");

    expect(result).toEqual({ ok: true });
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "user-1", artwork_id: VALID_UUID, action: "like" },
      { onConflict: "user_id,artwork_id" },
    );
  });

  it("returns a failure result when the write errors", async () => {
    upsert.mockResolvedValue({ error: { message: "boom" } });

    const result = await recordInteraction(VALID_UUID, "skip");

    expect(result.ok).toBe(false);
  });
});
