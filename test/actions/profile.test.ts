import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireProfile, requireUser, eq, update, upsert } = vi.hoisted(() => {
  const eq = vi.fn();
  return {
    requireProfile: vi.fn(),
    requireUser: vi.fn(),
    eq,
    update: vi.fn(() => ({ eq })),
    upsert: vi.fn(),
  };
});

vi.mock("@/lib/auth/dal", () => ({ requireProfile, requireUser }));
vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => ({ update, upsert })),
  })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  becomeArtist,
  updateDisplayName,
  updateNotificationPreference,
} from "@/app/actions/profile";

const form = (displayName: string) => {
  const fd = new FormData();
  fd.set("displayName", displayName);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  requireProfile.mockResolvedValue({ id: "user-1", role: "collector" });
  requireUser.mockResolvedValue({ id: "user-1", email: "user-1@example.test" });
  eq.mockResolvedValue({ error: null });
  upsert.mockResolvedValue({ error: null });
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

describe("updateNotificationPreference", () => {
  const preferenceForm = (value?: string) => {
    const fd = new FormData();
    if (value !== undefined) {
      fd.set("auctionEmailsEnabled", value);
    }
    return fd;
  };

  /**
   * The field is required precisely so that a dropped or malformed body is a
   * rejection rather than an opt-out. "Absent means off" is the failure mode
   * this schema exists to rule out.
   */
  it("rejects a missing setting without writing anything", async () => {
    const result = await updateNotificationPreference(
      undefined,
      preferenceForm(),
    );

    expect(result?.errors?.auctionEmailsEnabled).toBeDefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a value that is neither true nor false", async () => {
    const result = await updateNotificationPreference(
      undefined,
      preferenceForm("off"),
    );

    expect(result?.errors?.auctionEmailsEnabled).toBeDefined();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("turns notifications off and reports the stored value", async () => {
    const result = await updateNotificationPreference(
      undefined,
      preferenceForm("false"),
    );

    expect(result).toEqual({ enabled: false });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        auction_emails_enabled: false,
      }),
      { onConflict: "user_id" },
    );
  });

  it("turns notifications back on", async () => {
    const result = await updateNotificationPreference(
      undefined,
      preferenceForm("true"),
    );

    expect(result).toEqual({ enabled: true });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ auction_emails_enabled: true }),
      { onConflict: "user_id" },
    );
  });

  /**
   * Every export of a `"use server"` module is a public endpoint. The id must
   * come from the verified session, so a forged body naming somebody else has
   * to be ignored outright rather than merely refused by RLS.
   */
  it("ignores a user id supplied by the caller", async () => {
    const fd = preferenceForm("false");
    fd.set("user_id", "someone-else");
    fd.set("userId", "someone-else");

    await updateNotificationPreference(undefined, fd);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1" }),
      { onConflict: "user_id" },
    );
  });

  it("surfaces a write failure instead of claiming success", async () => {
    upsert.mockResolvedValue({ error: { message: "boom" } });

    const result = await updateNotificationPreference(
      undefined,
      preferenceForm("false"),
    );

    expect(result?.message).toContain("boom");
    expect(result?.enabled).toBeUndefined();
  });
});
