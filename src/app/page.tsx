import Link from "next/link";
import { getAuthUser } from "@/lib/auth/dal";

export default async function LandingPage() {
  const user = await getAuthUser();

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg text-center">
        <p className="mb-3 text-sm font-medium uppercase tracking-widest opacity-50">
          ArtSwipe
        </p>
        <h1 className="mb-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Find art you actually like.
        </h1>
        <p className="mx-auto mb-8 max-w-md text-pretty opacity-70">
          Swipe through artwork, and ArtSwipe learns your taste — surfacing
          pieces and artists worth your attention, no gallery connections
          required.
        </p>

        {user ? (
          <Link
            href="/app"
            className="inline-block rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Open ArtSwipe
          </Link>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-black/15 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            >
              Sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
