import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mb-6 text-sm opacity-70">
        Sign in to keep discovering art you like.
      </p>

      <LoginForm next={typeof next === "string" ? next : undefined} />

      <p className="mt-6 text-center text-sm opacity-70">
        No account?{" "}
        <Link href="/signup" className="font-medium underline underline-offset-4">
          Create one
        </Link>
      </p>
    </>
  );
}
