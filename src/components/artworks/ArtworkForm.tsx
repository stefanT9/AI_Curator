"use client";

import { useActionState, useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { createArtwork, updateArtwork } from "@/app/actions/artworks";
import { Field, submitButtonClass } from "@/components/ui/Field";
import { MAX_TAGS } from "@/lib/artworks/tags";
import type { Artwork } from "@/types/domain";

/**
 * Upload and edit share every field except the image, which is set once at
 * upload time — replacing a piece's image means deleting it and uploading
 * again, which keeps the storage key stable for as long as the row lives.
 */
export function ArtworkForm({ artwork }: { artwork?: Artwork }) {
  const isEdit = Boolean(artwork);
  const [state, action, pending] = useActionState(
    isEdit ? updateArtwork : createArtwork,
    undefined,
  );
  const [preview, setPreview] = useState<string | null>(null);

  // Object URLs are leaked memory until revoked.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  const onImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  return (
    <form action={action} className="flex flex-col gap-4">
      {artwork ? (
        <input type="hidden" name="artworkId" value={artwork.id} />
      ) : null}

      {!isEdit ? (
        <div className="flex flex-col gap-1.5">
          <Field
            name="image"
            label="Image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hint="PNG, JPEG or WebP, up to 10 MB."
            errors={state?.errors?.image}
            onChange={onImageChange}
          />
          {preview ? (
            <div className="relative mt-1 aspect-4/5 w-40 overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
              {/* Local blob URL — outside next/image's remotePatterns by design. */}
              <Image
                src={preview}
                alt="Preview of the image you selected"
                fill
                unoptimized
                className="object-cover"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <Field
        name="title"
        label="Title"
        placeholder="Untitled No. 4"
        defaultValue={artwork?.title}
        errors={state?.errors?.title}
      />

      <Field
        name="description"
        label="Description"
        multiline
        placeholder="What is this piece about? Medium, size, what you were after."
        defaultValue={artwork?.description ?? undefined}
        errors={state?.errors?.description}
      />

      <Field
        name="tags"
        label="Tags"
        placeholder="abstract, oil, warm"
        hint={`Comma-separated, up to ${MAX_TAGS}. These are what collectors get matched on.`}
        defaultValue={artwork?.tags.join(", ")}
        errors={state?.errors?.tags}
      />

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={submitButtonClass}>
          {pending
            ? isEdit
              ? "Saving…"
              : "Uploading…"
            : isEdit
              ? "Save changes"
              : "Upload artwork"}
        </button>
        <Link href="/studio" className="text-sm underline opacity-70">
          Cancel
        </Link>
      </div>
    </form>
  );
}
