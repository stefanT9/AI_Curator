"use server";

import * as z from "zod";
import { requireArtist } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";
import { enrichFromImage, type EnrichmentFailure } from "@/lib/ai";

/**
 * The enrichment boundary for the browser.
 *
 * Unlike `createArtwork` this is a plain async function rather than a
 * `useActionState` reducer, because the form calls it imperatively when an
 * image is chosen, not on submit.
 */

export type SuggestionState =
  | { ok: true; description: string; tags: string[] }
  | { ok: false; message: string };

/**
 * The downscaled payload is ~100 KB, so this ceiling is not about normal use —
 * it stops a hand-crafted request from forwarding a full-resolution image to
 * the model on our key.
 */
const MAX_DATA_URL_BYTES = 1_500_000;

const DataUrlSchema = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/, {
    error: "That image could not be read.",
  })
  .refine((value) => value.length <= MAX_DATA_URL_BYTES, {
    error: "That image is too large to analyse.",
  });

/** Typed failures become copy an artist can act on. */
const MESSAGES: Record<EnrichmentFailure, string> = {
  unconfigured:
    "Suggestions are unavailable right now. Fill the fields in yourself.",
  timeout:
    "The suggestion took too long. Try again, or fill the fields in yourself.",
  rate_limited: "Too many suggestions just now. Wait a moment and try again.",
  unavailable:
    "Suggestions are unavailable right now. Fill the fields in yourself.",
  invalid_response: "The suggestion came back unusable. Try again.",
};

export async function suggestArtworkFields(
  dataUrl: string,
): Promise<SuggestionState> {
  await requireArtist();

  const validated = DataUrlSchema.safeParse(dataUrl);

  if (!validated.success) {
    return { ok: false, message: validated.error.issues[0].message };
  }

  // Claim a quota slot before spending anything. This is a "use server" export,
  // so it is a POST endpoint any authenticated artist can call directly — and
  // becoming an artist is a one-click self-serve opt-in. Without this, one
  // account looping the endpoint drains the shared OpenRouter key for everyone.
  //
  // The check and the insert are one function call so two concurrent requests
  // cannot both read a count under the cap and then both proceed.
  const supabase = await createClient();
  const { data: claimed, error: quotaError } = await supabase.rpc(
    "claim_enrichment_slot",
  );

  if (quotaError) {
    return { ok: false, message: MESSAGES.unavailable };
  }

  if (!claimed) {
    return {
      ok: false,
      message:
        "You have used your suggestions for now. Fill the fields in yourself, or try again later.",
    };
  }

  const result = await enrichFromImage(validated.data);

  if (!result.ok) {
    return { ok: false, message: MESSAGES[result.reason] };
  }

  return {
    ok: true,
    description: result.data.description,
    tags: result.data.tags,
  };
}
