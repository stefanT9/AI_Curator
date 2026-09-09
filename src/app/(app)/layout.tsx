import Link from "next/link";
import { requireUser } from "@/lib/auth/dal";
import { SignOutButton } from "@/components/auth/SignOutButton";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // The proxy already redirected signed-out visitors, but that check is
  // optimistic. This is the one that actually guards the segment.
  const user = await requireUser();

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b border-black/10 px-4 py-3 dark:border-white/15">
        <Link href="/app" className="font-semibold tracking-tight">
          ArtSwipe
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm opacity-70 sm:inline">
            {user.email}
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex flex-1 flex-col px-4 py-8">{children}</main>
    </>
  );
}
