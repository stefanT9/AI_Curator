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
 * A bid is bounded exactly like a starting price -- same minor units, same
 * floor and ceiling, same `bids_amount_positive` check mirroring them in the
 * database -- so it reuses `parsePriceToCents` rather than restating bounds
 * that could drift from `StartingPriceSchema`'s.
 */
const BidAmountSchema = z
  .string()
  .transform((value) => parsePriceToCents(value))
  .refine((value): value is number => value !== null, {
    error: "Enter a valid bid amount.",
  });

const PlaceBidSchema = z.object({
  amount: BidAmountSchema,
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

export type BidFormState =
  | {
      errors?: {
        amount?: string[];
      };
      message?: string;
    }
  | undefined;

/**
 * `place_bid` raises a distinguishable Postgres errcode for each refusal (see
 * `supabase/migrations/20260911190000_add_bids.sql`). The split matters: BID03
 * and BID04 are things the collector can fix by typing a different number, so
 * they land on the field; BID00-BID02 are about the auction or the session, so
 * they are form-level.
 *
 * BID01 stays vague on purpose -- the function folds missing, cancelled, and
 * ended auctions into one code so a non-participant learns nothing about
 * someone else's auction, and this message must not undo that.
 */
const BID_ERROR_STATES: Record<string, NonNullable<BidFormState>> = {
  BID00: { message: "Sign in and try again." },
  BID01: { message: "This auction is no longer open for bids." },
  BID02: { message: "You cannot bid on your own listing." },
  BID03: {
    errors: { amount: ["Your bid must be at least the starting price."] },
  },
  BID04: {
    errors: { amount: ["Your bid must be higher than your current bid."] },
  },
};

/**
 * The only write path to `bids` from the app. No redirect: the collector stays
 * on the detail page and the revalidation is what shows them their new
 * standing bid.
 */
export async function placeBid(
  _state: BidFormState,
  formData: FormData,
): Promise<BidFormState> {
  await requireUser();

  const auctionId = asString(formData.get("auctionId"));

  if (!z.uuid().safeParse(auctionId).success) {
    return { message: "Unknown auction." };
  }

  const validatedFields = PlaceBidSchema.safeParse({
    amount: asString(formData.get("amount")),
  });

  if (!validatedFields.success) {
    return { errors: z.flattenError(validatedFields.error).fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("place_bid", {
    p_auction_id: auctionId,
    p_amount_cents: validatedFields.data.amount,
  });

  if (error) {
    return (
      BID_ERROR_STATES[error.code ?? ""] ?? {
        message: "Could not place your bid. Try again.",
      }
    );
  }

  revalidatePath(`/auctions/${auctionId}`);
  revalidatePath("/auctions");
  return undefined;
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
