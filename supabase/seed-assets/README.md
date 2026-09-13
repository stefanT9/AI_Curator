# Ranking evaluation corpus — seed workflow

The corpus is 1000 public-domain artworks from the Art Institute of Chicago.
[`corpus.json`](corpus.json) is the source of truth; the images in this
directory and the generated half of [`../seed.sql`](../seed.sql) are both
derived from it by [`../../scripts/build-corpus.ts`](../../scripts/build-corpus.ts).

## Local development only

The corpus is for the **local development database only**. `seed.sql` writes
directly into `auth.users` / `auth.identities` and seeds three accounts that
share one weak password. It must **never** be run against a linked or
production project.

`npm run db:push`, below, is the one exception — it does not use `seed.sql`
at all.

## After a clone: fetch the images once

The images are **gitignored** — roughly 260 MB across 1000 files. A fresh clone
has an empty image directory, and `db:reset` alone would seed 1000 rows pointing
at objects that do not exist, rendering as broken thumbnails.

```bash
npm run db:seed:fetch   # one-time after a clone; re-run tops up, never restarts
```

`db:seed:fetch` needs the network but no API key. It reads the manifest and
downloads only what is missing, so re-running it is cheap and safe.

## Per reset: apply the corpus and upload the images

With the local stack running:

```bash
npm run db:reset
```

That is `supabase db reset` followed by `npm run db:seed:images`. Both halves
are required: `supabase db reset` clears Storage objects along with the
database, so the image upload is **part of the reset workflow, not one-time
setup**. If you run `npx supabase db reset` by hand, run `npm run db:seed:images`
after it, or the corpus renders as broken images.

Verify the upload:

```bash
npx supabase storage ls --experimental --local \
  ss:///artworks/00000000-0000-4000-8000-000000000001
```

The directory is named after the seeded artist's UUID, so each JPEG uploads to
exactly the `image_path` its seed row references. The whole `supabase storage`
command group is gated behind `--experimental` and refuses to run without it.

## Per reset: the vault entries

`supabase db reset` clears Supabase Vault along with everything else, so the
**four** entries planted here have to be planted again afterwards. Three are the
email drain's: without them the per-minute drain job matches no rows and
silently posts nothing — auctions still close, `email_outbox` still fills, and
no mail ever leaves. The only symptom is pending rows.

The fourth, `unsubscribe_rpc_secret`, gates `set_auction_emails_enabled`, the
write behind the unsubscribe link in every auction notification (S-05). Without
it the link renders its confirm page normally and the button fails — the
function raises `UNS00` rather than returning false, precisely so this is
distinguishable from a value that has drifted (`UNS01`).

```bash
npx supabase db reset   # or npm run db:reset

# Two DIFFERENT random values — do not reuse one for both. Generate each with:
#   openssl rand -hex 32
psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
select vault.create_secret('<the same value as EMAIL_DRAIN_TRIGGER_TOKEN>', 'email_drain_trigger_token');
select vault.create_secret('<the same value as EMAIL_DRAIN_SECRET>', 'email_drain_secret');
select vault.create_secret('http://host.docker.internal:3000/api/email/drain', 'email_drain_url');

-- S-05. A third random value, distinct from both of the above and from
-- UNSUBSCRIBE_TOKEN_SECRET, which never goes in the vault at all.
select vault.create_secret('<the same value as UNSUBSCRIBE_RPC_SECRET>', 'unsubscribe_rpc_secret');
SQL
```

**Plant these before running `npm run test:integration`, not after.** Two specs
read-or-plant the entry they need — `email-outbox.int.ts` for
`email_drain_secret` and `unsubscribe.int.ts` for `unsubscribe_rpc_secret` — so
running the lane against a freshly reset stack fills those two names with
_random_ values. The lane then passes, because it uses whatever it finds; but
the running app keeps reading `.env.local`, the two no longer agree, and the
only symptom is a drain that posts nothing and an unsubscribe button that fails.
Re-creating the entry afterwards raises `duplicate key value violates unique
constraint "secrets_name_idx"` — `vault.create_secret` does not overwrite. To
repair it, update in place instead:

```bash
DBURL=$(npx supabase status -o env | grep '^DB_URL' | cut -d= -f2- | tr -d '"')
set -a; . ./.env.local; set +a
psql "$DBURL" <<SQL
select vault.update_secret(id, '$EMAIL_DRAIN_SECRET') from vault.secrets where name = 'email_drain_secret';
select vault.update_secret(id, '$UNSUBSCRIBE_RPC_SECRET') from vault.secrets where name = 'unsubscribe_rpc_secret';
SQL
```

Substituting from `.env.local` rather than retyping is the point: a placeholder
pasted verbatim is accepted happily by `create_secret` and fails only much
later, at the one moment you are trying to verify something else.

`unsubscribe_rpc_secret` is the weaker half of the unsubscribe pair by design.
On its own it cannot name a user: the caller must _also_ present a token that
verifies against `UNSUBSCRIBE_TOKEN_SECRET`, which stays in the Node process and
is never sent to Postgres, never put in the vault, and never travels in a
header, a body or a URL. Only the signature over it travels. See
`20260913130100_add_unsubscribe_write.sql`.

The two secrets are deliberately different values.
`email_drain_trigger_token` rides in the cron job's `Authorization` header, so
`pg_net` writes it into `net.http_request_queue` — a table whose ACL grants
`PUBLIC` every privilege, and which this project cannot revoke because the
grantor is `supabase_admin` and migrations run as `postgres`. Assume anyone with
an account can read it; all it buys them is a drain that sends already-queued
mail. `email_drain_secret` is what the definer functions check before handing
back an address, and it never travels over the wire at all. See
`20260913120300_split_drain_trigger_token.sql`.

The URL is reached **from inside the Postgres container**, so `localhost` is the
container, not your machine — use `host.docker.internal` for a `next dev` /
`next start` server on the host. On a hosted project it is the deployed origin
plus `/api/email/drain`.

The app's copies are `EMAIL_DRAIN_TRIGGER_TOKEN` and `EMAIL_DRAIN_SECRET` in
`.env.local` (and in Vercel for a deployed environment). Nothing checks that any
of them agree; when the trigger token drifts the drain POST comes back 401, and
when the secret drifts the route answers 200 with zeroes while the functions
raise `EML01`. Both show up in `net._http_response`:

```sql
select status_code, created from net._http_response order by created desc limit 5;

-- The operator's "did a message get stuck" query:
select id, kind, status, attempts, last_error, created_at
  from public.email_outbox
 where status = 'pending' and created_at < now() - interval '15 minutes';
```

Both are read over a direct connection on purpose: `email_outbox` has RLS
enabled with no policies at all, and that absence is its access control.

## Changing the corpus

**Edit the manifest, never `seed.sql`.** Everything in `seed.sql` below

```sql
-- === GENERATED BY scripts/build-corpus.ts — DO NOT HAND-EDIT ===
```

is rewritten wholesale by `npm run db:seed:generate`. Everything above it is
hand-authored — the seeded identities, which encode the GoTrue requirement that
every text token column be an empty string rather than NULL — and the generator
never touches it.

## The five stages

Each stage reads and writes `corpus.json`, so a failure halfway leaves usable
progress and a later run resumes rather than restarting.

| Command                    | Needs                         | Does                                                                                                                                 |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run db:seed:fetch`    | network                       | Samples AIC, maps museum metadata onto the medium / subject / palette facets, downloads the JPEGs, pins everything in the manifest.  |
| `npm run db:seed:enrich`   | network, `OPENROUTER_API_KEY` | Adds style, mood and a description per piece via `src/lib/ai`. Resumes by default; a piece already pinned costs no model call.       |
| `npm run db:seed:coverage` | —                             | Reports how many pieces each vocabulary term can serve, and pins the untagged tail. Always exits 0: gaps are findings, not failures. |
| `npm run db:seed:generate` | —                             | Rewrites the generated region of `seed.sql` from the manifest.                                                                       |
| `npm run db:push`          | network, `.env.push.local`    | Diffs the manifest against a target project and, with `--apply`, writes the rows and objects a demo artist owns. Dry-run by default. |

Enrichment is the long pole and the only stage that needs a key.
`OPENROUTER_API_KEY` goes in `.env.local`, which the enrich scripts load; no
other stage reads it. Two more entry points exist for a long run:

```bash
npm run db:seed:enrich:resume   # the same command, named for what it does
npm run db:seed:enrich:retry    # reopen pieces pinned as failed
```

A pinned failure counts as done, which is what makes a plain re-run a true
no-op — `:retry` is the opt-in that reopens them. OpenRouter caps `:free`
models near 20 requests a minute, which is why `ENRICH_CONCURRENCY` is 2.

## Pushing the corpus to a hosted project

`npm run db:push` writes the manifest to a linked or remote Supabase project —
a second **sink** on `corpus.json`, not a second seeding mechanism. It never
touches `seed.sql`, never uses a service-role key, and signs in as a
dedicated demo artist over the publishable key, crossing the same RLS a real
artist crosses on every upload. Dry-run by default; `--apply` is the only
thing that writes.

**Prerequisite: a demo artist account**, created through the app itself, not
SQL. Sign up in the target deployment with a dedicated address, then use the
account page's "Become an artist" form (`becomeArtist`,
`src/app/actions/profile.ts`) with a display name that identifies it as the
seeded collection account. Every pushed row and object is owned by this
account, so it must never be a real artist's own profile.

**`.env.push.local`** holds the push's target and is read only by `db:push` —
never `.env.local`, and none of these are `NEXT_PUBLIC_*`, so a `.env.local`
swapped between the local and remote pairs cannot redirect a push:

```bash
PUSH_SUPABASE_URL=...              # the target project's Data API URL
PUSH_SUPABASE_PUBLISHABLE_KEY=...  # its publishable key
PUSH_ARTIST_EMAIL=...              # the demo artist's login
PUSH_ARTIST_PASSWORD=...
```

**Dry-run, then apply:**

```bash
npm run db:push              # reports rows to create/replace and objects to upload; writes nothing
npm run db:push -- --apply   # writes
```

The push is idempotent and resumable: `piece_uuid` is the row id, so
re-running after a failure only sends what is still missing, and re-running
after more enrichment replaces exactly the rows whose tags or description
changed. A dry-run immediately after an `--apply` reporting nothing to do is
the verification step — run it and confirm zero rows and zero objects.

## Licence and courtesy

Every AIC field this corpus uses is CC0 1.0. AIC's own `description` field is
CC-BY 4.0 and is deliberately **never** copied — the description on each seed
row is written by the enrichment model from the image, followed by an
attribution line naming the artist and the AIC object id.

The IIIF image server returns `403` to a request with no `User-Agent`, so
`build-corpus.ts` sends both `User-Agent` and `AIC-User-Agent`, AIC's documented
courtesy header identifying the application. See
<https://www.artic.edu/open-access/public-api>.

## Seeded logins

All three share the password `seedpassword`:

| Role           | Email                                |
| -------------- | ------------------------------------ |
| Artist         | `seed-artist@artswipe.local`         |
| Warm collector | `seed-collector-warm@artswipe.local` |
| Cold collector | `seed-collector-cold@artswipe.local` |

The warm collector carries eight likes, all inside one emergent style group —
`corpus.json`'s `like_history` names which, since the groups depend on what the
sampling and enrichment produced. The cold collector has no likes, so both the
ranked and cold-start paths are observable without a single click.
