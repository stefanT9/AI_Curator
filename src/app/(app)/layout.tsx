import Link from "next/link";
import { requireOnboarded } from "@/lib/auth/dal";
import { SignOutButton } from "@/components/auth/SignOutButton";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // The proxy already redirected signed-out visitors, but that check is
  // optimistic. This is the one that actually guards the segment — and the one
  // that makes onboarding mandatory, since a deep link to any page in here
  // skips the proxy's optimistic pass but never this.
  const profile = await requireOnboarded();

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b border-black/10 px-4 py-3 dark:border-white/15">
        <div className="flex items-center gap-5">
          <Link href="/app" className="font-semibold tracking-tight">
            ArtSwipe
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/discover" className="opacity-70 hover:opacity-100">
              Discover
            </Link>
            <Link href="/liked" className="opacity-70 hover:opacity-100">
              Liked
            </Link>
            {/* The artist flow only exists in the nav once you've opted in. */}
            {profile.role === "artist" ? (
              <Link href="/studio" className="opacity-70 hover:opacity-100">
                Studio
              </Link>
            ) : null}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/account"
            className="hidden text-sm opacity-70 hover:opacity-100 sm:inline"
          >
            {profile.email}
          </Link>
          <SignOutButton />
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 py-8">{children}</main>
    </>
  );
}
