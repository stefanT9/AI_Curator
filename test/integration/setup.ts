/**
 * The rails every integration spec runs on.
 *
 * This lane creates users and uploads objects. `.env.local` in this repo
 * points at the linked project, so a lane that picked it up would sign real
 * accounts up on production. `requireLocalStack` makes that impossible: the
 * URL's hostname must be loopback or the suite throws before any client is
 * constructed.
 *
 * The health check exists so a stopped stack reports one clear instruction
 * instead of thirty connection errors. Both throw rather than skip —
 * following the smoke lane's stance, because a skipped suite reports green
 * and a green suite that ran nothing is worse than a red one.
 */

const SETUP_COMMANDS = `
  npx supabase start
  npx supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \\
    --override-name auth.anon_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY > .env.test.local
`;

const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

export type LocalStack = {
  url: string;
  anonKey: string;
};

/**
 * Read and vet the lane's credentials. Throws unless the URL is a local stack.
 */
export const requireLocalStack = (): LocalStack => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "The integration lane needs NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY from a local stack. Generate " +
        `.env.test.local yourself:\n${SETUP_COMMANDS}`,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SUPABASE_URL is not a URL: ${url}. The integration lane ` +
        `only runs against a local stack:\n${SETUP_COMMANDS}`,
    );
  }

  if (!LOCAL_HOSTNAMES.includes(hostname)) {
    throw new Error(
      `Refusing to run the integration lane against "${hostname}". This lane ` +
        "signs up users and uploads objects, so it only runs against a local " +
        `stack (127.0.0.1 or localhost). Regenerate .env.test.local:\n${SETUP_COMMANDS}`,
    );
  }

  return { url, anonKey };
};

/**
 * How long to wait for the health probe before calling the stack down.
 *
 * Bounded deliberately. A wedged stack still has its ports bound, so the TCP
 * connect succeeds and a plain `fetch` hangs until Vitest's hook timeout fires
 * — which reports "Hook timed out" and says nothing about Supabase. Failing
 * fast here is what turns that into the instruction the developer needs.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Confirm the stack is actually up. `/auth/v1/health` needs no key and is the
 * cheapest signal that `supabase start` has finished booting.
 */
export const requireRunningStack = async (url: string): Promise<void> => {
  let response: Response;

  try {
    response = await fetch(`${url}/auth/v1/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";

    throw new Error(
      `Could not reach the local Supabase stack at ${url}` +
        (timedOut
          ? ` — /auth/v1/health did not answer within ${HEALTH_TIMEOUT_MS}ms, ` +
            "so the stack is up but wedged. Restart it"
          : ". Start it") +
        ` and regenerate the lane's env file yourself:\n${SETUP_COMMANDS}`,
      { cause },
    );
  }

  if (!response.ok) {
    throw new Error(
      `The local Supabase stack at ${url} answered ${response.status} on ` +
        `/auth/v1/health. Restart it and regenerate the env file:\n${SETUP_COMMANDS}`,
    );
  }
};

/**
 * Read and vet a direct postgres connection string for the lane.
 *
 * `close_due_auctions` is granted to nobody — that omission is the access
 * control the migration deliberately relies on, so no Supabase client can
 * reach it and the close can only be driven from a superuser connection.
 * `supabase status -o env` already emits one as `DB_URL`, so this is an
 * accessor over the lane's existing env file, not a new workflow.
 *
 * The loopback guard is the *same* one `requireLocalStack` applies, not a
 * weaker one. This connection bypasses RLS entirely and owns every function
 * in the schema; pointing it at anything but a local stack is strictly more
 * dangerous than pointing an anon client there, so it gets at least the same
 * check.
 */
export const requireLocalDatabaseUrl = (): string => {
  const url = process.env.DB_URL;

  if (!url) {
    throw new Error(
      "The close spec needs DB_URL — a direct postgres connection to the " +
        "local stack — because `close_due_auctions` is granted to no role a " +
        "Supabase client can authenticate as. Regenerate .env.test.local " +
        `yourself:\n${SETUP_COMMANDS}`,
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(
      `DB_URL is not a URL: ${url}. The integration lane only runs against a ` +
        `local stack:\n${SETUP_COMMANDS}`,
    );
  }

  if (!LOCAL_HOSTNAMES.includes(hostname)) {
    throw new Error(
      `Refusing to open a direct postgres connection to "${hostname}". This ` +
        "connection bypasses RLS and can close live auctions, so it only " +
        `runs against a local stack (127.0.0.1 or localhost):\n${SETUP_COMMANDS}`,
    );
  }

  return url;
};

/** Both rails, in the order a `beforeAll` wants them. */
export const requireLocalRunningStack = async (): Promise<LocalStack> => {
  const stack = requireLocalStack();
  await requireRunningStack(stack.url);
  return stack;
};
