import { logout } from "@/app/actions/auth";

export function SignOutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="rounded-lg border border-black/15 px-3 py-1.5 text-sm transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      >
        Sign out
      </button>
    </form>
  );
}
