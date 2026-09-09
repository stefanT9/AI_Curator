/**
 * Tag limits, stated once.
 *
 * These mirror the `artworks_tags_length` check constraint and the per-tag
 * length check in the artworks table. The database is the real gate — these
 * exist so the form and the Zod schema promise exactly what the insert will
 * accept, rather than discovering the mismatch at write time.
 *
 * Deliberately free of "server-only": the upload form reads MAX_TAGS to build
 * its hint text.
 */

/** Matches `check (cardinality(tags) <= 20)`. */
export const MAX_TAGS = 20;

/** Matches `char_length(tag) <= 30` as enforced per element in the schema. */
export const MAX_TAG_LENGTH = 30;
