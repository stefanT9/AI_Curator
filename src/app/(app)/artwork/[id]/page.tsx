import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/dal";
import { getArtwork } from "@/lib/artworks/queries";
import { ArtCard } from "@/components/artworks/ArtCard";

// `getArtwork` is React-cached, so this and the page below share one query.
export async function generateMetadata({
  params,
}: PageProps<"/artwork/[id]">): Promise<Metadata> {
  const { id } = await params;
  const artwork = await getArtwork(id);

  return { title: artwork?.title ?? "Artwork" };
}

export default async function ArtworkPage({
  params,
}: PageProps<"/artwork/[id]">) {
  await requireUser();

  const { id } = await params;
  const artwork = await getArtwork(id);

  // RLS returns nothing rather than erroring when a row is out of reach, so a
  // missing row and a forbidden one are the same 404 here — which is what we
  // want: it tells an attacker nothing.
  if (!artwork) {
    notFound();
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <Link
        href="/discover"
        className="mb-4 inline-block text-sm underline opacity-70"
      >
        ← Back to discover
      </Link>

      <ArtCard artwork={artwork} priority showDescription />

      <p className="mt-4 text-xs opacity-50">
        Added{" "}
        {new Date(artwork.created_at).toLocaleDateString(undefined, {
          year: "numeric",
          month: "long",
          day: "numeric",
        })}
      </p>
    </div>
  );
}
