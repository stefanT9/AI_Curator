import Link from "next/link";
import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = {
  title: "Create account",
};

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Create your account
      </h1>
      <p className="mb-6 text-sm opacity-70">
        Start building a taste profile in a few swipes.
      </p>

      <SignupForm />

      <p className="mt-6 text-center text-sm opacity-70">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
