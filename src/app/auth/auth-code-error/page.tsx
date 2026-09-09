import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Link expired",
};

export default function AuthCodeErrorPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-1 text-xl font-semibold tracking-tight">
          That link didn&rsquo;t work
        </h1>
        <p className="mb-6 text-sm opacity-70">
          Confirmation links expire and can only be used once. Try signing in,
          or create your account again to get a fresh link.
        </p>
        <div className="flex justify-center gap-3 text-sm">
          <Link href="/login" className="font-medium underline underline-offset-4">
            Sign in
          </Link>
          <Link href="/signup" className="font-medium underline underline-offset-4">
            Create account
          </Link>
        </div>
      </div>
    </main>
  );
}
