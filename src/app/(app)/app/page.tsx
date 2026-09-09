import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";

export const metadata: Metadata = {
  title: "Discover",
};

export default async function AppPage() {
  const user = await requireUser();

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        You&rsquo;re signed in
      </h1>
      <p className="text-sm opacity-70">
        Signed in as {user.email}. The swipe feed lands here next — like or skip
        pieces and ArtSwipe starts learning what you&rsquo;re drawn to.
      </p>
    </div>
  );
}
