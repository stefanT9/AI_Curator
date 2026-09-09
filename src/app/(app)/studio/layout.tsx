import { requireArtist } from "@/lib/auth/dal";

/**
 * The artist flow's gate. Everything under /studio is behind this one check, so
 * no individual studio page has to remember to make it — a collector who types
 * the URL lands on the opt-in page instead.
 */
export default async function StudioLayout({
  children,
}: LayoutProps<"/studio">) {
  await requireArtist();

  return children;
}
