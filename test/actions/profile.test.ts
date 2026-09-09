import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireProfile, eq, update } = vi.hoisted(() => {
  const eq = vi.fn();
  return { requireProfile: vi.fn(), eq, update: vi.fn(() => ({ eq })) };
});

vi.mock("@/lib/auth/dal", () => ({ requireProfile }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: vi.fn(() => ({ update })) })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { becomeArtist, updateDisplayName } from "@/app/actions/profile";

const form = (displayName: string) => {
  const fd = new FormData();
  fd.set("displayName", displayName);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireProfile.mockResolvedValue({ id: "user-1", role: "collector" });
  eq.mockResolvedValue({ error: null });
});

describe("becomeArtist", () => {
  it("rejects a too-short artist name", async () => {
    const result = await becomeArtist(undefined, form("x"));

    expect(result?.errors?.displayName).toBeDefined();
    expect(update).not.toHaveBeenCalled();
  });
});

describe("updateDisplayName", () => {
  it("rejects a too-short name", async () => {
    const result = await updateDisplayName(undefined, form(" "));

    expect(result?.errors?.displayName).toBeDefined();
  });

  it("writes the trimmed name and reports success", async () => {
    const result = await updateDisplayName(undefined, form("  Ada Lovelace  "));

    expect(result).toEqual({ success: true });
    expect(update).toHaveBeenCalledWith({ display_name: "Ada Lovelace" });
  });
});
