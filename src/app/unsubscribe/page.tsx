import type { Metadata } from "next";
import Link from "next/link";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";
import { UnsubscribeForm } from "@/components/account/UnsubscribeForm";

export const metadata: Metadata = {
  title: "Auction emails",
  // Nothing here should be indexed, and a crawler following a link out of a
  // leaked mail should not put a user's token in a search result.
  robots: { index: false, follow: false },
};

/**
 * The landing page for the unsubscribe link in every auction notification.
 *
 * **This route renders and never mutates.** Gmail, Outlook and corporate
 * security gateways prefetch the URLs in a message, so a GET that turned
 * notifications off would opt people out silently — and from the outside that
 * looks exactly like the feature working correctly. The switch is flipped by
 * the form's POST, which a scanner does not submit.
 *
 * It sits **outside `(app)`** and is listed in the proxy's public paths, so a
 * signed-out recipient reaches it instead of being bounced to `/login`. Asking
 * someone to sign in before they can stop receiving mail is not an off switch.
 *
 * The failure branch is deliberately uninformative. A token that does not
 * verify — tampered, truncated, expired by a purpose bump, or arriving in an
 * environment with no signing secret — produces the same neutral page, because
 * distinguishing them would confirm whether a given token named a real user.
 */
export default async function UnsubscribePage({
  searchParams,
}: PageProps<"/unsubscribe">) {
  const { token } = await searchParams;
  const rawToken = typeof token === "string" ? token : null;
  const userId = verifyUnsubscribeToken(rawToken);

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-5 py-16">
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">
          Auction emails
        </h1>
        <p className="text-sm opacity-70">ArtSwipe</p>
      </div>

      <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
        {userId && rawToken ? (
          <>
            <p className="mb-4 text-sm">
              You currently get an email when an artwork you liked goes up for
              auction. Turn that off and we&rsquo;ll stop — you&rsquo;ll keep
              your likes, and everything else about your account stays exactly
              as it is.
            </p>
            <UnsubscribeForm token={rawToken} />
          </>
        ) : (
          <>
            <h2 className="mb-1 font-semibold tracking-tight">
              This link didn&rsquo;t work
            </h2>
            <p className="mb-4 text-sm opacity-70">
              It may have been altered on its way to you, or copied without its
              full address. You can change this setting from your account page
              instead.
            </p>
            <Link href="/account" className="text-sm underline">
              Go to your account
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
