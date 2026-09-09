import { beforeEach, describe, expect, it, vi } from "vitest";

const { getClaims, redirect } = vi.hoisted(() => ({
  getClaims: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getClaims } })),
}));
vi.mock("next/navigation", () => ({ redirect }));

// `getAuthUser` is wrapped in React's `cache()`. Re-import per test so one
// test's memoised result can't leak into the next.
const loadDal = async () => {
  vi.resetModules();
  return import("@/lib/auth/dal");
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAuthUser", () => {
  it("returns null when the JWT can't be verified", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: { message: "bad token" },
    });
    const { getAuthUser } = await loadDal();

    expect(await getAuthUser()).toBeNull();
  });

  it("returns a narrow DTO from verified claims, not the raw claims", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: "user-1",
          email: "a@b.com",
          user_metadata: { role: "admin" },
        },
      },
      error: null,
    });
    const { getAuthUser } = await loadDal();

    expect(await getAuthUser()).toEqual({ id: "user-1", email: "a@b.com" });
  });
});

describe("requireUser", () => {
  it("redirects to /login when there is no user", async () => {
    getClaims.mockResolvedValue({
      data: null,
      error: { message: "no session" },
    });
    const { requireUser } = await loadDal();

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });
});
