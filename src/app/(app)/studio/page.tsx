import type { Metadata } from "next";
import Link from "next/link";
import { requireArtist } from "@/lib/auth/dal";
import { getArtistArtworks } from "@/lib/artworks/queries";
import { ArtCard } from "@/components/artworks/ArtCard";
import { DeleteArtworkButton } from "@/components/artworks/DeleteArtworkButton";
import { submitButtonClass } from "@/components/ui/Field";

export const metadata: Metadata = {
  title: "Studio",
};

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const artist = await requireArtist();
  const artworks = await getArtistArtworks(artist.id);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Studio</h1>
          <p className="text-sm opacity-70">
            {artworks.length === 0
              ? "Upload your first piece to put it in front of collectors."
              : `${artworks.length} ${artworks.length === 1 ? "piece" : "pieces"} in your catalog.`}
          </p>
        </div>
        <Link href="/studio/new" className={submitButtonClass}>
          Upload artwork
        </Link>
      </div>

      {artworks.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-black/15 p-8 text-center dark:border-white/20">
          <p className="text-sm opacity-70">
            Nothing uploaded yet. Add a title, a description and a few tags —
            the tags are what collectors get matched on.
          </p>
        </div>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {artworks.map((artwork) => (
            <li key={artwork.id} className="flex flex-col gap-2">
              <ArtCard
                artwork={artwork}
                sizes="(min-width: 1024px) 20rem, (min-width: 640px) 45vw, 100vw"
              />
              <div className="flex items-center gap-4 px-1">
                <Link
                  href={`/studio/${artwork.id}/edit`}
                  className="text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
                >
                  Edit
                </Link>
                <DeleteArtworkButton artworkId={artwork.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
