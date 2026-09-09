import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";

/**
 * The role router. Sign-in and the proxy both land here rather than hard-coding
 * a destination, so each account arrives in the flow that belongs to it.
 */
export default async function AppPage() {
  const profile = await requireProfile();

  redirect(profile.role === "artist" ? "/studio" : "/discover");
}
