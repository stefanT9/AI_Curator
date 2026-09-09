import type { Metadata } from "next";
import { requireArtist } from "@/lib/auth/dal";
import { ArtworkForm } from "@/components/artworks/ArtworkForm";

export const metadata: Metadata = {
  title: "Upload artwork",
};

export default async function NewArtworkPage() {
  await requireArtist();

  return (
    <div className="mx-auto w-full max-w-md">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        Upload artwork
      </h1>
      <p className="mb-6 text-sm opacity-70">
        It goes into the discover deck for every collector as soon as you save.
      </p>

      <ArtworkForm />
    </div>
  );
}
