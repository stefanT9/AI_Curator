import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { getAuctionEmailsEnabled } from "@/lib/notifications/preferences";
import { BecomeArtistForm } from "@/components/account/BecomeArtistForm";
import { DisplayNameForm } from "@/components/account/DisplayNameForm";
import { NotificationPreferenceForm } from "@/components/account/NotificationPreferenceForm";

export const metadata: Metadata = {
  title: "Account",
};

export default async function AccountPage() {
  const profile = await requireProfile();
  const isArtist = profile.role === "artist";
  // Absent preference row means enabled — see the helper's note.
  const auctionEmailsEnabled = await getAuctionEmailsEnabled(profile.id);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm opacity-70">{profile.email}</p>
      </div>

      <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-1 font-semibold tracking-tight">
          {isArtist ? "Artist account" : "Collector account"}
        </h2>

        {isArtist ? (
          <>
            <p className="mb-4 text-sm opacity-70">
              You can upload work and manage your catalog in the studio. Your
              artist profile is public to everyone on ArtSwipe — your email is
              not.
            </p>
            <DisplayNameForm displayName={profile.displayName} />
            <div className="mt-5 flex items-center gap-4 border-t border-black/10 pt-4 text-sm dark:border-white/15">
              <Link href="/studio" className="underline">
                Go to studio
              </Link>
              <Link
                href={`/artist/${profile.id}`}
                className="underline opacity-70"
              >
                View public profile
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="mb-4 text-sm opacity-70">
              You&rsquo;re here to discover art. If you make it too, switch on
              an artist account to upload your own work with descriptions and
              tags — you keep everything you&rsquo;ve liked.
            </p>
            <BecomeArtistForm />
          </>
        )}
      </section>

      {/*
        Shown to everyone. Artists are collectors too — they swipe and like
        like anyone else, so an artist account needs this switch as much as a
        collector account does.
      */}
      <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="mb-1 font-semibold tracking-tight">Notifications</h2>
        <p className="mb-4 text-sm opacity-70">
          When an artwork you liked goes up for auction, we can email you so you
          have a chance to bid. Liking a piece isn&rsquo;t consent to be emailed
          — turn this off any time and it stays off.
        </p>
        <NotificationPreferenceForm enabled={auctionEmailsEnabled} />
      </section>
    </div>
  );
}
