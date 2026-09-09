import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/dal";
import { getLikedArtworks } from "@/lib/artworks/queries";
import { ArtCard } from "@/components/artworks/ArtCard";

export const metadata: Metadata = {
  title: "Liked",
};

export const dynamic = "force-dynamic";

export default async function LikedPage() {
  await requireUser();
  const artworks = await getLikedArtworks();

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Liked</h1>
      <p className="mb-6 text-sm opacity-70">
        {artworks.length === 0
          ? "Nothing yet."
          : `${artworks.length} ${artworks.length === 1 ? "piece" : "pieces"} you liked, most recent first.`}
      </p>

      {artworks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 p-8 text-center dark:border-white/20">
          <p className="mb-3 text-sm opacity-70">
            Pieces you like while swiping collect here.
          </p>
          <Link href="/discover" className="text-sm underline">
            Start swiping
          </Link>
        </div>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {artworks.map((artwork) => (
            <li key={artwork.id}>
              <Link
                href={`/artwork/${artwork.id}`}
                className="block transition-opacity hover:opacity-90"
              >
                <ArtCard
                  artwork={artwork}
                  linkArtist={false}
                  sizes="(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
