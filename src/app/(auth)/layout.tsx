import Link from "next/link";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-8 block text-center text-lg font-semibold tracking-tight"
        >
          ArtSwipe
        </Link>
        <div className="rounded-2xl border border-black/10 bg-black/[0.02] p-6 dark:border-white/15 dark:bg-white/[0.03]">
          {children}
        </div>
      </div>
    </main>
  );
}
