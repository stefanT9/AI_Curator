# Review fixes — operator steps

The implementation review's code fixes are applied and the default gate is green (338 tests). These
are the parts that need a running stack or a deployment, and cannot be closed from a session.

## 1. Reset and re-run the integration lane — closes Progress 2.5 and 2.12

The local stack is behind: `schema_migrations` tops out at `20260913120100`, so
`20260913120200` (the attempt ceiling) and everything this review added have never been applied
there. That gap is what hid F3.

```bash
npx supabase db reset      # or npm run db:reset
```

Then plant **three** vault entries — two of them now, and they must be different values:

```bash
psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" <<'SQL'
select vault.create_secret('<EMAIL_DRAIN_TRIGGER_TOKEN>', 'email_drain_trigger_token');
select vault.create_secret('<EMAIL_DRAIN_SECRET>',        'email_drain_secret');
select vault.create_secret('http://host.docker.internal:3000/api/email/drain', 'email_drain_url');
SQL
```

Then:

```bash
npm run db:types:local     # `deferred` changes no signature, but the reset regenerates cleanly
npm run test:integration
```

Expect the rewritten ceiling spec plus three new ones (deferred, unknown status, replay guard) to
pass. If the ceiling spec fails, the reset did not take.

## 2. Set `EMAIL_DRAIN_TRIGGER_TOKEN` wherever `EMAIL_DRAIN_SECRET` is set

`.env.local` and Vercel both. Two different random values — `openssl rand -hex 32` twice. Leaving
the trigger token unset makes the route answer 503 and the drain inert; setting it to the *same*
value as the secret restores the exact disclosure F1 closed.

## 3. Check the linked project's `net` ACL

F1 was verified against the local stack. Production may differ, and it is worth knowing which:

```sql
select nspacl from pg_namespace where nspname = 'net';
select relname, relacl from pg_class
 where relnamespace = 'net'::regnamespace and relkind = 'r';
```

`=U/supabase_admin` on the schema or `=arwdDxtm/supabase_admin` on the tables means `PUBLIC` can
read the request queue there too. The split in `20260913120300` makes that survivable either way —
this is to know, not to fix, since no migration here can revoke it.

## 4. Re-run the smoke lane

`npm run test:smoke` was not re-run during the review (it sends real mail). The template and drain
changes did not touch composition, but the batch size and the summary shape both moved.

## 5. Prove the drain end to end again

Close an auction locally with the app running and confirm four `email_sends` rows, then check
`net._http_response` shows 200s rather than the "Couldn't connect to server" rows currently there
(no app was running during the review).
