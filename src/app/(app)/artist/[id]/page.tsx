import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth/dal";
import { getArtistProfile, getArtistArtworks } from "@/lib/artworks/queries";
import { ArtCard } from "@/components/artworks/ArtCard";
import { artistLabel } from "@/types/domain";

export async function generateMetadata({
  params,
}: PageProps<"/artist/[id]">): Promise<Metadata> {
  const { id } = await params;
  const artist = await getArtistProfile(id);

  return { title: artist ? artistLabel(artist) : "Artist" };
}

export default async function ArtistPage({
  params,
}: PageProps<"/artist/[id]">) {
  await requireUser();

  const { id } = await params;
  const artist = await getArtistProfile(id);

  // A collector's id and a nonexistent one both land here: the RLS policy only
  // exposes profiles whose role is 'artist', so this page cannot be used to
  // probe whether an arbitrary account exists.
  if (!artist) {
    notFound();
  }

  const artworks = await getArtistArtworks(artist.id);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        {artistLabel(artist)}
      </h1>
      <p className="mb-6 text-sm opacity-70">
        {artworks.length === 0
          ? "No work published yet."
          : `${artworks.length} ${artworks.length === 1 ? "piece" : "pieces"}.`}
      </p>

      {artworks.length > 0 ? (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {artworks.map((artwork) => (
            <li key={artwork.id}>
              <Link
                href={`/artwork/${artwork.id}`}
                className="block transition-opacity hover:opacity-90"
              >
                <ArtCard
                  artwork={artwork}
                  sizes="(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
