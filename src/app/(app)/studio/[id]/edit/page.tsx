import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireArtist } from "@/lib/auth/dal";
import { getArtwork } from "@/lib/artworks/queries";
import { ArtworkForm } from "@/components/artworks/ArtworkForm";

export const metadata: Metadata = {
  title: "Edit artwork",
};

export default async function EditArtworkPage({
  params,
}: PageProps<"/studio/[id]/edit">) {
  const artist = await requireArtist();

  const { id } = await params;
  const artwork = await getArtwork(id);

  // Artworks are readable by every signed-in user, so ownership has to be
  // checked here — RLS only stops the *write* from landing.
  if (!artwork || artwork.artist_id !== artist.id) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        Edit artwork
      </h1>
      <p className="mb-6 text-sm opacity-70">
        Title, description and tags. To change the image, delete the piece and
        upload it again.
      </p>

      <ArtworkForm artwork={artwork} />
    </div>
  );
}
