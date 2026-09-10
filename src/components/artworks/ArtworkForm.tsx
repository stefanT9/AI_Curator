"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { createArtwork, updateArtwork } from "@/app/actions/artworks";
import { suggestArtworkFields } from "@/app/actions/enrichment";
import { Field, submitButtonClass } from "@/components/ui/Field";
import { MAX_TAGS } from "@/lib/artworks/tags";
import { downscaleToDataUrl } from "@/lib/artworks/downscale";
import {
  ArtworkUploadError,
  removeArtworkImage,
  uploadArtworkImage,
} from "@/lib/artworks/upload";
import type { Artwork } from "@/types/domain";

/**
 * Per-field progress. Deliberately text, not a spinner overlay: it has to sit
 * beside the label without making the field look disabled, because the field
 * stays editable while a suggestion is in flight.
 */
function FieldProgress() {
  return (
    <span className="text-xs opacity-60" role="status">
      Suggesting…
    </span>
  );
}

/**
 * Upload and edit share every field except the image, which is set once at
 * upload time — replacing a piece's image means deleting it and uploading
 * again, which keeps the storage key stable for as long as the row lives.
 *
 * On create, the image goes to Storage from here rather than through the
 * Server Action, and only its key is submitted — see `@/lib/artworks/upload`.
 */
export function ArtworkForm({ artwork }: { artwork?: Artwork }) {
  const isEdit = Boolean(artwork);
  const [state, action, pending] = useActionState(
    isEdit ? updateArtwork : createArtwork,
    undefined,
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Controlled for the component's whole lifetime, seeded from the artwork on
  // the edit form. Starting them undefined and letting a suggestion define them
  // would flip these fields from uncontrolled to controlled mid-life, which
  // React warns about and which drops the value on the switch.
  const [description, setDescription] = useState(artwork?.description ?? "");
  const [tags, setTags] = useState(artwork?.tags.join(", ") ?? "");
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // The key of an object that is in the bucket but has no row yet. Held in a
  // ref rather than state because writing it must not re-render mid-submit.
  const orphanRef = useRef<string | null>(null);

  // Identifies the image a suggestion belongs to. If the artist swaps the image
  // mid-request, the in-flight result is for the wrong picture and is dropped.
  const requestRef = useRef(0);

  // Object URLs are leaked memory until revoked.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  // A rejected publish leaves the already-uploaded object unreferenced. Clear
  // it so a retry cannot accumulate one orphan per attempt. On success the
  // action redirects and this component unmounts, so the ref is never read.
  useEffect(() => {
    const orphan = orphanRef.current;

    // `keepImage` means the failure said nothing about whether the upload
    // landed — deleting on that would destroy a good object and force the
    // artist to re-send the whole file.
    if (orphan && !state?.keepImage && (state?.errors || state?.message)) {
      orphanRef.current = null;
      void removeArtworkImage(orphan);
    }
  }, [state]);

  /**
   * Choosing an image is what triggers enrichment — the artist never asks for
   * it. The request is fire-and-forget: nothing here blocks typing or submit,
   * and a failure only sets a message next to the fields.
   */
  const onImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    setUploadError(null);
    setSuggestError(null);
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return file ? URL.createObjectURL(file) : null;
    });

    // Invalidate any in-flight suggestion; it describes the previous image.
    const requestId = ++requestRef.current;

    if (!file) {
      setSuggesting(false);
      return;
    }

    void suggest(file, requestId);
  };

  const suggest = async (file: File, requestId: number) => {
    setSuggesting(true);

    try {
      const dataUrl = await downscaleToDataUrl(file);
      const result = await suggestArtworkFields(dataUrl);

      // The artist changed the image while this was in flight.
      if (requestRef.current !== requestId) return;

      if (!result.ok) {
        setSuggestError(result.message);
        return;
      }

      // Fill only what is empty. A suggestion never displaces the artist's own
      // words — that is FR-002, and it is why these read the live values.
      setDescription((current) =>
        current.trim() ? current : result.description,
      );
      setTags((current) => (current.trim() ? current : result.tags.join(", ")));
    } catch {
      if (requestRef.current !== requestId) return;
      setSuggestError("Could not read that image for suggestions.");
    } finally {
      if (requestRef.current === requestId) setSuggesting(false);
    }
  };

  /**
   * Swap the selected file for its object key before the action is dispatched.
   * The `delete` is what keeps the bytes off the wire — Server Action bodies
   * are capped at 1 MB, well under a real photograph.
   *
   * Every `action` call is wrapped in `startTransition`. React puts a form
   * action inside a transition automatically, but that scope ends at the first
   * `await` — dispatching after the upload without re-entering one leaves
   * `pending` stuck false, so the button never shows its submitting state.
   */
  const submit = async (formData: FormData) => {
    if (isEdit) {
      startTransition(() => action(formData));
      return;
    }

    const file = formData.get("image");
    setUploadError(null);

    if (!(file instanceof File)) {
      setUploadError("Choose an image to upload.");
      return;
    }

    setUploading(true);

    try {
      const imagePath = await uploadArtworkImage(file);
      orphanRef.current = imagePath;
      formData.delete("image");
      formData.set("image", imagePath);
    } catch (error) {
      setUploadError(
        error instanceof ArtworkUploadError
          ? error.message
          : "Could not upload the image. Try again.",
      );
      return;
    } finally {
      setUploading(false);
    }

    startTransition(() => action(formData));
  };

  const busy = pending || uploading;
  const imageErrors = uploadError ? [uploadError] : state?.errors?.image;

  return (
    <form action={submit} className="flex flex-col gap-4">
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
            errors={imageErrors}
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
        errors={state?.errors?.description}
        value={description}
        onValueChange={setDescription}
        action={suggesting ? <FieldProgress /> : null}
      />

      <Field
        name="tags"
        label="Tags"
        placeholder="abstract, oil, warm"
        hint={`Comma-separated, up to ${MAX_TAGS}. These are what collectors get matched on.`}
        errors={state?.errors?.tags}
        value={tags}
        onValueChange={setTags}
        action={suggesting ? <FieldProgress /> : null}
      />

      {suggestError ? (
        <p className="text-xs opacity-70">{suggestError}</p>
      ) : null}

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={submitButtonClass}>
          {uploading
            ? "Uploading image…"
            : pending
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
