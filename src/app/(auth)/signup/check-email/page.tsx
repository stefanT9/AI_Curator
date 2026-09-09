import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Check your email",
};

export default function CheckEmailPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">
        Check your email
      </h1>
      <p className="text-sm opacity-70">
        We sent you a confirmation link. Click it to finish setting up your
        account — then you&rsquo;ll be signed in automatically.
      </p>

      <p className="mt-6 text-center text-sm opacity-70">
        Already confirmed?{" "}
        <Link href="/login" className="font-medium underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </>
  );
}
