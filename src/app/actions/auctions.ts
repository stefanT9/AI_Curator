"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import { requireArtist, requireUser } from "@/lib/auth/dal";
import { createClient } from "@/utils/supabase/server";
import { AUCTION_DURATION_HOURS } from "@/lib/auctions/config";
import { parsePriceToCents } from "@/lib/auctions/price";

export type AuctionFormState =
  | {
      errors?: {
        startingPrice?: string[];
        duration?: string[];
      };
      message?: string;
    }
  | undefined;

const asString = (value: FormDataEntryValue | null) =>
  typeof value === "string" ? value : "";

const StartingPriceSchema = z
  .string()
  .transform((value) => parsePriceToCents(value))
  .refine((value): value is number => value !== null, {
    error: "Enter a valid starting price.",
  });

const DurationSchema = z
  .string()
  .transform((value) => Number(value))
  .refine(
    (value) => (AUCTION_DURATION_HOURS as readonly number[]).includes(value),
    { error: "Choose one of the available durations." },
  );

const CreateAuctionSchema = z.object({
  startingPrice: StartingPriceSchema,
  duration: DurationSchema,
});

const CancelAuctionSchema = z.object({
  auctionId: z.uuid(),
});

/**
 * `create_auction` raises a distinguishable Postgres errcode for each refusal
 * (see `supabase/migrations/20260911120000_add_auctions.sql`), surfaced here
 * as `error.code`. "Already live" in particular is a user-facing message, not
 * a crash: the artist did nothing wrong, the piece is just already listed.
 * AUC00/AUC01/AUC03 are defence in depth — `requireArtist` and the ownership
 * check already keep a real form from reaching them.
 */
const RPC_ERROR_STATES: Record<string, NonNullable<AuctionFormState>> = {
  AUC00: { message: "Sign in and try again." },
  AUC01: { message: "Only artists can list an auction." },
  AUC02: {
    errors: { duration: ["Choose one of the available durations."] },
  },
  AUC03: { message: "You can only list your own artwork." },
  AUC04: { message: "This piece already has a live auction." },
};

export async function createAuction(
  _state: AuctionFormState,
  formData: FormData,
): Promise<AuctionFormState> {
  await requireArtist();

  const artworkId = asString(formData.get("artworkId"));

  if (!z.uuid().safeParse(artworkId).success) {
    return { message: "Unknown artwork." };
  }

  const validatedFields = CreateAuctionSchema.safeParse({
    startingPrice: asString(formData.get("startingPrice")),
    duration: asString(formData.get("duration")),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const { startingPrice, duration } = validatedFields.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_auction", {
    p_artwork_id: artworkId,
    p_duration_hours: duration,
    p_starting_price_cents: startingPrice,
  });

  if (error) {
    return (
      RPC_ERROR_STATES[error.code ?? ""] ?? {
        message: "Could not list this piece for auction. Try again.",
      }
    );
  }

  revalidatePath("/studio");
  revalidatePath("/auctions");
  redirect("/auctions");
}

export async function cancelAuction(formData: FormData): Promise<void> {
  await requireUser();

  const validated = CancelAuctionSchema.safeParse({
    auctionId: asString(formData.get("auctionId")),
  });

  if (!validated.success) {
    return;
  }

  const supabase = await createClient();

  // A `false` return means the auction was already cancelled, already ended,
  // or not the caller's — none of which is an error condition to throw on.
  await supabase.rpc("cancel_auction", {
    p_auction_id: validated.data.auctionId,
  });

  revalidatePath("/studio");
  revalidatePath("/auctions");
}
