import Image from "next/image";
import Link from "next/link";
import { publicImageUrl } from "@/lib/artworks/images";
import { artistLabel, type Artwork, type ArtistSummary } from "@/types/domain";

type ArtCardProps = {
  /** Attribution is optional: the studio shows an artist their own work. */
  artwork: Artwork & { artist?: ArtistSummary | null };
  /** The top card of the deck and the detail hero should not lazy-load. */
  priority?: boolean;
  sizes?: string;
  showDescription?: boolean;
  /** Off inside a card that is already wrapped in a link. */
  linkArtist?: boolean;
};

/**
 * The one way an artwork is drawn. Shared by the deck, the detail page and the
 * studio grid so a change to how a piece looks lands in all three.
 *
 * No "use client": it holds no state, so it renders on the server in the studio
 * and gets bundled with the deck when the deck imports it.
 */
export function ArtCard({
  artwork,
  priority,
  sizes = "(min-width: 640px) 24rem, 100vw",
  showDescription,
  linkArtist = true,
}: ArtCardProps) {
  const artist = artwork.artist;
  return (
    <article className="overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/15 dark:bg-white/5">
      <div className="relative aspect-4/5 bg-black/5 dark:bg-white/5">
        <Image
          src={publicImageUrl(artwork.image_path)}
          alt={artwork.title}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
          draggable={false}
        />
      </div>

      <div className="flex flex-col gap-2 p-4">
        <div>
          <h2 className="leading-tight font-semibold tracking-tight">
            {artwork.title}
          </h2>
          {artist ? (
            // Nested anchors are invalid HTML, so a card inside a link renders
            // the name as plain text instead.
            linkArtist ? (
              <Link
                href={`/artist/${artist.id}`}
                className="text-sm underline underline-offset-2 opacity-70 hover:opacity-100"
              >
                {artistLabel(artist)}
              </Link>
            ) : (
              <p className="text-sm opacity-70">{artistLabel(artist)}</p>
            )
          ) : null}
        </div>

        {showDescription && artwork.description ? (
          <p className="text-sm whitespace-pre-line opacity-70">
            {artwork.description}
          </p>
        ) : null}

        {artwork.tags.length > 0 ? <TagList tags={artwork.tags} /> : null}
      </div>
    </article>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-full border border-black/10 px-2 py-0.5 text-xs opacity-70 dark:border-white/15"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
