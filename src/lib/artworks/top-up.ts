import "server-only";

import { MIN_GENERATED_TAGS, enrichFromImage } from "@/lib/ai";
import { publicImageUrl } from "./images";
import { MAX_TAGS } from "./tags";

/**
 * FR-003's backstop: no piece is published under-tagged.
 *
 * The upload form normally fills tags from a suggestion the moment an image is
 * chosen, so this is the path for a piece that got past that — the artist
 * cleared the tags, or enrichment was unavailable at the time. Skipping it
 * whenever the artist tagged adequately is what keeps AI operations per upload
 * bounded and known.
 *
 * Lives here rather than beside `createArtwork` because every export of a
 * `"use server"` module becomes a callable endpoint, and this has no business
 * being one.
 *
 * Never throws and never blocks publishing: a failure returns the artist's own
 * tags untouched. The image is already in Storage by the time this runs, and
 * the bucket is public, so the model is handed a URL rather than bytes.
 */
export const topUpTags = async (
  tags: string[],
  imagePath: string,
): Promise<string[]> => {
  if (tags.length >= MIN_GENERATED_TAGS) return tags;

  try {
    const enrichment = await enrichFromImage(publicImageUrl(imagePath));

    if (!enrichment.ok) return tags;

    // Artist tags lead, so if the cap ever truncates it drops generated tags
    // first — the artist's own words are never the ones lost.
    return Array.from(new Set([...tags, ...enrichment.data.tags])).slice(
      0,
      MAX_TAGS,
    );
  } catch {
    return tags;
  }
};
