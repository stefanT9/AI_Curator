import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/dal";
import { getSwipeDeck } from "@/lib/artworks/queries";
import { SwipeDeck } from "@/components/artworks/SwipeDeck";

export const metadata: Metadata = {
  title: "Discover",
};

// The deck depends on what this user has already rated, so it must not be
// cached across requests.
export const dynamic = "force-dynamic";

export default async function DiscoverPage() {
  await requireUser();
  const deck = await getSwipeDeck();

  return (
    <div className="mx-auto w-full max-w-sm">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Discover</h1>
      <p className="mb-6 text-sm opacity-70">
        Like what you&rsquo;re drawn to and skip what you aren&rsquo;t —
        ArtSwipe learns from both.
      </p>

      <SwipeDeck deck={deck} />
    </div>
  );
}
