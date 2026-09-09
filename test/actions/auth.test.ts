import { beforeEach, describe, expect, it, vi } from "vitest";

// Server Actions pull in Next request APIs and the Supabase server client at
// import time. Stub them — these smoke tests only cover the Zod validation gate
// that runs before any of them is touched.
const { signInWithPassword, signUp } = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
}));

vi.mock("@/utils/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { signInWithPassword, signUp },
  })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

import { login, signup } from "@/app/actions/auth";

const form = (entries: Record<string, string>) => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.set(key, value);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("login", () => {
  it("rejects an invalid email without calling Supabase", async () => {
    const result = await login(
      undefined,
      form({ email: "nope", password: "secret" }),
    );

    expect(result?.errors?.email).toBeDefined();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("rejects a missing password", async () => {
    const result = await login(
      undefined,
      form({ email: "a@b.com", password: "" }),
    );

    expect(result?.errors?.password).toBeDefined();
  });
});

describe("signup", () => {
  it("rejects a password shorter than 8 characters", async () => {
    const result = await signup(
      undefined,
      form({ email: "a@b.com", password: "short" }),
    );

    expect(result?.errors?.password).toBeDefined();
    expect(signUp).not.toHaveBeenCalled();
  });
});
