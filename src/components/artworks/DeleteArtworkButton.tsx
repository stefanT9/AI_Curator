"use client";

import { deleteArtwork } from "@/app/actions/artworks";

/**
 * Client-side only for the confirm prompt — the deletion itself is the server
 * action, which re-checks ownership.
 */
export function DeleteArtworkButton({ artworkId }: { artworkId: string }) {
  return (
    <form
      action={deleteArtwork}
      onSubmit={(event) => {
        if (!confirm("Delete this artwork? This cannot be undone.")) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="artworkId" value={artworkId} />
      <button
        type="submit"
        className="text-xs text-red-600 underline underline-offset-2 hover:opacity-80 dark:text-red-400"
      >
        Delete
      </button>
    </form>
  );
}
